import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayServer } from '../gateway/server.mjs';
import { AgentGateway } from '../gateway/core.mjs';
import { CodexAdapter } from '../gateway/process-adapters.mjs';
import { Workbench, validateHost } from '../lib/workbench.js';

const token = 'fixture-token-'.repeat(4);
const fixture = fileURLToPath(new URL('./fixtures/agent-process.mjs', import.meta.url));
async function setup(t, kind = 'codex') {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-test-'));
  const config = { id: 'test-node', name: 'Test', port: 0, host: '127.0.0.1', stateFile: path.join(home, 'sessions.json'), workspaces: [{ id: 'project', path: home }], agents: { agent: { kind, command: process.execPath, args: [fixture, kind], env: { FIXTURE_WORKSPACE: home } } } };
  const service = await createGatewayServer(config, token);
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + service.server.address().port;
  t.after(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });
  const raw = async (body, headers = {}) => {
    const response = await fetch(base + '/v1/call', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const call = async (method, params) => { const body = await raw({ method, params }); if (!body.ok) throw Object.assign(new Error(body.error.message), { code: body.error.code }); return body.result; };
  return { service, home, config, base, raw, call };
}
async function until(task, predicate) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { const value = await task(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Fixture did not reach expected state');
}

test('gateway requires authentication, rejects browser Origins and invalid requests', async t => {
  const { raw, call } = await setup(t);
  assert.equal((await raw({ method: 'node.describe' }, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await raw({ method: 'node.describe' }, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await raw(null)).status, 400);
  assert.equal((await call('node.describe')).protocol, 1);
  await assert.rejects(call('shell.execute', {}), { code: 'METHOD_NOT_FOUND' });
  await assert.rejects(call('sessions.create', { agentId: 'agent', workspaceId: '../../' }), { code: 'WORKSPACE_NOT_FOUND' });
});

for (const kind of ['codex', 'opencode']) test(`${kind}: native process history, streaming, one-time approvals, busy guards and cancellation`, async t => {
  const { call, home } = await setup(t, kind);
  const list = await call('sessions.list', { agentId: 'agent', workspaceId: 'project' });
  assert.equal(list.sessions.length, 1);
  const history = await call('sessions.read', { sessionId: list.sessions[0].id });
  assert.equal(history.messages.at(-1).text, 'History answer');
  const created = await call('sessions.create', { agentId: 'agent', workspaceId: 'project' });
  const params = { sessionId: created.id };
  await call('sessions.prompt', { ...params, text: 'Test prompt' });
  let snapshot = await until(() => call('sessions.read', params), value => value.approvals.length === 1);
  assert.equal(snapshot.messages.at(-1).text, 'Hello world');
  assert.equal(snapshot.messages[0].text, 'Test prompt');
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.approvals[0].requestId, undefined);
  await assert.rejects(call('sessions.prompt', { ...params, text: 'Duplicate' }), { code: 'SESSION_BUSY' });
  const approvalId = snapshot.approvals[0].id;
  await assert.rejects(call('sessions.approve', { sessionId: history.id, approvalId, decision: 'allow' }), { code: 'APPROVAL_EXPIRED' });
  const outcomes = await Promise.allSettled([1, 2].map(() => call('sessions.approve', { ...params, approvalId, decision: 'allow' })));
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  snapshot = await until(() => call('sessions.read', params), value => !value.running);
  const watching = (await setupWatch(snapshot, params, call));
  assert.ok(watching);
  await call('sessions.prompt', { ...params, text: 'Second turn' });
  await until(() => call('sessions.read', params), value => value.approvals.length === 1);
  await call('sessions.cancel', params);
  snapshot = await until(() => call('sessions.read', params), value => !value.running);
  assert.equal(snapshot.approvals.length, 0);
  assert.equal(snapshot.messages.filter(item => item.role === 'assistant').length, 2);
  const persisted = await readFile(path.join(home, 'sessions.json'), 'utf8');
  assert.ok(!persisted.includes('Test prompt') && !persisted.includes(token));
});
async function setupWatch(snapshot, params, call) {
  // An old cursor/epoch returns immediately, including a full current projection.
  return call('sessions.watch', { ...params, epoch: 'old-process', after: snapshot.cursor });
}

test('desktop persists private credentials and forwards only saved hosts', async t => {
  const { base, home } = await setup(t);
  const wb = new Workbench(home); t.after(() => wb.dispose());
  let result = await wb.route('save', { name: 'Machine', mode: 'direct', url: base, token });
  const id = result.hosts[0].id;
  assert.equal(result.hosts[0].token, undefined);
  assert.equal((await wb.route('connect', { id })).node.id, 'test-node');
  assert.equal((await wb.route('call', { id, method: 'node.describe' })).result.id, 'test-node');
  await wb.route('save', { id, name: 'Renamed', mode: 'direct', url: base, token: '' });
  assert.equal((await wb.hosts())[0].token, token);
  await assert.rejects(wb.route('call', { id: 'unknown', url: base, method: 'node.describe' }));
  assert.throws(() => validateHost({ name: 'Bad', mode: 'ssh', target: '-oProxyCommand=bad', token }));
  assert.throws(() => validateHost({ name: 'Bad', mode: 'direct', url: 'http://user:secret@example.com/', token }));
  await wb.route('remove', { id }); assert.equal((await wb.hosts()).length, 0);
});

test('session identity survives a gateway restart without copying conversations', async t => {
  const { config, call } = await setup(t);
  const created = await call('sessions.create', { agentId: 'agent', workspaceId: 'project' });
  const second = new AgentGateway(config, new Map([['agent', new CodexAdapter('agent', config.agents.agent)]]));
  t.after(() => second.close()); await second.initialize();
  const restored = await second.call('sessions.read', { sessionId: created.id });
  assert.equal(restored.id, created.id);
  assert.equal(restored.messages.at(-1).text, 'History answer');
  assert.notEqual(restored.epoch, created.epoch);
});

test('watch wakes on updates and releases its waiter on abort', async t => {
  const { service, call } = await setup(t);
  const created = await call('sessions.create', { agentId: 'agent', workspaceId: 'project' });
  const gateway = service.gateway, controller = new AbortController();
  const params = { sessionId: created.id, epoch: created.epoch, after: created.cursor };
  const first = gateway.call('sessions.watch', params, controller.signal);
  await until(async () => gateway.waiters.size, size => size === 1);
  controller.abort(); await first;
  assert.equal(gateway.waiters.size, 0);
  const second = gateway.call('sessions.watch', params);
  await until(async () => gateway.waiters.size, size => size === 1);
  gateway.message(gateway.session(created.id), 'assistant', 'External update');
  assert.equal((await second).messages.at(-1).text, 'External update');
  assert.equal(gateway.waiters.size, 0);
});
