import { describe, expect, it, vi } from 'vitest'
import {
  createHostRestartController,
  HostRestartError,
  systemdUnitFromCgroup,
} from '../src/host-restart.js'

function linuxInput(overrides: {
  cgroup?: string
  systemdPresent?: boolean
} = {}) {
  return {
    platform: 'linux' as const,
    readFile: (path: string) => path === '/proc/self/cgroup' ? (overrides.cgroup ?? '') : undefined,
    pathExists: () => overrides.systemdPresent ?? true,
  }
}

describe('host restart controller', () => {
  it('reads the owning systemd unit from cgroup v1 and v2 layouts', () => {
    expect(systemdUnitFromCgroup('0::/system.slice/dsh-cloud.service')).toBe('dsh-cloud.service')
    expect(systemdUnitFromCgroup('11:name=systemd:/system.slice/remote-session-plugin-web.service'))
      .toBe('remote-session-plugin-web.service')
    expect(systemdUnitFromCgroup('0::/system.slice/dsh-cloud.service/child')).toBe('dsh-cloud.service')
    // User-scope units and containers have no system-scope owner here.
    expect(systemdUnitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/host.service'))
      .toBeUndefined()
    expect(systemdUnitFromCgroup('0::/')).toBeUndefined()
    expect(systemdUnitFromCgroup('0::/docker/abc123')).toBeUndefined()
    expect(systemdUnitFromCgroup('0::/system.slice/not-a-unit')).toBeUndefined()
  })

  it('schedules a systemd service restart and only uses the parsed unit', async () => {
    const spawned: Array<{ command: string; args: readonly string[] }> = []
    const timers: Array<() => void> = []
    const controller = createHostRestartController({
      ...linuxInput({ cgroup: '0::/system.slice/dsh-cloud.service' }),
      spawnProcess: (command, args) => spawned.push({ command, args }),
      setTimer: callback => { timers.push(callback) },
    })

    expect(controller.supported).toBe(true)
    await expect(controller.restart()).resolves.toEqual({ supervisor: 'systemd' })
    // The reply path stays clear: nothing runs until the armed delay elapses.
    expect(spawned).toHaveLength(0)
    timers.forEach(callback => callback())
    expect(spawned).toEqual([{ command: 'systemctl', args: ['restart', 'dsh-cloud.service'] }])
  })

  it('refuses to restart without a verifiable supervisor', async () => {
    const spawned = vi.fn()
    const noUnit = createHostRestartController({
      ...linuxInput({ cgroup: '0::/' }),
      spawnProcess: spawned,
    })
    const noSystemd = createHostRestartController({
      ...linuxInput({ cgroup: '0::/system.slice/dsh-cloud.service', systemdPresent: false }),
      spawnProcess: spawned,
    })
    const darwin = createHostRestartController({ platform: 'darwin', spawnProcess: spawned })

    for (const controller of [noUnit, noSystemd, darwin]) {
      expect(controller.supported).toBe(false)
      await expect(controller.restart()).rejects.toBeInstanceOf(HostRestartError)
      await expect(controller.restart()).rejects.toMatchObject({ code: 'RESTART_UNSUPPORTED' })
    }
    expect(spawned).not.toHaveBeenCalled()
  })

  it('relaunches only the DSH Desktop app on Windows', async () => {
    const spawned: Array<{ command: string; args: readonly string[] }> = []
    const timers: Array<() => void> = []
    const execPath = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'
    const controller = createHostRestartController({
      platform: 'win32',
      execPath,
      parentPid: 4242,
      electronVersion: '34.0.0',
      processType: undefined,
      spawnProcess: (command, args) => spawned.push({ command, args }),
      setTimer: callback => { timers.push(callback) },
    })

    expect(controller.supported).toBe(true)
    await expect(controller.restart()).resolves.toEqual({ supervisor: 'desktop' })
    timers.forEach(callback => callback())
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.command).toBe('cmd.exe')
    expect(spawned[0]!.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    const command = spawned[0]!.args[3]!
    expect(command).toContain('taskkill /PID 4242 /F')
    expect(command).toContain(`start "" "${execPath}"`)
  })

  it('does not treat a plain node Host or an unknown parent as a desktop relaunch', async () => {
    const spawned = vi.fn()
    const plainNode = createHostRestartController({
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      parentPid: 100,
      electronVersion: undefined,
      spawnProcess: spawned,
    })
    const renderer = createHostRestartController({
      platform: 'win32',
      execPath: 'C:\\Apps\\Harness.exe',
      parentPid: 100,
      electronVersion: '34.0.0',
      processType: 'renderer',
      spawnProcess: spawned,
    })
    const noParent = createHostRestartController({
      platform: 'win32',
      execPath: 'C:\\Apps\\Harness.exe',
      parentPid: 0,
      electronVersion: '34.0.0',
      spawnProcess: spawned,
    })

    for (const controller of [plainNode, renderer, noParent]) {
      expect(controller.supported).toBe(false)
      await expect(controller.restart()).rejects.toMatchObject({ code: 'RESTART_UNSUPPORTED' })
    }
    expect(spawned).not.toHaveBeenCalled()
  })
})
