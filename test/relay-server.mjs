import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = await mkdtemp(path.join(os.tmpdir(), 'dsh-relay-test-'));
const tokenFile = path.join(work, 'token');
const token = randomBytes(32).toString('hex');
await writeFile(tokenFile, token, { mode: 0o600 });

const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));

const child = spawn(process.execPath, [process.env.DSH_RELAY_TEST_SERVER || path.join(root, 'relay/server.cjs')], {
  env: { ...process.env, TOKEN_FILE: tokenFile, PORT: String(port) },
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${port}`;

async function requestReady(url, options) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`relay exited with status ${child.exitCode}`);
    try { return await fetch(url, { ...options, signal: AbortSignal.timeout(1000) }); } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('relay did not start in time');
}

async function post(pathname, body) {
  return requestReady(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

try {
  const health = await requestReady(`${base}/health`);
  assert.deepEqual(await health.json(), { ok: true });

  const registered = await post('/v1/register', { token, id: 'home', name: 'Home', sessions: [] });
  assert.equal(registered.status, 200);

  for (const [query, headers] of [['', { authorization: `Bearer ${token}` }], [`&token=${encodeURIComponent(token)}`, {}]]) {
    const stream = await requestReady(`${base}/v1/stream?id=home${query}`, { headers });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    try {
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /event: ready/);
      const peers = await post('/v1/peers', { token, id: 'office' });
      assert.equal((await peers.json()).peers[0].online, true);
      assert.deepEqual(await (await requestReady(`${base}/health`)).json(), { ok: true });
    } finally {
      await reader.cancel();
    }
  }
  for (const [query, headers] of [
    ['', {}], ['', { authorization: 'Bearer wrong' }],
    [`&token=${encodeURIComponent(token)}`, { authorization: 'Bearer wrong' }],
    [`&token=${encodeURIComponent(token)}`, { authorization: 'Basic invalid' }],
  ]) {
    const rejected = await requestReady(`${base}/v1/stream?id=home${query}`, { headers });
    assert.equal(rejected.status, 401);
  }

  const rejected = await post('/v1/register', { token: 'wrong', id: 'attacker' });
  assert.equal(rejected.status, 401);
  console.log('PASS relay health privacy, Bearer auth, legacy clients, and invalid credential rejection');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
  await rm(work, { recursive: true, force: true });
}
