import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ProcessRpc } from './process-rpc.mjs';
import { GatewayError, requireValue, textContent } from './core.mjs';

class ProcessAdapter {
  constructor(id, config) { this.id = id; this.config = config; this.name = config.name || id; this.status = 'configured'; }
  attach(gateway) { this.gateway = gateway; }
  start() {
    if (this.status === 'ready') return Promise.resolve();
    this.starting ??= this.initialize().then(() => { this.status = 'ready'; }, error => {
      this.status = 'unavailable'; this.rpc?.close(); throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  async process(args) {
    await this.rpc?.close();
    this.rpc = new ProcessRpc(this.config, args);
    this.rpc.on('message', message => {
      try { this.inbound(message); } catch { if (message.id !== undefined) { try { this.rpc.reject(message.id); } catch {} } }
    });
    this.rpc.on('unavailable', () => {
      this.status = 'unavailable';
      for (const session of this.gateway.sessions.values()) if (session.agentId === this.id) {
        session.hydrated = false; session.running = false; session.approvals = [];
        session.error = 'Agent process disconnected. Reopen the session to recover history.';
        this.gateway.changed(session);
      }
    });
    await this.rpc.start();
  }
  find(nativeId) { return [...this.gateway.sessions.values()].find(item => item.agentId === this.id && item.nativeId === nativeId); }
  async belongs(cwd, workspace) {
    try { return await realpath(cwd) === workspace.path; } catch { return false; }
  }
  finish(session, error) {
    session.running = false; session.approvals = [];
    if (error) session.error = String(error.message || error);
    this.gateway.changed(session);
  }
  async close() { await this.rpc?.close(); }
}

/** Native Codex App Server adapter. CLI credentials and threads stay on the node. */
export class CodexAdapter extends ProcessAdapter {
  kind = 'codex';
  capabilities = { history: true, streaming: true, cancel: true, approvals: true, files: false, terminal: false };
  async initialize() {
    await this.process(['app-server']);
    await this.rpc.call('initialize', { clientInfo: { name: 'dsh_agent_workbench', version: '1.2.6' }, capabilities: {} });
    this.rpc.notify('initialized', {});
  }
  async list(workspace) {
    let cursor;
    for (let page = 0; page < 100; page++) {
      const value = await this.rpc.call('thread/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const thread of value.data || []) if (await this.belongs(thread.cwd, workspace)) this.gateway.register(this.id, workspace.id, thread.id, thread.name || thread.preview);
      if (!value.nextCursor) return;
      requireValue(value.nextCursor !== cursor, 'INVALID_AGENT_RESPONSE', 'Agent returned a repeated list cursor.', 502);
      cursor = value.nextCursor;
    }
    throw new GatewayError('SESSION_LIST_LIMIT', 'Agent session listing exceeded 100 pages.', 502);
  }
  async create(workspace) {
    const result = await this.rpc.call('thread/start', { cwd: workspace.path, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    const session = this.gateway.register(this.id, workspace.id, result.thread.id, result.thread.name || 'Codex');
    session.hydrated = true;
    return session;
  }
  async read(session) {
    const history = await this.rpc.call('thread/read', { threadId: session.nativeId, includeTurns: true });
    requireValue(await this.belongs(history.thread.cwd, this.gateway.workspace(session.workspaceId)), 'SESSION_WORKSPACE_MISMATCH', 'Codex returned a different working directory.', 409);
    const result = await this.rpc.call('thread/resume', { threadId: session.nativeId, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    session.messages = [];
    for (const turn of history.thread.turns || result.thread.turns || []) for (const item of turn.items || []) {
      if (item.type === 'userMessage') this.gateway.message(session, 'user', textContent(item.content), item.id);
      else if (item.type === 'agentMessage') this.gateway.message(session, 'assistant', item.text, item.id);
      else if (item.type === 'commandExecution') this.gateway.message(session, 'tool', [item.command, item.aggregatedOutput].filter(Boolean).join('\n'), item.id);
      else if (item.type === 'fileChange') this.gateway.message(session, 'tool', JSON.stringify(item.changes || []), item.id);
    }
    session.error = null;
  }
  async prompt(session, text) {
    const userId = randomUUID();
    this.gateway.message(session, 'user', text, userId);
    const result = await this.rpc.call('turn/start', { threadId: session.nativeId, input: [{ type: 'text', text, text_elements: [] }] });
    session.turnId = result.turn.id;
  }
  async cancel(session) {
    requireValue(session.turnId, 'NO_ACTIVE_TURN', 'There is no active Codex turn.', 409);
    await this.rpc.call('turn/interrupt', { threadId: session.nativeId, turnId: session.turnId });
  }
  inbound(message) {
    const params = message.params || {};
    const session = this.find(params.threadId);
    if (!session) { if (message.id !== undefined) this.rpc.reject(message.id); return; }
    if (message.id !== undefined) {
      if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) { this.rpc.reject(message.id); return; }
      const id = randomUUID();
      session.approvals.push({ id, requestId: message.id, title: params.reason || params.command || message.method });
      this.gateway.changed(session); return;
    }
    if (message.method === 'turn/started') { session.running = true; session.turnId = params.turn.id; this.gateway.changed(session); }
    else if (message.method === 'turn/completed') this.finish(session, params.turn.error);
    else if (message.method === 'item/agentMessage/delta') this.gateway.message(session, 'assistant', params.delta, params.itemId, true);
    else if (message.method === 'item/reasoning/summaryTextDelta' || message.method === 'item/reasoning/textDelta') this.gateway.message(session, 'reasoning', params.delta, `reasoning:${params.itemId}`, true);
    else if (message.method === 'item/commandExecution/outputDelta') this.gateway.message(session, 'tool', params.delta, params.itemId, true);
    else if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item;
      if (item?.type === 'agentMessage' && message.method === 'item/completed') this.gateway.message(session, 'assistant', item.text, item.id);
      else if (item?.type === 'commandExecution') this.gateway.message(session, 'tool', [item.command, item.aggregatedOutput].filter(Boolean).join('\n'), item.id);
      else if (item?.type === 'fileChange') this.gateway.message(session, 'tool', JSON.stringify(item.changes || []), item.id);
    } else if (message.method === 'error') { session.error = params.error?.message || 'Codex reported an error.'; this.gateway.changed(session); }
  }
  async approve(session, approvalId, decision) {
    const approval = session.approvals.find(item => item.id === approvalId);
    this.rpc.respond(approval.requestId, { decision: decision === 'allow' ? 'accept' : 'decline' });
    session.approvals = session.approvals.filter(item => item.id !== approvalId);
    this.gateway.changed(session);
  }
}

/** OpenCode's ACP interface, using its own filesystem/tools and session storage. */
export class OpenCodeAdapter extends ProcessAdapter {
  kind = 'opencode';
  capabilities = { history: true, streaming: true, cancel: true, approvals: true, files: false, terminal: false };
  async initialize() {
    await this.process(['acp']);
    this.info = await this.rpc.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'dsh-agent-workbench', version: '1.2.6' } });
    this.capabilities.history = this.info.agentCapabilities?.loadSession === true;
  }
  async list(workspace) {
    if (!this.info.agentCapabilities?.sessionCapabilities?.list) return;
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.rpc.call('session/list', { cwd: workspace.path, ...(cursor ? { cursor } : {}) });
      for (const item of result.sessions || []) if (await this.belongs(item.cwd, workspace)) this.gateway.register(this.id, workspace.id, item.sessionId, item.title);
      if (!result.nextCursor) return;
      requireValue(result.nextCursor !== cursor, 'INVALID_AGENT_RESPONSE', 'Agent returned a repeated list cursor.', 502);
      cursor = result.nextCursor;
    }
    throw new GatewayError('SESSION_LIST_LIMIT', 'Agent session listing exceeded 100 pages.', 502);
  }
  async create(workspace) {
    const result = await this.rpc.call('session/new', { cwd: workspace.path, mcpServers: [] });
    const session = this.gateway.register(this.id, workspace.id, result.sessionId, 'OpenCode');
    session.hydrated = true;
    return session;
  }
  async read(session) {
    requireValue(this.capabilities.history, 'HISTORY_UNAVAILABLE', 'This OpenCode version does not support restoring sessions.', 409);
    session.messages = []; session.chunkRole = null; session.replaying = true;
    try { await this.rpc.call('session/load', { sessionId: session.nativeId, cwd: this.gateway.workspace(session.workspaceId).path, mcpServers: [] }); }
    finally { session.replaying = false; }
    session.error = null;
  }
  async prompt(session, text) {
    session.chunkRole = null;
    this.gateway.message(session, 'user', text);
    const rpc = this.rpc;
    session.turn = rpc.call('session/prompt', { sessionId: session.nativeId, prompt: [{ type: 'text', text }] }, 30 * 60 * 1000)
      .then(() => this.finish(session), error => {
        if (error.code === 'AGENT_TIMEOUT') { session.error = 'Turn outcome is unknown. Stop the turn or restart the node before sending again.'; this.gateway.changed(session); }
        else this.finish(session, error);
      });
  }
  async cancel(session) { this.rpc.notify('session/cancel', { sessionId: session.nativeId }); }
  inbound(message) {
    const params = message.params || {}, session = this.find(params.sessionId);
    if (!session) { if (message.id !== undefined) this.rpc.reject(message.id); return; }
    if (message.id !== undefined) {
      if (message.method !== 'session/request_permission' || session.replaying) { this.rpc.reject(message.id); return; }
      const allow = (params.options || []).find(item => item.kind === 'allow_once');
      const reject = (params.options || []).find(item => item.kind === 'reject_once');
      if (!allow || !reject) { this.rpc.respond(message.id, { outcome: { outcome: 'cancelled' } }); return; }
      session.approvals.push({ id: randomUUID(), requestId: message.id, allow: allow.optionId, reject: reject.optionId, title: params.toolCall?.title || 'OpenCode tool' });
      this.gateway.changed(session); return;
    }
    if (message.method !== 'session/update') return;
    const update = params.update || {}, type = update.sessionUpdate;
    if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(type)) {
      if (type === 'user_message_chunk' && !session.replaying) return;
      const role = type === 'agent_message_chunk' ? 'assistant' : type === 'user_message_chunk' ? 'user' : 'reasoning';
      if (session.chunkRole !== role) { session.chunkId = randomUUID(); session.chunkRole = role; }
      this.gateway.message(session, role, textContent(update.content), session.chunkId, true);
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      session.chunkRole = null;
      this.gateway.message(session, 'tool', [update.title, textContent((update.content || []).map(item => item.content)), update.status].filter(Boolean).join('\n'), update.toolCallId);
    }
  }
  async approve(session, approvalId, decision) {
    const approval = session.approvals.find(item => item.id === approvalId);
    this.rpc.respond(approval.requestId, { outcome: { outcome: 'selected', optionId: decision === 'allow' ? approval.allow : approval.reject } });
    session.approvals = session.approvals.filter(item => item.id !== approvalId);
    this.gateway.changed(session);
  }
}
