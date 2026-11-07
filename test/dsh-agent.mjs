import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { AgentGateway } from '../gateway/core.mjs';
import { DshAdapter } from '../gateway/dsh-adapter.mjs';

test('stock DSH login, mux snapshots, live chunks, approvals and cancellation require no plugin', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-agent-fixture-'));
  const tokenFile = path.join(home, 'token'); await writeFile(tokenFile, 'node-local-dsh-token');
  let socket, eventsId, followId, seq = 0;
  const item = (streamId, value) => socket.send(JSON.stringify({ type: 'item', streamId, value }));
  const event = (type, data) => item(followId, { type: 'event', event: { type, seq: ++seq, time: Date.now(), data } });
  const outcomes = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      assert.equal(new URL(req.url, 'http://fixture').searchParams.get('token'), 'node-local-dsh-token');
      res.writeHead(302, { 'set-cookie': 'dsh=session-private; HttpOnly' }); res.end(); return;
    }
    assert.equal(req.headers.cookie, 'dsh=session-private');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); let value;
    if (body.method === 'session/list') value = { items: [{ sessionId: 'fixture-session', cwd: home, projections: { values: { title: 'DSH' } } }] };
    else if (body.method === 'session/create') value = { sessionId: 'fixture-session' };
    else if (body.method === 'session/prompt') {
      event('turn/start', {}); event('user/message', { content: body.payload.args.request.content });
      item(followId, { type: 'assistant-stream', frame: { type: 'chunk', revision: 2, attemptId: 'attempt', chunk: { type: 'text-delta', index: 0, text: 'Streaming reply' } } });
      event('tool/call', { name: 'read', callId: 'call', arguments: {} });
      item(eventsId, { type: 'waterfall', event: 'approval/request', agentId: 'fixture-session', eventId: 'approval', request: { toolName: 'read' } });
      value = {};
    } else if (body.method === '$events/result') { outcomes.push(body.payload.args.outcome); value = {}; }
    else if (body.method === 'session/cancel') { event('turn/end', { reason: { kind: 'cancelled' } }); value = {}; }
    else throw new Error('Unexpected DSH endpoint ' + body.method);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  const ws = new WebSocketServer({ server, path: '/api/remote.mux' });
  ws.on('connection', (connected, req) => {
    socket = connected; assert.equal(req.headers.cookie, 'dsh=session-private');
    socket.on('message', data => {
      const frame = JSON.parse(data);
      if (frame.type !== 'open') return;
      if (frame.endpoint === '$events') { eventsId = frame.streamId; item(eventsId, { type: 'ready', clientId: 'fixture-client' }); }
      else if (frame.endpoint === 'session/follow') {
        followId = frame.streamId;
        item(followId, { type: 'snapshot', header: { cwd: home }, records: [{ event: { type: 'assistant/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: 'Saved reply' }] } } }], assistantStream: { revision: 1 }, hasMore: false });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const adapter = new DshAdapter('dsh', { url: 'http://127.0.0.1:' + server.address().port, tokenFile });
  const gateway = new AgentGateway({ workspaces: [{ id: 'project', path: home }] }, new Map([['dsh', adapter]]));
  t.after(async () => { await gateway.close(); for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  await gateway.initialize();
  const listed = await gateway.call('sessions.list', { agentId: 'dsh', workspaceId: 'project' });
  const params = { sessionId: listed.sessions[0].id };
  assert.equal((await gateway.call('sessions.read', params)).messages[0].text, 'Saved reply');
  await gateway.call('sessions.prompt', { ...params, text: 'Hello' });
  let snapshot;
  const end = Date.now() + 3000;
  do { snapshot = await gateway.call('sessions.read', params); if (snapshot.approvals.length) break; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < end);
  assert.ok(snapshot.messages.some(message => message.text === 'Streaming reply'), 'tool events must preserve the live draft');
  assert.equal(snapshot.approvals[0].id, 'approval');
  await gateway.call('sessions.approve', { ...params, approvalId: 'approval', decision: 'reject' });
  assert.deepEqual(outcomes, [{ kind: 'result', value: 'rejected' }]);
  await gateway.call('sessions.cancel', params);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await gateway.call('sessions.read', params)).running, false);
  socket.terminate();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(adapter.status, 'unavailable');
});
