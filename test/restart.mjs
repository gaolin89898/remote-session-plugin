import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restartPlan } from '../lib/restart.js';

function facts(overrides = {}) {
  return { runtime: 'web', platform: 'linux', env: {}, pid: 123, ppid: 122,
    execPath: '/opt/node', argv: ['/opt/node', '/opt/dsh/cli.js', '--profile', 'web', '--port', '3300'],
    execArgv: ['--expose-internals'], cwd: '/opt/dsh', canExit: true, connected: false,
    exists: file => file !== '/.dockerenv' && file !== '/run/.containerenv', systemdMainPid: 123, launchdPid: 123, ...overrides };
}

test('Web restarts preserve the executable, arguments, home and environment across supported systems', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const input = facts({ platform, env: { DSH_HOME: '/home/fixture', ELECTRON_RUN_AS_NODE: '1' } });
    const plan = restartPlan(input);
    assert.equal(plan.kind, 'process');
    assert.equal(plan.execPath, input.execPath);
    assert.deepEqual(plan.args, [...input.execArgv, ...input.argv.slice(1)]);
    assert.deepEqual(plan.env, input.env);
    assert.equal(plan.pid, input.pid);
  }
});

test('Desktop restarts target the owned application main process and do not reuse Host CLI arguments', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const plan = restartPlan(facts({ runtime: 'desktop', platform, connected: true,
      argv: ['/app/dsh', '/app/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js', '/runtime', '/profile'] }));
    assert.equal(plan.kind, 'desktop');
    assert.equal(plan.mainPid, 122);
    assert.deepEqual(plan.args, []);
  }
  assert.throws(() => restartPlan(facts({ runtime: 'desktop' })), /未识别到桌面应用主进程/);
  assert.throws(() => restartPlan(facts({ runtime: 'desktop', connected: true, canExit: false })), /未识别/);
});

test('systemd, user services, PM2 and launchd use their own supervisor', () => {
  assert.deepEqual(restartPlan(facts({ cgroup: '/system.slice/dsh-web.service' })), {
    kind: 'systemd', command: 'systemctl', args: ['--no-block', 'restart', 'dsh-web.service'],
  });
  assert.deepEqual(restartPlan(facts({ cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/dsh.service' })), {
    kind: 'systemd', command: 'systemctl', args: ['--user', '--no-block', 'restart', 'dsh.service'],
  });
  assert.equal(restartPlan(facts({ cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/session.scope' })).kind, 'process');
  assert.equal(restartPlan(facts({ cgroup: '/system.slice/ssh.service', systemdMainPid: 100 })).kind, 'process');
  assert.equal(restartPlan(facts({ platform: 'darwin', uid: 501, env: { XPC_SERVICE_NAME: 'com.apple.Terminal' }, launchdPid: 100 })).kind, 'process');
  assert.deepEqual(restartPlan(facts({ env: { pm_id: '2' }, argv: ['/opt/node', '/opt/pm2/lib/ProcessContainerFork.js'] })), {
    kind: 'pm2', command: '/opt/node', args: [path.join('/opt/pm2/lib', 'binaries/CLI.js'), 'restart', '2'],
  });
  assert.deepEqual(restartPlan(facts({ platform: 'darwin', uid: 501, env: { XPC_SERVICE_NAME: 'com.example.dsh' } })), {
    kind: 'launchd', command: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.example.dsh'],
  });
});

test('unmanaged containers, unknown service wrappers and missing startup facts fail before stopping anything', () => {
  assert.throws(() => restartPlan(facts({ pid: 1 })), /容器/);
  assert.throws(() => restartPlan(facts({ env: { SERVICE_NAME: 'DSH' } })), /外部服务/);
  assert.throws(() => restartPlan(facts({ canExit: false })), /启动入口/);
  assert.throws(() => restartPlan(facts({ argv: [] })), /启动入口/);
  assert.throws(() => restartPlan(facts({ platform: 'freebsd' })), /暂不支持/);
});

async function verifyRealRestart(t, desktop = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-restart-test-'));
  const stateFile = path.join(directory, 'state.json');
  const fixture = fileURLToPath(new URL(desktop ? './fixtures/restart-desktop.mjs' : './fixtures/restart-host.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixture, stateFile], { windowsHide: true, stdio: 'ignore' });
  const pids = new Set();
  child.on('error', () => {});
  t.after(async () => {
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      pids.add(state.pid);
      if (state.mainPid) pids.add(state.mainPid);
    } catch { /* not started */ }
    if (child.pid) pids.add(child.pid);
    for (const pid of pids) { try { process.kill(pid); } catch { /* exited */ } }
    await rm(directory, { recursive: true, force: true });
  });
  const until = async check => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { const result = await check(); if (result) return result; } catch { /* restart gap */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Restart fixture did not become ready');
  };
  const before = await until(async () => JSON.parse(await readFile(stateFile, 'utf8')));
  pids.add(before.pid);
  if (before.mainPid) pids.add(before.mainPid);
  const url = `http://127.0.0.1:${before.port}`;
  const [first, duplicate] = await Promise.all([fetch(url + '/restart', { method: 'POST' }), fetch(url + '/restart', { method: 'POST' })]);
  const started = await first.json();
  assert.deepEqual(await duplicate.json(), started);
  assert.equal(started.state, 'restarting');
  const after = await until(async () => {
    const response = await fetch(url + '/status', { signal: AbortSignal.timeout(1000) });
    const status = await response.json();
    return status.bootId !== started.bootId ? status : null;
  });
  pids.add(after.pid);
  if (after.mainPid) { pids.add(after.mainPid); assert.notEqual(after.mainPid, before.mainPid); }
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.state, 'idle');
  assert.equal(after.port, before.port);
}

test('a real isolated Web process acknowledges once, exits and starts again on its original port', { timeout: 30000 }, t => verifyRealRestart(t));
test('desktop restart verifies and replaces its isolated main process and Host', { timeout: 30000 }, t => verifyRealRestart(t, true));
