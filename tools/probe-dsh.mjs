import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentGateway } from '../gateway/core.mjs';
import { DshAdapter } from '../gateway/dsh-adapter.mjs';

// Windows desktop runtime, isolated profile, no plugin or model requests.
const desktop = process.env.DSH_DESKTOP || path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness');
const executable = path.join(desktop, 'DeepSeek Harness.exe');
const cli = path.join(desktop, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const home = await mkdtemp(path.join(os.tmpdir(), 'stock-dsh-probe-'));
let child, gateway;
try {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home };
  const prepared = spawnSync(executable, ['--expose-internals', cli, '--profile', 'agent-probe', '--from-default-profile', 'web', '--dump-default-config'], { env, cwd: home, windowsHide: true, timeout: 60000 });
  if (prepared.status !== 0) throw new Error('Could not prepare the isolated stock DSH profile.');
  child = spawn(executable, ['--expose-internals', cli, '--profile', 'agent-probe', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', data => { logs = (logs + data).slice(-100000); }); child.stderr.on('data', data => { logs = (logs + data).slice(-100000); });
  let url; const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Stock DSH exited before becoming ready.');
    const found = (logs.match(/https?:\/\/127\.0\.0\.1:\d+[^\s\u001b]*/g) || []).find(value => value.includes('token='));
    if (found) { url = new URL(found); break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!url) throw new Error('Stock DSH readiness timed out.');
  const tokenFile = path.join(home, 'dsh.token'); await writeFile(tokenFile, url.searchParams.get('token'), { mode: 0o600 });
  gateway = new AgentGateway({ workspaces: [{ id: 'probe', path: home }] }, new Map([['dsh', new DshAdapter('dsh', { url: url.origin, tokenFile })]]));
  await gateway.initialize();
  await gateway.call('sessions.list', { agentId: 'dsh', workspaceId: 'probe' });
  const created = await gateway.call('sessions.create', { agentId: 'dsh', workspaceId: 'probe' });
  const snapshot = await gateway.call('sessions.read', { sessionId: created.id });
  console.log(`stock DSH: ready, created and followed isolated session, messages=${snapshot.messages.length}`);
} catch (error) { console.error(`${error.code || 'PROBE_FAILED'}: ${error.message}`); process.exitCode = 1; }
finally {
  await gateway?.close();
  if (child && child.exitCode === null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit; }
  await rm(home, { recursive: true, force: true });
}
