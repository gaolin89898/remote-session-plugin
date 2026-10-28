/**
 * dsh-remote-session — Host half.
 *
 * Bridges this DSH instance's sessions to other DSH instances through a relay:
 *  - registers with the relay and keeps a live SSE stream for inbound messages
 *  - publishes a compact local session index (id/title/cwd/updatedAt/running)
 *  - answers relay RPCs from peer devices: list / transcript / prompt / cancel
 *  - serves a plugin-private HTTP API for its own Client half under
 *    /remote-session/api (state / refresh / transcript / send / cancel)
 *
 * Session execution always happens on the device that owns ~/.dsh: prompts are
 * forwarded to the owning instance (single-writer per session, see DSH session
 * persistence locks). This plugin never writes session files itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { NativeGateway } from './native-gateway.js';
import { installNativeTransport } from './native-transport.js';
import { PluginSync, planPluginSync } from './plugin-sync.js';
import { RestartController } from './restart.js';
import {
  findSessionFile,
  decodeSessionLogFileSync,
  eventsToMessages,
  readSessionEventsSync,
  resolveDshHome,
  scanSessions,
} from './session-bridge.js';

export const name = 'dsh-remote-session';
export const inject = ['webServer', 'sessionController', 'agents', 'connection', 'typertGateway', 'clientModules'];

const PLUGIN = 'dsh-remote-session';
const PLUGIN_VERSION = '1.2.3';
const API_PREFIX = '/remote-session/api';
const MAX_JSON_BODY = 1024 * 1024;
// Base64 uploads need more room; leave headroom below the relay's 64 MiB limit.
const MAX_NATIVE_BODY = 32 * 1024 * 1024;

const DEFAULTS = {
  relayUrl: '',
  token: '',
  instanceId: '',
  instanceName: '',
  indexMs: 10000,
  maxSessions: 60,
  maxMessages: 100,
  maxChars: 1600,
  maxEvents: 4000,
};

/**
 * Relay circuit breaker. A dead relay used to make the loop retry every 30s
 * forever, flooding the log and the network; after `failThreshold` consecutive
 * failures the loop drops to one slow probe per `cooldownMs` until the relay
 * answers again (or the user hits refresh / saves settings).
 */
const RELAY_BREAKER = {
  failThreshold: 5,
  cooldownMs: 5 * 60 * 1000,
  /** A connection that held this long resets the counter instead of counting up. */
  stableMs: 30 * 1000,
};

function log(...args) {
  // eslint-disable-next-line no-console
  console.error(`[${PLUGIN}]`, ...args);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function trimSlash(value) {
  return String(value || '').replace(/\/+$/u, '');
}
function knownRuntime(value) {
  return value === 'desktop' || value === 'web' ? value : null;
}
function jsonResponse(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
function readJsonBody(req, maxBytes = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        const error = new Error('body too large');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const ZSTD_MAGIC = 0xfd2fb528;

/** Walk one zstd frame starting at `offset` and return its end offset. */
function zstdFrameEnd(buffer, offset) {
  let pointer = offset + 4;
  const descriptor = buffer[pointer];
  pointer += 1;
  const fcsFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const hasChecksum = (descriptor & 4) !== 0;
  const dictFlag = descriptor & 3;
  pointer += (singleSegment ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag);
  pointer += fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag;
  for (;;) {
    const header = buffer.readUIntLE(pointer, 3);
    pointer += 3;
    pointer += ((header >>> 1) & 3) === 1 ? 1 : header >>> 3;
    if (header & 1) break;
  }
  return hasChecksum ? pointer + 4 : pointer;
}

/**
 * Cheaply read a session header (cwd/id) and title by decompressing only the
 * first few frames of an append-only jsonl.zstd log. Returns null on any
 * problem so callers can fall back to "unknown".
 */
function readSessionHeadFast(file, maxFrames = 24, maxTextBytes = 6 << 20) {
  try {
    const buffer = fs.readFileSync(file);
    const chunks = [];
    let offset = 0;
    let textBytes = 0;
    let text = '';
    for (let frame = 0; frame < maxFrames && offset < buffer.length; frame += 1) {
      if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
      const end = zstdFrameEnd(buffer, offset);
      if (end <= offset + 4 || end > buffer.length) break;
      const chunk = zlib.zstdDecompressSync(buffer.subarray(offset, end));
      chunks.push(chunk);
      textBytes += chunk.length;
      offset = end;
      text = Buffer.concat(chunks).toString('utf8');
      const lines = text.split('\n');
      let header = null;
      let title = null;
      // Last line may be incomplete if it does not end with '\n'; only parse
      // complete lines that are followed by another newline.
      for (let index = 0; index < lines.length - 1; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        if (line.startsWith('{"type":"session"')) {
          try {
            header = JSON.parse(line);
          } catch {
            /* ignore malformed header */
          }
          continue;
        }
        if (line.includes('"session/title"') && line.includes('"title"')) {
          try {
            const event = JSON.parse(line);
            if (typeof event?.data?.title === 'string' && event.data.title.trim()) {
              title = event.data.title;
            }
          } catch {
            /* ignore malformed title event */
          }
        }
      }
      if (header && title) return { header, title };
      if (textBytes > maxTextBytes) break;
    }
    return text ? { header: null, title: null } : null;
  } catch {
    return null;
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const runtime = ctx.get('profileContext')?.name === 'desktop' ? 'desktop' : 'web';
  cfg.relayUrl = trimSlash(cfg.relayUrl || process.env.DSH_RELAY_URL || '');
  cfg.token = String(cfg.token || process.env.DSH_RELAY_TOKEN || '');
  cfg.instanceId = String(
    cfg.instanceId || process.env.DSH_RELAY_INSTANCE_ID || `dsh-${hostname()}-${process.pid}`,
  )
    .replace(/[^A-Za-z0-9_-]/gu, '-')
    .slice(0, 64);
  cfg.instanceName = String(
    cfg.instanceName || process.env.DSH_RELAY_INSTANCE_NAME || hostname(),
  ).slice(0, 64);
  cfg.indexMs = Math.max(3000, Number(cfg.indexMs) || DEFAULTS.indexMs);
  cfg.maxSessions = Math.max(1, Number(cfg.maxSessions) || DEFAULTS.maxSessions);
  cfg.maxMessages = Math.max(5, Number(cfg.maxMessages) || DEFAULTS.maxMessages);
  cfg.maxChars = Math.max(200, Number(cfg.maxChars) || DEFAULTS.maxChars);
  cfg.maxEvents = Math.max(100, Number(cfg.maxEvents) || DEFAULTS.maxEvents);

  const dshHome = resolveDshHome(process.env);
  // Operator-editable connection settings live beside the DSH home so a UI
  // change survives restarts; the plugin config stays the bootstrap source.
  const settingsFile = path.join(dshHome, 'remote-session-settings.json');
  const sanitizeInstanceId = (value) =>
    String(value || '')
      .replace(/[^A-Za-z0-9_-]/gu, '-')
      .slice(0, 64);
  const normalizeRelayUrl = (value) => trimSlash(String(value || '').trim());
  const readStoredSettings = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };
  const stored = readStoredSettings();
  if (stored) {
    if (typeof stored.relayUrl === 'string' && stored.relayUrl.trim()) cfg.relayUrl = normalizeRelayUrl(stored.relayUrl);
    if (typeof stored.token === 'string' && stored.token.trim()) cfg.token = stored.token.trim();
    if (typeof stored.instanceId === 'string' && sanitizeInstanceId(stored.instanceId)) cfg.instanceId = sanitizeInstanceId(stored.instanceId);
    if (typeof stored.instanceName === 'string' && stored.instanceName.trim()) cfg.instanceName = stored.instanceName.trim().slice(0, 64);
  }
  const state = {
    stopped: false,
    abort: null,
    relay: { connected: false, lastError: null, since: 0, failures: 0, paused: false, retryAt: 0 },
    relayGen: 0,
    wakeRelay: null,
    previousInstanceId: null,
    peers: new Map(),
    peerVersions: new Map(),
    pending: new Map(),
    titleCache: new Map(),
    cwdCache: new Map(),
    sessionFiles: new Map(),
    projCache: null,
    filesScannedAt: 0,
    indexTimer: null,
    currentFileScan: null,
  };

  const relayBase = () => (cfg.relayUrl ? `${cfg.relayUrl}` : '');
  const nativeGateway = new NativeGateway(ctx);
  const nativeStatus = nativeGateway.status();
  if (!nativeStatus.supported) log(nativeStatus.error);
  const pluginSync = new PluginSync(ctx);
  const restarter = new RestartController(ctx, runtime);
  ctx.effect(() => () => restarter.dispose(), `${PLUGIN}: restart`);
  ctx.effect(() => () => pluginSync.dispose(), `${PLUGIN}: plugin sync`);
  ctx.effect(() => () => nativeGateway.dispose(), `${PLUGIN}: native gateway`);
  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'script', placement: 'head', text: `(${installNativeTransport.toString()})(globalThis);` });
  });

  /* ------------------------------------------------------------------ *
   * local session index / transcript
   * ------------------------------------------------------------------ */

  async function refreshFileIndex(force = false) {
    const now = Date.now();
    if (!force && now - state.filesScannedAt < 10000) return;
    if (state.currentFileScan) return state.currentFileScan;
    state.currentFileScan = (async () => {
      try {
        state.sessionFiles = await scanSessions(dshHome);
        state.filesScannedAt = Date.now();
      } catch (error) {
        log('scanSessions failed:', String(error?.message || error));
      } finally {
        state.currentFileScan = null;
      }
    })();
    return state.currentFileScan;
  }

  // DSH keeps a durable projection cache (title/cwd/stats) for cold sessions.
  // It is the cheapest title source for sessions the controller lists without
  // projections; read it defensively and never write it.
  function loadProjectionCache() {
    const now = Date.now();
    if (state.projCache && now - state.projCache.readAt < 15000) return state.projCache.map;
    const map = new Map();
    try {
      const file = `${dshHome}/storages/session_projcache.json`;
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      const sessions = parsed?.tables?.sessions;
      if (sessions && typeof sessions === 'object') {
        for (const [sessionId, entry] of Object.entries(sessions)) {
          if (!entry || typeof entry !== 'object') continue;
          const title = entry.rows?.title?.val;
          const cwd = entry.identity?.cwd;
          map.set(sessionId, {
            title: typeof title === 'string' && title.trim() ? title : null,
            cwd: typeof cwd === 'string' && cwd.trim() ? cwd : null,
          });
        }
      }
    } catch {
      /* cache absent or unreadable: titles stay unknown */
    }
    state.projCache = { readAt: now, map };
    return map;
  }

  function pickProjectionTitle(item) {
    const values = item?.projections?.values;
    if (!values || typeof values !== 'object') return null;
    const raw = values.title;
    if (typeof raw === 'string' && raw.trim()) return raw;
    if (raw && typeof raw === 'object') {
      if (typeof raw.val === 'string' && raw.val.trim()) return raw.val;
      if (typeof raw.value === 'string' && raw.value.trim()) return raw.value;
    }
    return null;
  }

  function localRunning(sessionId) {    try {
      const agent = ctx.agents?.get?.(sessionId);
      if (agent && agent.status) return agent.status === 'running';
    } catch {
      /* service may be absent or session unknown */
    }
    return false;
  }

  /** Official Workspace registry snapshot: titles, paths and session membership. */
  function localWorkspaceSnapshot() {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
      if (!registry || typeof registry.list !== 'function') return null;
      const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : [];
      const workspaces = registry.list().map((workspace) => ({
        id: String(workspace.id),
        title: typeof workspace.title === 'string' ? workspace.title : null,
        path: typeof workspace.path === 'string' ? workspace.path : null,
        sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
      }));
      return { workspaces, archivedSessionIds: archived.map(String) };
    } catch {
      return null;
    }
  }

  async function listLocalWorkspaces() {
    return localWorkspaceSnapshot() || { workspaces: [], archivedSessionIds: [] };
  }

  async function listLocalSessions() {
    await refreshFileIndex();
    let controllerItems = null;
    try {
      if (typeof ctx.sessionController?.list === 'function') {
        const value = await ctx.sessionController.list({}, AbortSignal.timeout(5000));
        controllerItems = Array.isArray(value?.items) ? value.items : null;
      }
    } catch (error) {
      log('sessionController.list failed:', String(error?.message || error));
    }

    const rows = [];
    const seen = new Set();
    const projCache = loadProjectionCache();
    if (controllerItems) {
      for (const item of controllerItems) {
        const id = item?.sessionId;
        if (!id) continue;
        seen.add(id);
        const meta = state.sessionFiles.get(id);
        const cached = projCache.get(id);
        const title = pickProjectionTitle(item) || cached?.title || state.titleCache.get(id) || null;
        if (title) state.titleCache.set(id, title);
        const cwd = item.cwd || cached?.cwd || state.cwdCache.get(id) || meta?.cwd || null;
        rows.push({
          id,
          title,
          cwd,
          updatedAt: Number(item.updatedAt) || meta?.updatedAt || 0,
          running: !!item.running || localRunning(id),
          blank: !!item.blank,
        });
      }
    }
    for (const [id, meta] of state.sessionFiles) {
      if (seen.has(id)) continue;
      const cached = projCache.get(id);
      const cwd = cached?.cwd || state.cwdCache.get(id) || meta?.cwd || null;
      rows.push({
        id,
        title: cached?.title || state.titleCache.get(id) || null,
        cwd,
        updatedAt: Number(meta?.updatedAt) || 0,
        running: localRunning(id),
        blank: false,
      });
    }
    // Fill missing title/cwd for a few rows per pass from the session log head
    // (first frames only), so indexes converge even without a projection cache.
    const needHead = rows.filter((row) => !row.title || !row.cwd).slice(0, 3);
    for (const row of needHead) {
      const knownFile = state.sessionFiles.get(row.id)?.file;
      const file = knownFile || findSessionFile(dshHome, row.id);
      if (!file) continue;
      const head = readSessionHeadFast(file);
      if (!head) continue;
      if (!row.title && head.title) {
        row.title = head.title;
        state.titleCache.set(row.id, head.title);
      }
      if (!row.cwd && head.header?.cwd) {
        row.cwd = head.header.cwd;
        state.cwdCache.set(row.id, head.header.cwd);
      }
    }
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return rows.slice(0, cfg.maxSessions);
  }

  async function resolveLocalSessionFile(sessionId) {
    let file = findSessionFile(dshHome, sessionId);
    if (!file) {
      await refreshFileIndex(true);
      file = findSessionFile(dshHome, sessionId);
    }
    return file || null;
  }

  /** Decoded session log keyed by file identity; transcript and events reads share it. */
  const sessionParseCache = new Map();
  function parsedSessionFile(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    const cached = sessionParseCache.get(file);
    if (cached && stat && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    const parsed = decodeSessionLogFileSync(file);
    const entry = {
      header: parsed.header,
      events: parsed.events,
      mtimeMs: stat ? stat.mtimeMs : 0,
      size: stat ? stat.size : 0,
    };
    sessionParseCache.set(file, entry);
    return entry;
  }

  async function readLocalTranscript(sessionId) {
    if (!sessionId) throw Object.assign(new Error('sessionId required'), { status: 400 });
    const file = await resolveLocalSessionFile(sessionId);
    if (!file) throw Object.assign(new Error('session not found on this device'), { status: 404 });

    const { header, events } = parsedSessionFile(file);
    const compact = eventsToMessages(events, {
      maxMessages: cfg.maxMessages,
      maxChars: cfg.maxChars,
      includeReasoning: true,
    });
    if (compact.title) state.titleCache.set(sessionId, compact.title);
    if (header?.cwd) state.cwdCache.set(sessionId, header.cwd);
    const meta = state.sessionFiles.get(sessionId);
    return {
      session: {
        id: sessionId,
        title: compact.title || state.titleCache.get(sessionId) || null,
        cwd: header?.cwd || state.cwdCache.get(sessionId) || meta?.cwd || null,
        updatedAt: Number(meta?.updatedAt) || Date.now(),
        running: localRunning(sessionId),
      },
      messages: compact.messages,
      total: compact.total,
      truncated: compact.total > compact.messages.length,
    };
  }

  async function readLocalEvents(sessionId, afterSeq, requestedLimit) {
    if (!sessionId) throw Object.assign(new Error('sessionId required'), { status: 400 });
    const file = await resolveLocalSessionFile(sessionId);
    if (!file) throw Object.assign(new Error('session not found on this device'), { status: 404 });
    const limit = Math.min(60000, Math.max(200, Number(requestedLimit) || cfg.maxEvents));
    const cached = parsedSessionFile(file);
    const all = Array.isArray(cached.events) ? cached.events : [];
    const cursor = Number(afterSeq) || 0;
    let events;
    if (cursor > 0) {
      const newer = all.filter((event) => event.seq > cursor);
      events = newer.length > limit ? newer.slice(newer.length - limit) : newer;
    } else {
      events = all.length > limit ? all.slice(all.length - limit) : all;
    }
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : cursor;
    return {
      session: { id: sessionId, running: localRunning(sessionId) },
      events,
      cursor: lastSeq,
      totalEvents: all.length,
      hasMore: cursor > 0
        ? all.length > 0 && all[0].seq > cursor + 1
        : all.length > events.length,
      hasOlder: all.length > 0 && events.length > 0 && events[0].seq > all[0].seq,
      truncated: cursor > 0 && all.length > 0 && all[0].seq > cursor + 1,
    };
  }

  /** Bounded workspace file scan used when no live Agent can list references. */
  const fileScanCache = new Map();
  const FILE_SCAN_SKIP = new Set(['node_modules', '.git', '.next', '.cache', 'dist', 'build', 'out', '.turbo', '.venv', 'venv', '__pycache__']);
  async function scanWorkspaceFiles(root, query) {
    const results = [];
    const lowered = String(query || '').toLowerCase();
    const walk = async (dir, depth) => {
      if (depth > 4 || results.length >= 400) return;
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= 400) return;
        if (entry.name.startsWith('.') && entry.name !== '.env') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (FILE_SCAN_SKIP.has(entry.name)) continue;
          await walk(full, depth + 1);
          continue;
        }
        const relative = path.relative(root, full).split(path.sep).join('/');
        if (lowered === '' || relative.toLowerCase().includes(lowered)) {
          results.push({ path: relative, name: entry.name });
        }
      }
    };
    await walk(root, 0);
    return results;
  }

  async function listLocalWorkspaceFiles(sessionId, query) {
    const sessions = await listLocalSessions().catch(() => []);
    const session = sessions.find((item) => item.id === sessionId);
    const root = session && session.cwd ? String(session.cwd) : '';
    if (!root) return { candidates: [] };
    const cacheKey = root;
    const cached = fileScanCache.get(cacheKey);
    const now = Date.now();
    const files = cached && now - cached.at < 30000 ? cached.files : await scanWorkspaceFiles(root, '');
    if (!cached || now - cached.at >= 30000) fileScanCache.set(cacheKey, { at: now, files });
    const lowered = String(query || '').toLowerCase();
    const candidates = files.filter((file) => lowered === '' || file.path.toLowerCase().includes(lowered)).slice(0, 80);
    return { candidates };
  }

  /** Open or reveal one workspace path on the Host desktop (official session controller). */
  async function openLocalPath(sessionId, requestedPath, action) {
    const pathText = String(requestedPath || '').trim();
    if (!pathText) throw Object.assign(new Error('path required'), { status: 400 });
    if (typeof ctx.sessionController?.openWorkspacePath !== 'function') {
      throw Object.assign(new Error('open path unavailable'), { status: 503 });
    }
    const sessions = await listLocalSessions().catch(() => []);
    const session = sessions.find((item) => item.id === sessionId);
    const cwd = session && session.cwd ? String(session.cwd) : '';
    const windowsStyle = /^[A-Za-z]:[\\/]/.test(pathText) || /^[A-Za-z]:/.test(cwd) || cwd.includes('\\');
    const pathModule = windowsStyle ? path.win32 : path.posix;
    const resolved = pathModule.isAbsolute(pathText) || cwd === '' ? pathText : pathModule.join(cwd, pathText);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      await ctx.sessionController.openWorkspacePath({ path: resolved, action: action === 'reveal' ? 'reveal' : undefined }, controller.signal);
      return { opened: true, path: resolved };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Mutate the current goal through the official goals service (live sessions only). */
  async function goalLocalAction(sessionId, action, goalId, revision, objective) {
    const service = typeof ctx.get === 'function' ? ctx.get('goals') : undefined;
    if (!service || typeof service.pause !== 'function') {
      throw Object.assign(new Error('goal service unavailable'), { status: 503 });
    }
    const agent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(sessionId) : undefined;
    if (!agent) {
      throw Object.assign(new Error('会话未在运行，暂不能修改目标'), { status: 409 });
    }
    const ref = { id: String(goalId), revision: Number(revision) };
    if (action === 'pause') await service.pause(agent, ref);
    else if (action === 'resume') await service.resume(agent, ref);
    else if (action === 'clear') await service.clear(agent, ref);
    else if (action === 'edit') await service.edit(agent, ref, { objective: String(objective || '') });
    else throw Object.assign(new Error('unknown goal action'), { status: 400 });
    return { ok: true };
  }

  /** Deployment permission preset catalog (official permissionPresets service). */
  function permissionPresetsService() {
    const service = typeof ctx.get === 'function' ? ctx.get('permissionPresets') : undefined;
    if (!service || typeof service.catalog !== 'function') {
      throw Object.assign(new Error('permission presets unavailable'), { status: 503 });
    }
    return service;
  }

  async function localPermissionCatalog() {
    return permissionPresetsService().catalog();
  }

  async function setLocalPermission(sessionId, preset) {
    if (!sessionId || !preset) throw Object.assign(new Error('sessionId and preset required'), { status: 400 });
    const service = permissionPresetsService();
    const live = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined;
    if (!live) return { ok: false, reason: 'session-not-live' };
    service.set(live, String(preset));
    return { ok: true, preset: String(preset) };
  }

  /** Host message-feedback service (official ctx service, resolved without injection). */
  function messageFeedbackService() {
    const service = typeof ctx.get === 'function' ? ctx.get('messageFeedback') : undefined;
    if (!service || typeof service.list !== 'function') {
      throw Object.assign(new Error('message feedback service unavailable'), { status: 503 });
    }
    return service;
  }

  async function listLocalFeedback(sessionId) {
    if (!sessionId) throw Object.assign(new Error('sessionId required'), { status: 400 });
    return messageFeedbackService().list({ sessionId });
  }

  async function putLocalFeedback(request) {
    if (!request?.sessionId || !request?.messageId || !request?.rating) {
      throw Object.assign(new Error('sessionId, messageId and rating required'), { status: 400 });
    }
    return messageFeedbackService().put({
      sessionId: String(request.sessionId),
      messageId: String(request.messageId),
      rating: request.rating === 'negative' ? 'negative' : 'positive',
      note: typeof request.note === 'string' && request.note.trim() !== '' ? request.note : undefined,
      category: typeof request.category === 'string' ? request.category : undefined,
      ifVersion:
        request.ifVersion === null || request.ifVersion === undefined ? null : String(request.ifVersion),
    });
  }

  async function deleteLocalFeedback(request) {
    if (!request?.sessionId || !request?.messageId) {
      throw Object.assign(new Error('sessionId and messageId required'), { status: 400 });
    }
    return messageFeedbackService().delete({
      sessionId: String(request.sessionId),
      messageId: String(request.messageId),
      ifVersion:
        request.ifVersion === null || request.ifVersion === undefined ? undefined : String(request.ifVersion),
    });
  }

  /** Create a new Session on this Host, optionally inside one workspace directory. */
  async function createLocalSession(cwd) {
    if (typeof ctx.sessionController?.create !== 'function') {
      throw Object.assign(new Error('session controller unavailable'), { status: 503 });
    }
    const request = {};
    if (typeof cwd === 'string' && cwd.trim() !== '') request.cwd = cwd.trim();
    const value = await ctx.sessionController.create(request);
    return { sessionId: value && value.sessionId ? value.sessionId : null };
  }

  /** Official command catalog for one local Session (composer `/` menu). */
  async function listLocalCommands(sessionId) {
    const service = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
    if (!service || typeof service.list !== 'function') {
      throw Object.assign(new Error('command service unavailable'), { status: 503 });
    }
    const id = sessionId || ((await listLocalSessions())[0] || {}).id;
    const agent = id && typeof ctx.agents?.get === 'function' ? ctx.agents.get(id) : undefined;
    const commands = agent !== undefined ? await service.list(agent) : await service.list(id);
    return { commands: Array.isArray(commands) ? commands : [] };
  }

  /** Run one command line against a local Session through the official command service. */
  async function executeLocalCommand(sessionId, line) {
    const service = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
    if (!service || typeof service.execute !== 'function') {
      throw Object.assign(new Error('command service unavailable'), { status: 503 });
    }
    const id = sessionId || ((await listLocalSessions())[0] || {}).id;
    await service.execute(id, String(line || ''), []);
    return { accepted: true };
  }

  async function listLocalFileReferences(sessionId, query) {
    if (!sessionId) throw Object.assign(new Error('sessionId required'), { status: 400 });
    const text = typeof query === 'string' ? query : '';
    const agents = ctx.agents;
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    if (!agent) return { candidates: [] };
    const service = ctx.sessionFileReferences || ctx.fileReferences;
    if (!service || typeof service.list !== 'function') {
      throw Object.assign(new Error('file reference provider unavailable'), { status: 503 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const candidates = await service.list(agent, text, controller.signal);
      return { candidates: Array.isArray(candidates) ? candidates : [] };
    } finally {
      clearTimeout(timer);
    }
  }

  async function readLocalAttachment(sessionId, attachmentId) {
    if (!sessionId) throw Object.assign(new Error('sessionId required'), { status: 400 });
    if (!attachmentId) throw Object.assign(new Error('attachmentId required'), { status: 400 });
    if (typeof ctx.sessionController?.attachment !== 'function') {
      throw Object.assign(new Error('attachment service unavailable'), { status: 503 });
    }
    const value = await ctx.sessionController.attachment({ sessionId, attachmentId });
    return { attachment: value.attachment, data: value.data };
  }

  async function forkLocalSession(sessionId, atSeq) {
    if (!sessionId) throw Object.assign(new Error('sessionId required'), { status: 400 });
    if (typeof ctx.sessionController?.fork !== 'function') {
      throw Object.assign(new Error('session controller unavailable'), { status: 503 });
    }
    const request = { sessionId };
    if (typeof atSeq === 'number' && Number.isSafeInteger(atSeq) && atSeq >= 0) request.atSeq = atSeq;
    const value = await ctx.sessionController.fork(request);
    return { sessionId: value && value.sessionId ? value.sessionId : null };
  }

  async function sendLocalPrompt(sessionId, text, mode) {
    const content = String(text || '').trim();
    if (!sessionId) throw Object.assign(new Error('sessionId required'), { status: 400 });
    if (!content) throw Object.assign(new Error('empty message'), { status: 400 });
    if (typeof ctx.sessionController?.prompt !== 'function') {
      throw Object.assign(new Error('session controller unavailable'), { status: 503 });
    }
    const value = await ctx.sessionController.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: mode === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text: content.slice(0, 20000) }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      },
      AbortSignal.timeout(30000),
    );
    return value;
  }

  function cancelLocalPrompt(sessionId) {
    if (!sessionId) throw Object.assign(new Error('sessionId required'), { status: 400 });
    if (typeof ctx.sessionController?.cancel !== 'function') {
      throw Object.assign(new Error('session controller unavailable'), { status: 503 });
    }
    return ctx.sessionController.cancel({ sessionId });
  }

  async function localModelCatalog() {
    if (typeof ctx.sessionController?.modelCatalog !== 'function') {
      throw Object.assign(new Error('model catalog unavailable'), { status: 503 });
    }
    return ctx.sessionController.modelCatalog();
  }

  async function selectLocalModel(sessionId, selection) {
    if (!sessionId) throw Object.assign(new Error('sessionId required'), { status: 400 });
    if (!selection?.provider || !selection?.model) {
      throw Object.assign(new Error('provider and model required'), { status: 400 });
    }
    if (typeof ctx.sessionController?.selectModel !== 'function') {
      throw Object.assign(new Error('session controller unavailable'), { status: 503 });
    }
    const request = {
      sessionId,
      provider: String(selection.provider),
      model: String(selection.model),
    };
    if (selection.reasoningEffort) request.reasoningEffort = String(selection.reasoningEffort);
    return ctx.sessionController.selectModel(request);
  }

  /* ------------------------------------------------------------------ *
   * relay transport (HTTPS + SSE, no third-party deps)
   * ------------------------------------------------------------------ */

  async function relayPost(path, body, timeoutMs = 20000) {
    if (!cfg.relayUrl || !cfg.token) {
      throw new Error('relay not configured; set relayUrl/token in the plugin config');
    }
    const res = await fetch(`${relayBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, token: cfg.token }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-json body */
    }
    if (!res.ok || !data || data.ok !== true) {
      throw new Error(`relay ${path} failed: ${res.status} ${data?.error || ''}`.trim());
    }
    return data;
  }

  function applyPeerList(list) {
    const seen = new Set();
    for (const peer of Array.isArray(list) ? list : []) {
      if (!peer?.id || peer.id === cfg.instanceId) continue;
      seen.add(peer.id);
      state.peers.set(peer.id, {
        id: peer.id,
        name: String(peer.name || peer.id),
        online: !!peer.online,
        runtime: knownRuntime(peer.meta?.runtime),
        platform: peer.meta?.platform || null,
        restart: peer.meta?.restart || null,
        sessions: Array.isArray(peer.sessions) ? peer.sessions : [],
      });
    }
    for (const id of [...state.peers.keys()]) {
      if (!seen.has(id)) {
        state.peers.delete(id);
        state.peerVersions.delete(id);
      }
    }
    for (const peer of state.peers.values()) {
      if (peer.online && !state.peerVersions.has(peer.id)) probePeerVersion(peer.id);
    }
  }

  function probePeerVersion(peerId) {
    state.peerVersions.set(peerId, null);
    rpcCall(peerId, 'version', {}, 5000).then(
      (value) => state.peerVersions.set(peerId, value && value.version ? String(value.version) : 'legacy'),
      () => state.peerVersions.set(peerId, 'legacy'),
    );
  }

  function applyPeerEvent(data) {
    const instance = data?.instance;
    if (!instance?.id || instance.id === cfg.instanceId) return;
    const current = state.peers.get(instance.id) || { sessions: [] };
    state.peers.set(instance.id, {
      ...current,
      id: instance.id,
      name: String(instance.name || current.name || instance.id),
      online: data.type === 'online' ? !!instance.online : false,
      runtime: instance.meta ? knownRuntime(instance.meta.runtime) : current.runtime || null,
      platform: instance.meta ? instance.meta.platform || null : current.platform || null,
      restart: instance.meta ? instance.meta.restart || null : current.restart || null,
      sessions: Array.isArray(instance.sessions) ? instance.sessions : current.sessions,
    });
    if (data.type === 'online') {
      if (!state.peerVersions.has(instance.id)) probePeerVersion(instance.id);
      // A reconnect means the cached session list is stale; pull it now so the
      // panel stops showing the previous run's sessions.
      refreshPeer(instance.id).catch(() => {});
    }
  }

  function handleEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') return;
    if (envelope.type === 'rpc') {
      handleRpcRequest(envelope).catch((error) =>
        log('rpc handler failed:', String(error?.message || error)),
      );
      return;
    }
    if (envelope.type === 'rpc.result') {
      const waiter = state.pending.get(envelope.id);
      if (!waiter || waiter.peerId !== envelope.from) return;
      state.pending.delete(envelope.id);
      clearTimeout(waiter.timer);
      const payload = envelope.payload || {};
      if (payload.ok) waiter.resolve(payload.result);
      else waiter.reject(new Error(payload.error || 'remote rpc failed'));
    }
  }

  function handleSseFrame(raw) {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (event === 'ready') {
      applyPeerList(data.peers);
      refreshPeers().catch(() => {});
      return;
    }
    if (event === 'peer') return applyPeerEvent(data);
    if (event === 'peer.index') {
      const peer = state.peers.get(data?.id);
      if (peer && Array.isArray(data.sessions)) peer.sessions = data.sessions;
      return;
    }
    if (event === 'message') return handleEnvelope(data);
  }

  async function openStream() {
    const url = new URL(`${relayBase()}/v1/stream`);
    url.searchParams.set('id', cfg.instanceId);
    const abort = new AbortController();
    state.abort = abort;
    const res = await fetch(url, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${cfg.token}` },
      signal: abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`relay stream http ${res.status}`);
    // A restart may have aborted this generation while the request was in flight.
    if (abort.signal.aborted) throw new Error('relay stream aborted');
    state.relay.connected = true;
    state.relay.lastError = null;
    state.relay.since = Date.now();
    // Only a live stream proves the relay is back — /v1/register can succeed
    // while the stream endpoint is still down.
    if (state.relay.paused) log('relay reachable again; resuming normal polling');
    state.relay.paused = false;
    state.relay.retryAt = 0;
    log(`relay connected as ${cfg.instanceId} (${cfg.instanceName})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleSseFrame(raw);
      }
    }
    throw new Error('relay stream closed');
  }

  /** Drop the breaker back to normal polling (settings change, manual refresh). */
  function resetRelayBreaker() {
    state.relay.failures = 0;
    state.relay.paused = false;
    state.relay.retryAt = 0;
    state.wakeRelay?.();
  }

  /** True while the breaker is open and the next probe is still in the future. */
  function relayBreakerOpen() {
    return state.relay.paused === true && Date.now() < (Number(state.relay.retryAt) || 0);
  }

  /**
   * Account for one failed relay attempt and say how long to wait before retrying.
   * Rapid back-to-back failures trip the breaker and drop to a slow probe so a
   * dead relay cannot flood the log or the network.
   */
  function noteRelayFailure(error) {
    const uptime =
      state.relay.connected && state.relay.since ? Date.now() - Number(state.relay.since) : 0;
    state.relay.connected = false;
    state.relay.lastError = String(error?.message || error);
    // A connection that held for a while means a fresh incident, not a flap.
    const failures =
      uptime >= RELAY_BREAKER.stableMs ? 1 : (Number(state.relay.failures) || 0) + 1;
    state.relay.failures = failures;
    if (failures < RELAY_BREAKER.failThreshold) {
      log('relay loop error:', state.relay.lastError);
      return Math.min(1000 * 2 ** (failures - 1), 30000);
    }
    const firstTrip = state.relay.paused !== true;
    state.relay.paused = true;
    state.relay.retryAt = Date.now() + RELAY_BREAKER.cooldownMs;
    if (firstTrip) {
      log(
        `relay unreachable after ${failures} attempts (${state.relay.lastError}); ` +
          `pausing retries for ${Math.round(RELAY_BREAKER.cooldownMs / 1000)}s`,
      );
    }
    return RELAY_BREAKER.cooldownMs;
  }

  /** Wait for backoff, a manual refresh, or relay retirement. */
  async function sleepUnlessRetired(ms, generation) {
    if (state.stopped || generation !== state.relayGen) return false;
    await new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer);
        if (state.wakeRelay === wake) state.wakeRelay = null;
        resolve();
      };
      const timer = setTimeout(wake, ms);
      state.wakeRelay = wake;
    });
    return !(state.stopped || generation !== state.relayGen);
  }

  async function runRelayLoop() {
    const generation = state.relayGen;
    while (!state.stopped && generation === state.relayGen) {
      try {
        if (!cfg.relayUrl || !cfg.token) throw new Error('relay not configured; set relayUrl/token');
        const sessions = await listLocalSessions();
        const registered = await relayPost('/v1/register', {
          id: cfg.instanceId,
          ...(state.previousInstanceId ? { previousId: state.previousInstanceId } : {}),
          name: cfg.instanceName,
          sessions,
          meta: { plugin: PLUGIN, version: PLUGIN_VERSION, platform: process.platform, runtime, restart: restarter.status() },
        });
        state.previousInstanceId = null;
        applyPeerList(registered.peers);
        refreshPeers().catch(() => {});
        await openStream();
      } catch (error) {
        // A restarted relay owns the state now; the retired generation just exits.
        if (generation !== state.relayGen || state.stopped) break;
        const delay = noteRelayFailure(error);
        if (!(await sleepUnlessRetired(delay, generation))) break;
      }
    }
  }

  async function pushIndex() {
    if (!cfg.relayUrl || !cfg.token) return;
    // Breaker open: stay quiet until the next probe is due.
    if (relayBreakerOpen()) return;
    try {
      const sessions = await listLocalSessions();
      await relayPost('/v1/index', { id: cfg.instanceId, sessions });
    } catch {
      /* transient; the reconnect loop reports the error */
    }
  }

  async function rpcCall(peerId, method, params, timeoutMs = 30000) {
    const peer = state.peers.get(peerId);
    if (!peer) throw Object.assign(new Error('unknown peer'), { status: 404 });
    if (!peer.online) throw Object.assign(new Error('peer offline'), { status: 409 });
    const id = randomUUID();
    let settleResolve;
    let settleReject;
    const promise = new Promise((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });
    const timer = setTimeout(() => {
      state.pending.delete(id);
      settleReject(new Error(`remote ${method} timed out`));
    }, timeoutMs);
    state.pending.set(id, { peerId, resolve: settleResolve, reject: settleReject, timer });
    // Return the response promise immediately so its timeout is always observed.
    void relayPost('/v1/publish', {
      from: cfg.instanceId,
      to: peerId,
      type: 'rpc',
      id,
      payload: { method, params },
    }).catch((error) => {
      clearTimeout(timer);
      state.pending.delete(id);
      settleReject(error);
    });
    return promise;
  }

  async function handleRpcRequest(envelope) {
    const { method, params } = envelope.payload || {};
    let result;
    let restartJob;
    try {
      if (method === 'restart') { restartJob = await restarter.prepare(); result = restarter.status(); }
      else if (method === 'restartStatus') result = restarter.status();
      else if (method === 'native') result = await nativeGateway.dispatch(envelope.from, params);
      else if (method === 'pluginSync') result = await pluginSync.dispatch(envelope.from, params);
      else if (method === 'version') result = { version: PLUGIN_VERSION, nativeProtocol: 1, pluginSyncProtocol: 1 };
      else if (method === 'list') result = await listLocalSessions();
      else if (method === 'transcript') result = await readLocalTranscript(params?.sessionId);
      else if (method === 'events') result = await readLocalEvents(params?.sessionId, params?.afterSeq, params?.limit);
      else if (method === 'fork') result = await forkLocalSession(params?.sessionId, params?.atSeq);
      else if (method === 'attachment') result = await readLocalAttachment(params?.sessionId, params?.attachmentId);
      else if (method === 'fileReferences') result = await listLocalFileReferences(params?.sessionId, params?.query);
      else if (method === 'workspaces') result = await listLocalWorkspaces();
      else if (method === 'commands') result = await listLocalCommands(params?.sessionId);
      else if (method === 'openPath') result = await openLocalPath(params?.sessionId, params?.path, params?.action);
      else if (method === 'files') result = await listLocalWorkspaceFiles(params?.sessionId, params?.query);
      else if (method === 'create') result = await createLocalSession(params?.cwd);
      else if (method === 'feedback') result = await listLocalFeedback(params?.sessionId);
      else if (method === 'goalAction') result = await goalLocalAction(params?.sessionId, params?.action, params?.goalId, params?.revision, params?.objective);
      else if (method === 'permissionCatalog') result = await localPermissionCatalog();
      else if (method === 'permissionSet') result = await setLocalPermission(params?.sessionId, params?.preset);
      else if (method === 'feedbackPut') result = await putLocalFeedback(params?.request);
      else if (method === 'feedbackDelete') result = await deleteLocalFeedback(params?.request);
      else if (method === 'executeCommand') result = await executeLocalCommand(params?.sessionId, params?.line);
      else if (method === 'prompt') result = await sendLocalPrompt(params?.sessionId, params?.text, params?.mode);
      else if (method === 'cancel') result = { ok: true, ...cancelLocalPrompt(params?.sessionId) };
      else if (method === 'models') result = await localModelCatalog();
      else if (method === 'selectModel') result = await selectLocalModel(params?.sessionId, params?.selection || params);
      else throw new Error(`unknown rpc method: ${method}`);
    } catch (error) {
      await relayPost('/v1/publish', {
        from: cfg.instanceId,
        to: envelope.from,
        type: 'rpc.result',
        id: envelope.id,
        payload: { ok: false, error: String(error?.message || error) },
      }).catch(() => {});
      return;
    }
    let published = false;
    await relayPost('/v1/publish', {
      from: cfg.instanceId,
      to: envelope.from,
      type: 'rpc.result',
      id: envelope.id,
      payload: { ok: true, result },
    }).then(() => { published = true; }, (error) => log('rpc result publish failed:', String(error?.message || error)));
    if (published && restartJob) restarter.commit(restartJob);
    if (method === 'prompt') pushIndex().catch(() => {});
  }

  /** Re-read one online peer's session index and workspace registry. */
  async function refreshPeer(peerId) {
    const peer = state.peers.get(peerId);
    if (!peer || !peer.online) return;
    try {
      peer.sessions = await rpcCall(peer.id, 'list', {}, 8000);
    } catch {
      /* keep the last known list */
    }
    try {
      peer.workspaces = await rpcCall(peer.id, 'workspaces', {}, 8000);
    } catch {
      /* keep the last known workspaces */
    }
  }

  /** Ask the relay for its authoritative instance list. */
  async function relayPeerSnapshot() {
    if (!cfg.relayUrl || !cfg.token) return null;
    try {
      const snapshot = await relayPost('/v1/peers', { id: cfg.instanceId, token: cfg.token }, 8000);
      return Array.isArray(snapshot?.peers) ? snapshot.peers : null;
    } catch {
      return null;
    }
  }

  async function refreshPeers() {
    // Breaker open: no point in asking a relay we already know is down.
    if (relayBreakerOpen()) return;
    // The relay owns membership: an instance it no longer lists (retired id,
    // expired offline entry) must leave our cache too.
    const snapshot = await relayPeerSnapshot();
    if (snapshot) applyPeerList(snapshot);
    const online = [...state.peers.values()].filter((peer) => peer.online);
    await Promise.all(online.map((peer) => refreshPeer(peer.id)));
  }

  /** Current relay connection settings for the settings dialog (token redacted). */
  function relaySettingsSnapshot() {
    return {
      ok: true,
      relayUrl: cfg.relayUrl,
      instanceId: cfg.instanceId,
      instanceName: cfg.instanceName,
      runtime,
      hasToken: Boolean(cfg.token),
      tokenHint: cfg.token ? cfg.token.slice(-4) : '',
      native: nativeGateway.status(),
      relay: {
        connected: state.relay.connected === true,
        lastError: state.relay.lastError || null,
        paused: state.relay.paused === true,
        retryAt: Number(state.relay.retryAt) || 0,
      },
    };
  }

  /** Stop the current relay generation and open a fresh one with the saved cfg. */
  function restartRelay() {
    state.relayGen += 1;
    state.relay.connected = false;
    state.relay.lastError = null;
    // A config change deserves a clean slate: never inherit an open breaker.
    resetRelayBreaker();
    try {
      state.abort?.abort();
    } catch {
      /* the old stream is already gone */
    }
    state.abort = null;
    runRelayLoop().catch((error) => log('relay restart failed:', String(error?.message || error)));
  }

  /**
   * Persist connection settings and reconnect.
   * @param body - relayUrl/token/instanceId/instanceName; an absent token keeps the stored one.
   * @returns the applied settings snapshot.
   */
  /** Poll until the relay stream is up so the settings dialog can report success. */
  async function waitForRelayConnection(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (state.relay.connected) return true;
      await sleep(120);
    }
    return state.relay.connected;
  }

  async function saveRelaySettings(body) {
    const relayUrl = normalizeRelayUrl(body?.relayUrl);
    if (relayUrl && !/^https?:\/\//i.test(relayUrl)) {
      throw Object.assign(new Error('Relay 地址需要以 http:// 或 https:// 开头'), { status: 400 });
    }
    const tokenInput = typeof body?.token === 'string' ? body.token.trim() : '';
    const token = tokenInput || cfg.token;
    if (!relayUrl || !token) {
      throw Object.assign(new Error('Relay 地址和访问令牌都必须填写'), { status: 400 });
    }
    const instanceName = String(body?.instanceName || cfg.instanceName || '').trim().slice(0, 64) || cfg.instanceName;
    const instanceInput = String(body?.instanceId || cfg.instanceId || '').trim();
    const instanceId = sanitizeInstanceId(instanceInput) || cfg.instanceId;
    const previousInstanceId = cfg.instanceId !== instanceId ? cfg.instanceId : null;
    cfg.relayUrl = relayUrl;
    cfg.token = token;
    cfg.instanceId = instanceId;
    cfg.instanceName = instanceName;
    const payload = { relayUrl, token, instanceId, instanceName };
    try {
      fs.mkdirSync(dshHome, { recursive: true });
      fs.writeFileSync(settingsFile, `${JSON.stringify(payload, null, 2)}
`, 'utf8');
    } catch (error) {
      log('failed to persist relay settings:', String(error?.message || error));
    }
    state.previousInstanceId = previousInstanceId;
    restartRelay();
    log(`relay settings updated -> ${cfg.relayUrl} as ${cfg.instanceId} (${cfg.instanceName})`);
    await waitForRelayConnection();
    return relaySettingsSnapshot();
  }

  /* ------------------------------------------------------------------ *
   * plugin-private HTTP API for the Client half
   * ------------------------------------------------------------------ */

  function buildState() {
    return {
      ok: true,
      native: nativeGateway.status(),
      relay: {
        connected: state.relay.connected,
        url: cfg.relayUrl,
        lastError: state.relay.lastError,
        paused: state.relay.paused === true,
        retryAt: Number(state.relay.retryAt) || 0,
        failures: Number(state.relay.failures) || 0,
      },
      self: { id: cfg.instanceId, name: cfg.instanceName, version: PLUGIN_VERSION, runtime, platform: process.platform, restart: restarter.status() },
      workspaces: localWorkspaceSnapshot(),
      peers: [...state.peers.values()].map((peer) => ({
        id: peer.id,
        name: peer.name,
        online: !!peer.online,
        runtime: peer.runtime,
        platform: peer.platform,
        restart: peer.restart,
        version: state.peerVersions.get(peer.id) || null,
        sessions: peer.sessions || [],
        workspaces: peer.workspaces || null,
      })),
    };
  }

  function requestRejected(req) {
    try {
      if (typeof ctx.connection?.requestRejection === 'function') {
        return ctx.connection.requestRejection(req) !== undefined;
      }
    } catch {
      /* ignore fence errors, the route stays behind the DSH host wall */
    }
    return false;
  }

  async function handleApi(req, res) {
    try {
      if (requestRejected(req)) {
        return jsonResponse(res, 403, { ok: false, error: 'forbidden' });
      }
      const url = new URL(req.url || '/', 'http://dsh.internal');
      const sub = url.pathname.startsWith(`${API_PREFIX}/`)
        ? url.pathname.slice(API_PREFIX.length + 1)
        : '';
      if (sub.startsWith('resource/')) {
        if (req.method !== 'GET') throw Object.assign(new Error('GET required'), { status: 405 });
        const slash = sub.indexOf('/', 'resource/'.length);
        const peerId = sub.slice('resource/'.length, slash);
        if (slash < 0 || !state.peers.get(peerId)?.online) throw Object.assign(new Error('目标机器不在线'), { status: 409 });
        const route = '/' + sub.slice(slash + 1) + url.search;
        const clientId = 'resource-' + randomUUID();
        const remote = params => rpcCall(peerId, 'native', { clientId, ...params }, 30000);
        let transfer;
        try {
          transfer = await remote({ operation: 'resource-open', route });
          if (!Number.isSafeInteger(transfer.length) || transfer.length < 0 || transfer.length > 32 * 1024 * 1024) throw new Error('Invalid client resource length');
          if (transfer.chunkSize !== undefined && (!Number.isSafeInteger(transfer.chunkSize) || transfer.chunkSize <= 0 || transfer.chunkSize > 256 * 1024)) throw new Error('Invalid client resource chunk size');
          const immutable = transfer.immutable === true && new URL(route, 'http://dsh.internal').searchParams.get('rev');
          res.writeHead(200, {
            'content-type': transfer.contentType, 'content-length': transfer.length,
            'cache-control': immutable ? 'private, max-age=31536000, immutable' : 'private, no-store',
            'x-content-type-options': 'nosniff',
          });
          const pending = new Map();
          let scheduled = 0;
          const read = offset => {
            // Observe every rejection, including prefetched reads left over after a disconnect.
            pending.set(offset, remote({ operation: 'resource-read', resourceId: transfer.resourceId, offset })
              .then(chunk => ({ chunk }), error => ({ error })));
          };
          for (let offset = 0; offset < transfer.length && !res.destroyed;) {
            if (transfer.chunkSize !== undefined) {
              // Keep a bounded window in flight while writing strictly in byte order.
              while (pending.size < 4 && scheduled < transfer.length) {
                read(scheduled);
                scheduled += transfer.chunkSize;
              }
            } else read(offset);
            const result = await pending.get(offset);
            pending.delete(offset);
            if ('error' in result) throw result.error;
            const { chunk } = result;
            if (res.destroyed) break;
            const bytes = Buffer.from(chunk.body, 'base64');
            if (!bytes.length || chunk.next !== offset + bytes.length || chunk.next > transfer.length) throw new Error('Invalid client resource chunk');
            if (transfer.chunkSize !== undefined && chunk.next !== Math.min(offset + transfer.chunkSize, transfer.length)) throw new Error('Invalid client resource chunk');
            if (!res.write(bytes)) {
              await new Promise((resolve, reject) => {
                const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', closed); };
                const drained = () => { cleanup(); resolve(); };
                const closed = () => { cleanup(); reject(new Error('Client resource connection closed')); };
                res.once('drain', drained);
                res.once('close', closed);
                res.once('error', closed);
              });
            }
            offset = chunk.next;
          }
          res.end();
        } catch (error) {
          if (res.headersSent) { res.destroy(); return; }
          throw error;
        } finally {
          void remote({ operation: 'release' }).catch(() => {});
        }
        return;
      }
      const body = req.method === 'POST'
        ? await readJsonBody(req, sub === 'native' ? MAX_NATIVE_BODY : MAX_JSON_BODY)
        : {};

      if (sub === 'settings') return jsonResponse(res, 200, relaySettingsSnapshot());
      if (sub === 'restart' || sub === 'restart/status') {
        if (req.method !== 'POST') throw Object.assign(new Error('POST required'), { status: 405 });
        const local = body.peerId === 'local' || body.peerId === cfg.instanceId;
        if (!local && !state.peers.get(body.peerId)?.online) throw Object.assign(new Error('目标机器不在线'), { status: 409 });
        const statusOnly = sub === 'restart/status';
        let result;
        if (local) {
          if (statusOnly) result = restarter.status();
          else {
            const job = await restarter.prepare();
            result = restarter.status();
            res.once('finish', () => restarter.commit(job));
          }
        } else {
          result = await rpcCall(body.peerId, statusOnly ? 'restartStatus' : 'restart', {}, statusOnly ? 5000 : 15000);
        }
        return jsonResponse(res, 200, { ok: true, ...result });
      }
      if (sub.startsWith('plugin-sync/')) {
        if (req.method !== 'POST') throw Object.assign(new Error('POST required'), { status: 405 });
        if (!body.peerId || body.peerId === 'local' || body.peerId === cfg.instanceId) {
          throw Object.assign(new Error('请选择远程机器'), { status: 400 });
        }
        const remote = async params => {
          try { return await rpcCall(body.peerId, 'pluginSync', params, 15000); }
          catch (error) {
            if (/unknown rpc method: pluginSync/.test(error.message)) throw new Error('请先将目标机器上的远程会话插件更新到 1.0.0 或以上版本并重启 DSH');
            throw error;
          }
        };
        let result;
        if (sub === 'plugin-sync/preview') {
          const [local, target] = await Promise.all([pluginSync.inventory(), remote({ action: 'inventory' })]);
          if (target.protocol !== 1 || !Array.isArray(target.bundles)) throw new Error('目标机器不支持插件同步');
          result = { rows: planPluginSync(local.bundles, target.bundles) };
        } else if (sub === 'plugin-sync/start') {
          if (!Array.isArray(body.names) || !body.names.length || body.names.length > 256) throw new Error('请选择要同步的插件');
          const names = new Set(body.names);
          const local = await pluginSync.inventory();
          const bundles = local.bundles.filter(bundle => names.has(bundle.name) && (bundle.enabled || bundle.installed));
          if (bundles.length !== names.size) throw new Error('本机插件列表已变化，请重新比较');
          result = await remote({ action: 'start', id: body.id, bundles });
        } else if (sub === 'plugin-sync/status' || sub === 'plugin-sync/cancel') {
          result = await remote({ action: sub.endsWith('/cancel') ? 'cancel' : 'status', id: body.id });
        } else throw Object.assign(new Error('Unknown plugin sync route'), { status: 404 });
        return jsonResponse(res, 200, { ok: true, ...result });
      }
      if (sub === 'native') {
        const result = body.peerId === 'local'
          ? await nativeGateway.dispatch('local', body)
          : await rpcCall(body.peerId, 'native', body, 30000);
        return jsonResponse(res, 200, { ok: true, result });
      }
      if (sub === 'settings-save') {
        const saved = await saveRelaySettings(body);
        return jsonResponse(res, 200, saved);
      }
      if (sub === 'state') return jsonResponse(res, 200, buildState());
      if (sub === 'refresh') {
        // A manual refresh is an explicit "try now": it overrides the breaker.
        resetRelayBreaker();
        await Promise.all([pushIndex(), refreshPeers()]);
        return jsonResponse(res, 200, buildState());
      }
      if (sub === 'transcript') {
        const peerId = body.peerId;
        const sessionId = body.sessionId;
        const data =
          !peerId || peerId === 'local'
            ? await readLocalTranscript(sessionId)
            : await rpcCall(peerId, 'transcript', { sessionId });
        return jsonResponse(res, 200, { ok: true, ...data });
      }
      if (sub === 'commands') {
        const peerId = body.peerId;
        const data =
          !peerId || peerId === 'local'
            ? await listLocalCommands(body.sessionId)
            : await rpcCall(peerId, 'commands', { sessionId: body.sessionId });
        return jsonResponse(res, 200, { ok: true, ...data });
      }
      if (sub === 'execute-command') {
        const peerId = body.peerId;
        const data =
          !peerId || peerId === 'local'
            ? await executeLocalCommand(body.sessionId, body.line)
            : await rpcCall(peerId, 'executeCommand', { sessionId: body.sessionId, line: body.line });
        pushIndex().catch(() => {});
        return jsonResponse(res, 200, { ok: true, ...data });
      }
      if (sub === 'files') {
        const peerId = body.peerId;
        const data =
          !peerId || peerId === 'local'
            ? await listLocalWorkspaceFiles(body.sessionId, body.query)
            : await rpcCall(peerId, 'files', { sessionId: body.sessionId, query: body.query });
        return jsonResponse(res, 200, { ok: true, ...data });
      }
      if (sub === 'open-path') {
        const peerId = body.peerId;
        const data =
          !peerId || peerId === 'local'
            ? await openLocalPath(body.sessionId, body.path, body.action)
            : await rpcCall(peerId, 'openPath', { sessionId: body.sessionId, path: body.path, action: body.action });
        return jsonResponse(res, 200, { ok: true, ...data });
      }
      if (sub === 'goal-action') {
        const peerId = body.peerId;
        return jsonResponse(res, 200, {
          ok: true,
          result: !peerId || peerId === 'local'
            ? await goalLocalAction(body.sessionId, body.action, body.goalId, body.revision, body.objective)
            : await rpcCall(peerId, 'goalAction', {
                sessionId: body.sessionId,
                action: body.action,
                goalId: body.goalId,
                revision: body.revision,
                objective: body.objective,
              }),
        });
      }
      if (sub === 'permission-catalog') {
        const peerId = body.peerId;
        return jsonResponse(res, 200, {
          ok: true,
          catalog: !peerId || peerId === 'local'
            ? await localPermissionCatalog()
            : await rpcCall(peerId, 'permissionCatalog', {}),
        });
      }
      if (sub === 'permission-set') {
        const peerId = body.peerId;
        return jsonResponse(res, 200, {
          ok: true,
          result: !peerId || peerId === 'local'
            ? await setLocalPermission(body.sessionId, body.preset)
            : await rpcCall(peerId, 'permissionSet', { sessionId: body.sessionId, preset: body.preset }),
        });
      }
      if (sub === 'feedback') {
        const peerId = body.peerId;
        return jsonResponse(res, 200, {
          ok: true,
          result: !peerId || peerId === 'local'
            ? await listLocalFeedback(body.sessionId)
            : await rpcCall(peerId, 'feedback', { sessionId: body.sessionId }),
        });
      }
      if (sub === 'feedback-put') {
        const peerId = body.peerId;
        return jsonResponse(res, 200, {
          ok: true,
          result: !peerId || peerId === 'local'
            ? await putLocalFeedback(body.request)
            : await rpcCall(peerId, 'feedbackPut', { request: body.request }),
        });
      }
      if (sub === 'feedback-delete') {
        const peerId = body.peerId;
        return jsonResponse(res, 200, {
          ok: true,
          result: !peerId || peerId === 'local'
            ? await deleteLocalFeedback(body.request)
            : await rpcCall(peerId, 'feedbackDelete', { request: body.request }),
        });
      }
      if (sub === 'create') {
        const peerId = body.peerId;
        const data =
          !peerId || peerId === 'local'
            ? await createLocalSession(body.cwd)
            : await rpcCall(peerId, 'create', { cwd: body.cwd });
        pushIndex().catch(() => {});
        return jsonResponse(res, 200, { ok: true, ...data });
      }
      if (sub === 'file-references') {
        const peerId = body.peerId;
        const data =
          !peerId || peerId === 'local'
            ? await listLocalFileReferences(body.sessionId, body.query)
            : await rpcCall(peerId, 'fileReferences', { sessionId: body.sessionId, query: body.query });
        return jsonResponse(res, 200, { ok: true, ...data });
      }
      if (sub === 'attachment') {
        const peerId = body.peerId;
        const data =
          !peerId || peerId === 'local'
            ? await readLocalAttachment(body.sessionId, body.attachmentId)
            : await rpcCall(peerId, 'attachment', { sessionId: body.sessionId, attachmentId: body.attachmentId });
        return jsonResponse(res, 200, { ok: true, ...data });
      }
      if (sub === 'fork') {
        const peerId = body.peerId;
        const data =
          !peerId || peerId === 'local'
            ? await forkLocalSession(body.sessionId, body.atSeq)
            : await rpcCall(peerId, 'fork', { sessionId: body.sessionId, atSeq: body.atSeq });
        pushIndex().catch(() => {});
        return jsonResponse(res, 200, { ok: true, ...data });
      }
      if (sub === 'events') {
        const peerId = body.peerId;
        const sessionId = body.sessionId;
        const data =
          !peerId || peerId === 'local'
            ? await readLocalEvents(sessionId, body.afterSeq, body.limit)
            : await rpcCall(peerId, 'events', { sessionId, afterSeq: body.afterSeq, limit: body.limit });
        return jsonResponse(res, 200, { ok: true, ...data });
      }
      if (sub === 'send') {
        const peerId = body.peerId;
        const data =
          !peerId || peerId === 'local'
            ? await sendLocalPrompt(body.sessionId, body.text, body.mode)
            : await rpcCall(peerId, 'prompt', { sessionId: body.sessionId, text: body.text, mode: body.mode });
        pushIndex().catch(() => {});
        return jsonResponse(res, 200, { ok: true, accepted: true, result: data });
      }
      if (sub === 'models') {
        const peerId = body.peerId;
        const data =
          !peerId || peerId === 'local'
            ? await localModelCatalog()
            : await rpcCall(peerId, 'models', {});
        return jsonResponse(res, 200, { ok: true, catalog: data });
      }
      if (sub === 'select-model') {
        const selection = {
          provider: body.provider,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
        };
        const data =
          !body.peerId || body.peerId === 'local'
            ? await selectLocalModel(body.sessionId, selection)
            : await rpcCall(body.peerId, 'selectModel', {
                sessionId: body.sessionId,
                selection,
              });
        pushIndex().catch(() => {});
        return jsonResponse(res, 200, { ok: true, result: data });
      }
      if (sub === 'cancel') {
        const data =
          !body.peerId || body.peerId === 'local'
            ? cancelLocalPrompt(body.sessionId)
            : await rpcCall(body.peerId, 'cancel', { sessionId: body.sessionId });
        return jsonResponse(res, 200, { ok: true, result: data });
      }
      return jsonResponse(res, 404, { ok: false, error: 'unknown endpoint' });
    } catch (error) {
      const status = Number(error?.status) || (String(error?.message || '').includes('offline') ? 409 : 500);
      return jsonResponse(res, status, { ok: false, error: String(error?.message || error) });
    }
  }

  /* ------------------------------------------------------------------ *
   * lifecycle
   * ------------------------------------------------------------------ */

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: handleApi,
    });
    return () => {
      try {
        disposeRoute?.();
      } catch {
        /* ignore */
      }
    };
  }, `${PLUGIN}: api`);

  ctx.effect(() => {
    state.stopped = false;
    resetRelayBreaker();
    state.relay.lastError = cfg.relayUrl && cfg.token ? null : 'relay not configured; set relayUrl/token';
    const loop = runRelayLoop();
    // Attach the guard immediately: dsh treats an unhandled rejection as fatal,
    // and this promise previously only got a handler on effect teardown.
    loop.catch((error) => log('relay loop stopped:', String(error?.message || error)));
    state.indexTimer = setInterval(() => {
      pushIndex().catch(() => {});
    }, cfg.indexMs);
    const refreshTimer = setInterval(() => {
      refreshPeers().catch(() => {});
    }, Math.max(10000, cfg.indexMs));

    let debounce = null;
    const bump = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        pushIndex().catch(() => {});
      }, 2500);
    };
    const events = ['api-session/added', 'api-session/removed', 'api-session/status', 'api-session/activity'];
    const offs = [];
    for (const eventName of events) {
      try {
        offs.push(ctx.on(eventName, bump));
      } catch {
        /* event not declared in this composition */
      }
    }

    return () => {
      state.stopped = true;
      state.wakeRelay?.();
      if (state.indexTimer) clearInterval(state.indexTimer);
      clearInterval(refreshTimer);
      if (debounce) clearTimeout(debounce);
      for (const off of offs) {
        try {
          off?.();
        } catch {
          /* ignore */
        }
      }
      try {
        state.abort?.abort();
      } catch {
        /* ignore */
      }
      for (const waiter of state.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('plugin disposed'));
      }
      state.pending.clear();
      state.relay.connected = false;
      loop.catch(() => {});
    };
  }, `${PLUGIN}: relay`);

  if (!cfg.relayUrl || !cfg.token) {
    log('relay not configured; set relayUrl/token in cordis.patch.yml (or DSH_RELAY_URL / DSH_RELAY_TOKEN)');
  } else {
    log(`loaded for ${cfg.instanceId} (${cfg.instanceName}) -> ${cfg.relayUrl}; dshHome=${dshHome}`);
  }
}
