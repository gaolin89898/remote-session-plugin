const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

let plan;
let committed = false;
const deadline = setTimeout(() => process.exit(1), 30000);
const send = message => { if (process.connected) process.send(message, () => {}); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const output = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
});

async function verifyDesktop() {
  let executable;
  if (plan.platform === 'win32') executable = await output('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(plan.mainPid)} -ErrorAction Stop).Path`]);
  else if (plan.platform === 'linux') executable = fs.readlinkSync(`/proc/${plan.mainPid}/exe`);
  else executable = await output('ps', ['-p', String(plan.mainPid), '-o', 'comm=']);
  const normalize = value => plan.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(executable) !== normalize(plan.mainExecPath)) throw new Error('桌面主进程身份已变化，已取消重启');
}

async function waitForExit(pid) {
  const until = Date.now() + 20000;
  while (alive(pid)) {
    if (Date.now() >= until) throw new Error('DSH 未能及时退出，已取消启动新实例');
    await sleep(200);
  }
}

function command(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('服务管理器不可用')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`服务重启命令失败（退出码 ${code}）`)));
  });
}

async function restart() {
  if (!['desktop', 'process'].includes(plan.kind)) {
    await command(plan.command, plan.args);
    return;
  }
  if (!fs.existsSync(plan.execPath)) throw new Error('DSH 启动程序不存在，已取消重启');
  if (plan.kind === 'desktop') {
    await verifyDesktop();
    if (plan.platform === 'win32') await command('taskkill.exe', ['/PID', String(plan.mainPid), '/F']);
    else process.kill(plan.mainPid, 'SIGTERM');
    await waitForExit(plan.mainPid);
  }
  // Ask the Host's bounded shutdown controller to flush and release its locks.
  send({ type: 'stop' });
  await waitForExit(plan.pid);
  const env = { ...plan.env };
  if (plan.kind === 'desktop') {
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
  }
  await new Promise((resolve, reject) => {
    const child = spawn(plan.execPath, plan.args, { cwd: plan.cwd, env, detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('无法重新启动 DSH')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

process.on('message', async message => {
  if (message.type === 'prepare' && !plan) {
    plan = message.plan;
    try {
      if (plan.kind === 'desktop') await verifyDesktop();
      send({ type: 'ready' });
    } catch { send({ type: 'failed', error: '无法验证桌面应用主进程，已取消重启' }); }
  }
  if (message.type !== 'commit' || !plan || committed) return;
  committed = true;
  clearTimeout(deadline);
  restart().then(() => process.exit(0), error => {
    send({ type: 'failed', error: error.message });
    setTimeout(() => process.exit(1), 100);
  });
});
process.on('disconnect', () => { if (!committed) process.exit(0); });
