import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { accountDeviceDescriptorSchema, type AccountDeviceDescriptor } from '@remote-session-plugin/protocol'
import { z } from 'zod'

export class ApiError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const secret = (): string => randomBytes(32).toString('base64url')
export const equal = (left: string, right: string): boolean => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)))
const tokenSchema = z.object({
  kind: z.enum(['access', 'refresh']), deviceId: z.string(), expires: z.number(), used: z.boolean(),
  recovery: z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), accessExpires: z.number().int().positive() }).optional(),
})
const savedDeviceSchema = z.object({
  descriptor: accountDeviceDescriptorSchema, revoked: z.boolean(), lastSeenAt: z.number(),
  pairedDeviceId: z.string().optional(),
})
const stateSchema = z.object({ version: z.literal(1), account: z.string(), salt: z.string(), verifier: z.string(), devices: z.record(z.string(), savedDeviceSchema), tokens: z.record(z.string(), tokenSchema) })
type SavedDevice = z.infer<typeof savedDeviceSchema>
type SavedToken = z.infer<typeof tokenSchema>

// Domain-separated HMACs keyed by the presented bearer, NOT its stored digest.
// The nonce alone cannot recover credentials from a copy of state.json.
function successor(token: string, nonce: string, deviceId: string) {
  const derive = (kind: string) => createHmac('sha256', token)
    .update(JSON.stringify(['ds-harness-remote/refresh/v1', deviceId, nonce, kind])).digest('base64url')
  return { accessToken: derive('access'), refreshToken: derive('refresh') }
}

/** Single-process store. Only token digests and public identities reach disk. */
export class Store {
  private state: z.infer<typeof stateSchema>
  onInvalidate: (id: string) => void = () => {}
  constructor(private readonly file: string, readonly account: string, password: string) {
    const previous = existsSync(file) ? stateSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : undefined
    const salt = previous?.salt ?? secret()
    const verifier = scryptSync(password, salt, 32).toString('hex')
    this.state = previous ?? { version: 1, account, salt, verifier, devices: {}, tokens: {} }
    if (this.state.account !== account) this.state.devices = {}
    if (this.state.account !== account || !equal(this.state.verifier, verifier)) this.state.tokens = {}
    Object.assign(this.state, { account, verifier })
    this.save()
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
  get(id: string): SavedDevice {
    const d = Object.hasOwn(this.state.devices, id) ? this.state.devices[id] : undefined
    if (!d) throw new ApiError('DEVICE_NOT_FOUND', 404)
    if (d.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    return d
  }
  list(): SavedDevice[] { return Object.values(this.state.devices).filter(d => !d.revoked) }
  /** Presentation groups never replace either role's identity or authorization. */
  deviceGroup(id: string): SavedDevice[] {
    const device = this.get(id)
    const paired = device.pairedDeviceId === undefined ? undefined : this.state.devices[device.pairedDeviceId]
    if (!paired || paired.revoked || paired.pairedDeviceId !== id
      || paired.descriptor.role === device.descriptor.role || paired.descriptor.platform !== device.descriptor.platform) return [device]
    return device.descriptor.role === 'host' ? [device, paired] : [paired, device]
  }
  private checkPair(source: SavedDevice, target: AccountDeviceDescriptor, old?: SavedDevice): void {
    if (source.descriptor.deviceId === target.deviceId || source.descriptor.role === target.role
      || source.descriptor.platform !== target.platform) throw new ApiError('INVALID_MESSAGE', 409)
    for (const [device, counterpart] of [[source, target.deviceId], [old, source.descriptor.deviceId]] as const) {
      if (device?.pairedDeviceId && device.pairedDeviceId !== counterpart
        && this.state.devices[device.pairedDeviceId] && !this.state.devices[device.pairedDeviceId]!.revoked) throw new ApiError('DEVICE_GROUP_CONFLICT', 409)
    }
  }
  linkRoles(sourceId: string, targetId: string): void {
    const source = this.get(sourceId), target = this.get(targetId)
    this.checkPair(source, target.descriptor, target)
    if (source.pairedDeviceId === targetId && target.pairedDeviceId === sourceId) return
    const previous = this.state.devices
    this.state.devices = {
      ...previous,
      [sourceId]: { ...source, pairedDeviceId: targetId },
      [targetId]: { ...target, pairedDeviceId: sourceId },
    }
    try { this.save() } catch (error) { this.state.devices = previous; throw error }
  }
  register(descriptor: AccountDeviceDescriptor, sourceDeviceId?: string): ReturnType<Store['issue']> {
    const old = this.state.devices[descriptor.deviceId]
    if (old?.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    if (old && (old.descriptor.identityKey !== descriptor.identityKey || old.descriptor.role !== descriptor.role)) throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
    if (!old && Object.keys(this.state.devices).length >= 256) throw new ApiError('RATE_LIMITED', 429)
    const source = sourceDeviceId === undefined ? undefined : this.get(sourceDeviceId)
    if (source && (sourceDeviceId === descriptor.deviceId || source.descriptor.role === descriptor.role)) throw new ApiError('INVALID_MESSAGE', 409)
    // register-owned-role is explicitly for the opposite role on this installation.
    // Keep cross-platform enrollments separate, and never infer a link from a name/IP.
    const paired = source?.descriptor.platform === descriptor.platform ? source : undefined
    if (paired) this.checkPair(paired, descriptor, old)
    const registered: SavedDevice = {
      descriptor, revoked: false, lastSeenAt: old?.lastSeenAt ?? 0,
      ...(old?.pairedDeviceId === undefined ? {} : { pairedDeviceId: old.pairedDeviceId }),
      ...(paired === undefined ? {} : { pairedDeviceId: sourceDeviceId }),
    }
    const previousDevices = this.state.devices, previousTokens = this.state.tokens
    this.state.devices = { ...previousDevices, [descriptor.deviceId]: registered }
    if (paired) this.state.devices[sourceDeviceId!] = { ...paired, pairedDeviceId: descriptor.deviceId }
    this.state.tokens = { ...previousTokens }
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.deviceId === descriptor.deviceId) delete this.state.tokens[key]
    let tokens: ReturnType<Store['issue']>
    try { tokens = this.issue(descriptor.deviceId) } catch (error) {
      this.state.devices = previousDevices
      this.state.tokens = previousTokens
      throw error
    }
    this.onInvalidate(descriptor.deviceId)
    return tokens
  }
  private issue(deviceId: string, refreshTokenExpiresAt = Date.now() + 30 * 86400_000, previous?: { token: string; record: SavedToken }) {
    const tokens = { ...this.state.tokens }
    for (const [key, value] of Object.entries(tokens)) if (value.expires <= Date.now()) delete tokens[key]
    if (Object.keys(tokens).length + 2 > 16384) throw new ApiError('RATE_LIMITED', 429)
    const accessTokenExpiresAt = Date.now() + 60 * 60_000
    const nonce = secret()
    const { accessToken, refreshToken } = previous
      ? successor(previous.token, nonce, deviceId)
      : { accessToken: secret(), refreshToken: secret() }
    if (previous) tokens[hash(previous.token)] = {
      ...previous.record, used: true, recovery: { nonce, accessExpires: accessTokenExpiresAt },
    }
    tokens[hash(accessToken)] = { kind: 'access', deviceId, expires: accessTokenExpiresAt, used: false }
    tokens[hash(refreshToken)] = { kind: 'refresh', deviceId, expires: refreshTokenExpiresAt, used: false }
    const before = this.state.tokens
    this.state.tokens = tokens
    // Commit consumption, recovery metadata and the successor together. A failed
    // write must leave the previous token usable both in memory and after restart.
    try { this.save() } catch (error) { this.state.tokens = before; throw error }
    return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }
  }
  authenticate(token: string): SavedDevice {
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'access') throw new ApiError('AUTH_INVALID', 401)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    return this.get(record.deviceId)
  }
  refresh(deviceId: string, token: string) {
    this.get(deviceId)
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'refresh' || record.deviceId !== deviceId) throw new ApiError('AUTH_INVALID', 401)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    if (!record.used) return this.issue(deviceId, record.expires, { token, record })
    // Legacy consumed tokens have no recovery record. Reject them without
    // invalidating credentials that may already be in use by this device.
    if (!record.recovery) throw new ApiError('AUTH_INVALID', 401)
    const pair = successor(token, record.recovery.nonce, deviceId)
    const next = this.state.tokens[hash(pair.refreshToken)]
    if (!next || next.kind !== 'refresh' || next.deviceId !== deviceId || next.expires !== record.expires) {
      throw new ApiError('INTERNAL_ERROR', 503)
    }
    if (next.used) throw new ApiError('AUTH_INVALID', 401)
    const access = this.state.tokens[hash(pair.accessToken)]
    if (access ? access.kind !== 'access' || access.deviceId !== deviceId || access.expires !== record.recovery.accessExpires
      : record.recovery.accessExpires > Date.now()) throw new ApiError('INTERNAL_ERROR', 503)
    // Return the original expiry, including an expired access bearer. The
    // recovered, still-valid refresh token can then rotate normally.
    return { ...pair, accessTokenExpiresAt: record.recovery.accessExpires, refreshTokenExpiresAt: next.expires }
  }
  invalidate(deviceId: string): void {
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.deviceId === deviceId) delete this.state.tokens[key]
    this.onInvalidate(deviceId)
    this.save()
  }
  revoke(id: string): void { this.get(id).revoked = true; this.invalidate(id) }
  /** Remove a device together with the paired identity of the same installation. */
  remove(id: string): string[] {
    const target = this.get(id)
    const ids = new Set<string>([id])
    if (target.pairedDeviceId !== undefined && this.state.devices[target.pairedDeviceId] !== undefined) ids.add(target.pairedDeviceId)
    for (const [otherId, device] of Object.entries(this.state.devices)) {
      if (device.pairedDeviceId !== undefined && ids.has(device.pairedDeviceId)) ids.add(otherId)
    }
    const previousDevices = this.state.devices
    const previousTokens = this.state.tokens
    const devices = { ...previousDevices }
    const tokens = { ...previousTokens }
    for (const deviceId of ids) {
      delete devices[deviceId]
      for (const [key, value] of Object.entries(tokens)) if (value.deviceId === deviceId) delete tokens[key]
    }
    this.state.devices = devices
    this.state.tokens = tokens
    try { this.save() } catch (error) {
      this.state.devices = previousDevices
      this.state.tokens = previousTokens
      throw error
    }
    for (const deviceId of ids) this.onInvalidate(deviceId)
    return [...ids]
  }
  rename(id: string, name: string): void {
    const devices = this.deviceGroup(id)
    const previous = devices.map(device => device.descriptor.name)
    for (const device of devices) device.descriptor.name = name
    try { this.save() } catch (error) {
      devices.forEach((device, index) => { device.descriptor.name = previous[index]! })
      throw error
    }
  }
  touch(id: string, clientVersion?: string, harnessVersion?: string): void {
    const d = this.get(id)
    d.lastSeenAt = Date.now()
    if (clientVersion) d.descriptor.clientVersion = clientVersion.slice(0, 64)
    if (d.descriptor.role === 'host' && harnessVersion) d.descriptor.harnessVersion = harnessVersion.slice(0, 64)
    this.save()
  }
}
