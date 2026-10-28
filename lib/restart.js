import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const helperFile = fileURLToPath(new URL('./restart-helper.cjs', import.meta.url));
const bootId = randomUUID();

function unavailable(message) { return Object.assign(new Error(message), { status: 409 }); }
function systemdTarget(cgroup) {
  const units = cgroup.split('/');
  const service = units.at(-1);
  if (!/^[\w][\w@.\\:-]*\.service$/.test(service) || /^user@\d+\.service$/.test(service)) return null;
  return { service, user: units.some(part => /^user@\d+\.service$/.test(part)) };
}

/** Select only from startup facts on the target; clients never supply commands. */
export function restartPlan(facts) {
  const { runtime, platform, env, pid, ppid, execPath, argv, execArgv, cwd, connected, cgroup = '', exists = fs.existsSync } = facts;
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw unavailable('当前系统暂不支持自动重启 DSH');
  if (runtime === 'desktop') {
    if (!facts.canExit || !connected || !/[/\\]dsh-desktop-host[/\\]lib[/\\]index\.js$/.test(argv[1] || '') || ppid <= 1) {
      throw unavailable('未识别到桌面应用主进程，请从 DSH 应用菜单重启');
    }
    return { kind: 'desktop', platform, pid, mainPid: ppid, mainExecPath: execPath, execPath: env.APPIMAGE || execPath, args: [], cwd, env };
  }
  if (/^\d+$/.test(env.pm_id || '')) {
    const cli = path.join(path.dirname(argv[1] || ''), 'binaries/CLI.js');
    if (!exists(cli)) throw unavailable('无法定位 PM2 管理入口，请通过 PM2 重启此实例');
    return { kind: 'pm2', command: execPath, args: [cli, 'restart', env.pm_id] };
  }
  if (platform === 'linux') {
    const target = systemdTarget(cgroup);
    if (target && facts.systemdMainPid === pid) {
      return { kind: 'systemd', command: 'systemctl', args: [...target.user ? ['--user'] : [], '--no-block', 'restart', target.service] };
    }
    if (pid === 1 || exists('/.dockerenv') || exists('/run/.containerenv')) {
      throw unavailable('容器实例需通过容器管理器重启');
    }
  }
  if (platform === 'darwin' && env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== '0' && facts.launchdPid === pid) {
    const domain = facts.uid === 0 ? 'system' : `gui/${facts.uid}`;
    return { kind: 'launchd', command: 'launchctl', args: ['kickstart', '-k', `${domain}/${env.XPC_SERVICE_NAME}`] };
  }
  if (!facts.canExit || !argv[1] || !path.isAbsolute(argv[1]) || !exists(argv[1])) {
    throw unavailable('无法确认 DSH 启动入口，请使用原启动方式重启');
  }
  if (env.SERVICE_NAME || env.WINSW_EXECUTABLE || env.SUPERVISOR_ENABLED) {
    throw unavailable('此实例由外部服务托管，请通过对应服务管理器重启');
  }
  return { kind: 'process', platform, pid, execPath, args: [...execArgv, ...argv.slice(1)], cwd, env };
}

export class RestartController {
  constructor(ctx, runtime) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.pending = null;
    this.error = null;
    this.stopped = false;
  }
  plan() {
    if (this.cachedPlan) return this.cachedPlan;
    let cgroup = '';
    if (process.platform === 'linux') {
      try { cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').map(line => line.split(':').slice(2).join(':')).join('/'); } catch { /* no systemd */ }
    }
    const facts = {
      runtime: this.runtime, platform: process.platform, env: { ...process.env },
      pid: process.pid, ppid: process.ppid, execPath: process.execPath,
      argv: process.argv, execArgv: process.execArgv, cwd: process.cwd(),
      connected: process.connected, cgroup, uid: process.getuid?.(),
      canExit: typeof this.ctx.get('appExit') === 'function',
    };
    // A shell can inherit its parent's service environment. Only restart a
    // supervisor unit when this DSH process is that unit's actual main process.
    if (this.runtime !== 'desktop' && process.platform === 'linux' && !process.env.pm_id) {
      const target = systemdTarget(cgroup);
      if (target) {
        try { facts.systemdMainPid = Number(execFileSync('systemctl', [...target.user ? ['--user'] : [], 'show', '--property=MainPID', '--value', target.service], { timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { /* not owned */ }
      }
    }
    if (this.runtime !== 'desktop' && process.platform === 'darwin' && process.env.XPC_SERVICE_NAME) {
      const domain = facts.uid === 0 ? 'system' : `gui/${facts.uid}`;
      try {
        const details = execFileSync('launchctl', ['print', `${domain}/${process.env.XPC_SERVICE_NAME}`], { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        facts.launchdPid = Number(details.match(/^\s*pid = (\d+)/m)?.[1]);
      } catch { /* not owned */ }
    }
    return this.cachedPlan = restartPlan(facts);
  }
  status() {
    let plan, reason = null;
    try { plan = this.plan(); } catch (error) { reason = error.message; }
    return { supported: !!plan, strategy: plan?.kind || null, reason, bootId,
      state: this.error ? 'failed' : this.pending ? 'restarting' : 'idle', error: this.error };
  }
  async prepare() {
    if (this.stopped) throw unavailable('DSH 正在关闭');
    if (this.pending) { await this.pending.ready; return this.pending; }
    const plan = this.plan();
    this.error = null;
    const child = spawn(process.execPath, [helperFile], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ...process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} },
    });
    const job = { child, committed: false, bootId, ready: null, timer: null };
    this.pending = job;
    child.on('error', () => this.fail(job, '无法启动 DSH 重启进程'));
    child.on('exit', code => { if (code !== 0) this.fail(job, 'DSH 重启进程异常退出'); });
    child.on('message', message => {
      if (message.type === 'stop') {
        const exit = this.ctx.get('appExit');
        if (typeof exit === 'function') exit(0);
        else this.fail(job, 'DSH 关闭接口不可用');
      }
      if (message.type === 'failed') this.fail(job, message.error);
    });
    job.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(unavailable('重启进程准备超时')), 10000);
      const onMessage = message => {
        if (message.type === 'ready') { clearTimeout(timer); child.off('message', onMessage); resolve(); }
        if (message.type === 'failed') { clearTimeout(timer); reject(unavailable(message.error)); }
      };
      child.on('message', onMessage);
      child.once('error', () => { clearTimeout(timer); reject(unavailable('无法启动 DSH 重启进程')); });
      child.send({ type: 'prepare', plan }, error => { if (error) { clearTimeout(timer); reject(unavailable('重启进程连接失败')); } });
    });
    try { await job.ready; } catch (error) { this.fail(job, error.message); throw error; }
    job.timer = setTimeout(() => { if (!job.committed) this.fail(job, '重启请求未确认，请重试'); }, 15000);
    child.unref();
    child.channel?.unref();
    return job;
  }
  commit(job) {
    if (job !== this.pending || job.committed || this.stopped) return;
    job.committed = true;
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      job.child.send({ type: 'commit' }, error => { if (error) this.fail(job, '重启进程连接已断开'); });
      job.timer = setTimeout(() => this.fail(job, 'DSH 未在预期时间内重启，请检查服务管理器'), 80000);
    }, 750);
  }
  fail(job, error) {
    if (this.pending !== job) return;
    clearTimeout(job.timer);
    this.pending = null;
    this.error = error || '重启失败';
    if (job.child.connected) job.child.disconnect();
    job.child.kill();
  }
  dispose() {
    this.stopped = true;
    if (this.pending?.committed) clearTimeout(this.pending.timer);
    if (this.pending && !this.pending.committed) this.fail(this.pending, 'DSH 正在关闭');
  }
}
