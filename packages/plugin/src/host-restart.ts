import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export type HostRestartSupervisor = 'systemd' | 'desktop'

/**
 * The restarter never invents a supervisor. It only restarts the process when
 * the current platform gives it a fixed, verifiable owner (a systemd service
 * unit or the DSH Desktop shell that spawned this Host). Everything else is
 * reported as unsupported instead of guessing a command.
 */
export class HostRestartError extends Error {
  constructor(readonly code: 'RESTART_UNSUPPORTED', message: string) {
    super(message)
    this.name = 'HostRestartError'
  }
}

export interface HostRestartController {
  readonly supported: boolean
  /** Arm the restart; resolves once the command is scheduled, not when it ran. */
  restart(): Promise<{ supervisor: HostRestartSupervisor }>
}

export interface HostRestartOptions {
  platform?: NodeJS.Platform
  execPath?: string
  parentPid?: number
  electronVersion?: string
  processType?: string
  readFile?: (path: string) => string | undefined
  pathExists?: (path: string) => boolean
  spawnProcess?: (command: string, args: readonly string[]) => void
  armDelayMs?: number
  setTimer?: (callback: () => void, ms: number) => unknown
}

// Matches a system-scope systemd service unit in a cgroup path, e.g.
// `0::/system.slice/dsh-cloud.service` or
// `11:name=systemd:/system.slice/remote-session-plugin-web.service`. User-scope
// units need a different bus (`systemctl --user`) and are rejected instead of
// being restarted in the wrong scope.
const SYSTEMD_SERVICE_UNIT = /\/system\.slice\/([A-Za-z0-9:_.@-]+\.service)(?:\/|\s|$)/

/** Extract the systemd service unit that owns this process from a cgroup file. */
export function systemdUnitFromCgroup(cgroup: string): string | undefined {
  return SYSTEMD_SERVICE_UNIT.exec(cgroup)?.[1]
}

interface DetectedSupervisor {
  kind: HostRestartSupervisor
  restart(): void
}

export function createHostRestartController(options: HostRestartOptions = {}): HostRestartController {
  const platform = options.platform ?? process.platform
  const readFile = options.readFile ?? ((path: string) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  })
  const pathExists = options.pathExists ?? existsSync
  const spawnProcess = options.spawnProcess ?? ((command, args) => {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  })
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  // The RPC reply must reach the requesting Client before the process goes
  // away; the delay only covers that write, never a business decision.
  const armDelayMs = options.armDelayMs ?? 1_500
  const supervisor = detectSupervisor({
    platform,
    execPath: options.execPath ?? process.execPath,
    parentPid: options.parentPid ?? process.ppid,
    electronVersion: options.electronVersion ?? process.versions.electron,
    processType: options.processType ?? (process as { type?: string }).type,
    readFile,
    pathExists,
    spawnProcess,
  })
  if (supervisor === undefined) {
    return {
      supported: false,
      restart: async () => {
        throw new HostRestartError(
          'RESTART_UNSUPPORTED',
          platform === 'linux'
            ? 'This Host is not managed by a systemd service, so it cannot restart itself.'
            : platform === 'win32'
              ? 'This Host is not the DSH Desktop app, so it cannot relaunch itself.'
              : 'Restarting the Harness is not supported on this platform.',
        )
      },
    }
  }
  return {
    supported: true,
    async restart() {
      setTimer(() => {
        try {
          supervisor.restart()
        } catch {
          // The process may already be exiting; the supervisor owns recovery.
        }
      }, armDelayMs)
      return { supervisor: supervisor.kind }
    },
  }
}

function detectSupervisor(input: {
  platform: NodeJS.Platform
  execPath: string
  parentPid: number
  electronVersion: string | undefined
  processType: string | undefined
  readFile: (path: string) => string | undefined
  pathExists: (path: string) => boolean
  spawnProcess: (command: string, args: readonly string[]) => void
}): DetectedSupervisor | undefined {
  if (input.platform === 'linux') {
    if (!input.pathExists('/run/systemd/system')) return undefined
    const unit = systemdUnitFromCgroup(input.readFile('/proc/self/cgroup') ?? '')
    if (unit === undefined) return undefined
    // Only the unit name parsed from the kernel-provided cgroup path is used;
    // no Client input reaches this command.
    return { kind: 'systemd', restart: () => input.spawnProcess('systemctl', ['restart', unit]) }
  }
  if (input.platform === 'win32') {
    // DSH Desktop runs the Host as an Electron child process. Restarting means
    // closing the shell (its IPC disconnect stops this Host) and starting the
    // same executable again. A plain `dsh` CLI process has no relauncher.
    if (input.electronVersion === undefined || input.processType !== undefined) return undefined
    if (!/\.exe$/i.test(input.execPath)) return undefined
    if (!Number.isSafeInteger(input.parentPid) || input.parentPid <= 0) return undefined
    const command = [
      'timeout /t 2 /nobreak >nul',
      `taskkill /PID ${String(input.parentPid)} /F >nul 2>&1`,
      'ping -n 4 127.0.0.1 >nul',
      `start "" "${input.execPath}"`,
    ].join(' & ')
    return { kind: 'desktop', restart: () => input.spawnProcess('cmd.exe', ['/d', '/s', '/c', command]) }
  }
  return undefined
}
