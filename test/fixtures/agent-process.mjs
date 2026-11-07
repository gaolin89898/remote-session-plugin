import readline from 'node:readline';
const kind = process.argv[2], cwd = process.env.FIXTURE_WORKSPACE;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => out({ method, params });
const pending = new Map(); let index = 0, turnIndex = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line), p = m.params || {};
  const answer = result => out({ id: m.id, result });
  if (!m.method) {
    const active = pending.get(m.id); if (!active) continue;
    pending.delete(m.id);
    if (kind === 'codex') notify('turn/completed', { threadId: active.sessionId, turn: { id: 't1', status: 'completed', error: null } });
    else out({ id: active.promptId, result: { stopReason: 'end_turn' } });
    continue;
  }
  if (m.method === 'initialize') { answer(kind === 'codex' ? { userAgent: 'fixture' } : { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } }); continue; }
  if (m.method === 'initialized') continue;
  if (m.method === 'thread/list') answer({ data: [{ id: 'existing', cwd, preview: 'History' }, { id: 'foreign', cwd: process.env.TEMP, preview: 'Other workspace' }] });
  else if (m.method === 'thread/start') answer({ thread: { id: 'new-' + ++index, cwd: p.cwd } });
  else if (m.method === 'thread/read' || m.method === 'thread/resume') answer({ thread: { id: p.threadId, cwd, turns: [{ items: [{ type: 'userMessage', id: 'u0', content: [{ type: 'text', text: 'History prompt' }] }, { type: 'agentMessage', id: 'a0', text: 'History answer' }] }] } });
  else if (m.method === 'turn/start') {
    turnIndex++;
    answer({ turn: { id: 't1' } });
    notify('turn/started', { threadId: p.threadId, turn: { id: 't1' } });
    notify('item/agentMessage/delta', { threadId: p.threadId, itemId: 'reply-' + turnIndex, delta: 'Hello ' });
    notify('item/agentMessage/delta', { threadId: p.threadId, itemId: 'reply-' + turnIndex, delta: 'world' });
    pending.set('approval-1', { sessionId: p.threadId });
    out({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: p.threadId, command: 'fixture-tool' } });
  } else if (m.method === 'turn/interrupt') { answer({}); notify('turn/completed', { threadId: p.threadId, turn: { id: 't1', status: 'interrupted' } }); }
  else if (m.method === 'session/list') answer({ sessions: [{ sessionId: 'existing', cwd, title: 'History' }] });
  else if (m.method === 'session/new') answer({ sessionId: 'new-' + ++index });
  else if (m.method === 'session/load') { notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'History answer' } } }); answer({}); }
  else if (m.method === 'session/prompt') {
    notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello world' } } });
    pending.set('approval-1', { sessionId: p.sessionId, promptId: m.id });
    out({ id: 'approval-1', method: 'session/request_permission', params: { sessionId: p.sessionId, toolCall: { title: 'fixture-tool' }, options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } });
  } else if (m.method === 'session/cancel') {
    for (const [id, value] of pending) if (value.sessionId === p.sessionId) { pending.delete(id); out({ id: value.promptId, result: { stopReason: 'cancelled' } }); }
  } else out({ id: m.id, error: { code: -32601, message: 'Unknown fixture method' } });
}
