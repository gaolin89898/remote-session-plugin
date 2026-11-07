import { randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export class GatewayError extends Error {
  constructor(code, message, status = 400) { super(message); Object.assign(this, { code, status }); }
}
export function requireValue(condition, code, message, status = 400) {
  if (!condition) throw new GatewayError(code, message, status);
}
export function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function textContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).filter(Boolean).join('\n');
  return typeof value?.text === 'string' ? value.text : '';
}

/** Execution nodes own paths and session identity; clients select opaque IDs. */
export class AgentGateway {
  constructor(config, adapters) {
    this.config = config;
    this.adapters = adapters;
    this.sessions = new Map();
    this.epoch = randomUUID();
    this.waiters = new Set();
    this.closed = false;
    this.saveQueue = Promise.resolve();
    for (const adapter of adapters.values()) adapter.attach(this);
  }
  async initialize() {
    const ids = new Set();
    for (const workspace of this.config.workspaces) {
      requireValue(typeof workspace.id === 'string' && /^[\w-]{1,80}$/.test(workspace.id) && !ids.has(workspace.id), 'INVALID_CONFIG', 'Workspace IDs must be unique.');
      ids.add(workspace.id);
      workspace.path = await realpath(workspace.path);
    }
    if (this.config.stateFile) {
      let stored;
      try { stored = JSON.parse(await readFile(this.config.stateFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const item of stored?.sessions ?? []) {
        if (this.adapters.has(item.agentId) && ids.has(item.workspaceId)) this.register(item.agentId, item.workspaceId, item.nativeId, item.title);
      }
    }
  }
  workspace(id) {
    const value = this.config.workspaces.find(item => item.id === id);
    requireValue(value, 'WORKSPACE_NOT_FOUND', 'Select a configured workspace.', 404);
    return value;
  }
  register(agentId, workspaceId, nativeId, title = '') {
    requireValue(typeof nativeId === 'string' && nativeId.length > 0 && nativeId.length < 1024, 'INVALID_AGENT_RESPONSE', 'Agent returned an invalid session ID.', 502);
    title = typeof title === 'string' ? title.slice(0, 500) : '';
    const id = `${agentId}:${Buffer.from(nativeId).toString('base64url')}`;
    let session = this.sessions.get(id);
    if (!session) {
      requireValue(this.sessions.size < 10000, 'SESSION_LIMIT', 'Gateway session limit reached.', 409);
      session = { id, agentId, workspaceId, nativeId, title: title || nativeId, messages: [], approvals: [], running: false, cursor: 0, hydrated: false };
      this.sessions.set(id, session);
    }
    requireValue(session.workspaceId === workspaceId, 'SESSION_WORKSPACE_MISMATCH', 'This session belongs to another workspace.', 409);
    if (title) session.title = title;
    return session;
  }
  session(id) {
    const session = this.sessions.get(id);
    requireValue(session, 'SESSION_NOT_FOUND', 'Refresh the session list before opening this session.', 404);
    this.workspace(session.workspaceId);
    return session;
  }
  changed(session) {
    while (session.messages.length > 1000 || Buffer.byteLength(JSON.stringify(session.messages)) > 2 * 1024 * 1024) {
      session.messages.shift(); session.hasMore = true;
    }
    session.cursor++;
    for (const wake of [...this.waiters]) wake();
  }
  message(session, role, text, id = randomUUID(), append = false) {
    if (!text) return;
    const previous = session.messages.find(item => item.id === id);
    if (previous) previous.text = append ? previous.text + text : text;
    else session.messages.push({ id, role, text, at: Date.now() });
    this.changed(session);
  }
  snapshot(session) {
    return structuredClone({ id: session.id, agentId: session.agentId, workspaceId: session.workspaceId,
      title: session.title, running: session.running, messages: session.messages, approvals: session.approvals.map(({ id, title, pending }) => ({ id, title, pending: pending === true })),
      hasMore: session.hasMore === true, epoch: this.epoch, cursor: session.cursor, error: session.error ?? null });
  }
  persist() {
    if (!this.config.stateFile) return Promise.resolve();
    const records = [...this.sessions.values()].map(({ agentId, workspaceId, nativeId, title }) => ({ agentId, workspaceId, nativeId, title }));
    const task = this.saveQueue.catch(() => {}).then(async () => {
      const file = this.config.stateFile;
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file + '.tmp', JSON.stringify({ sessions: records }, null, 2), { mode: 0o600 });
      await rename(file + '.tmp', file);
    });
    this.saveQueue = task;
    return task;
  }
  async call(method, params = {}, signal) {
    requireValue(!this.closed, 'GATEWAY_CLOSED', 'Gateway is shutting down.', 503);
    requireValue(params && typeof params === 'object' && !Array.isArray(params), 'INVALID_PARAMS', 'Expected an object.');
    if (method === 'node.describe') return { protocol: 1, id: this.config.id, name: this.config.name, epoch: this.epoch };
    if (method === 'agents.list') return { agents: [...this.adapters].map(([id, adapter]) => ({ id, kind: adapter.kind, name: adapter.name, status: adapter.status, capabilities: adapter.capabilities })) };
    if (method === 'workspaces.list') return { workspaces: this.config.workspaces.map(({ id, name, path: cwd }) => ({ id, name: name || id, path: cwd })) };
    if (method === 'sessions.list' || method === 'sessions.create') {
      const adapter = this.adapters.get(params.agentId);
      requireValue(adapter, 'AGENT_NOT_FOUND', 'Unknown Agent.', 404);
      const workspace = this.workspace(params.workspaceId);
      await adapter.start();
      if (method === 'sessions.list') {
        await adapter.list(workspace);
        await this.persist();
        return { sessions: [...this.sessions.values()].filter(item => item.agentId === params.agentId && item.workspaceId === workspace.id).map(({ id, title, running }) => ({ id, title, running })) };
      }
      const session = await adapter.create(workspace);
      await this.persist();
      return this.snapshot(session);
    }
    const allowed = ['sessions.read', 'sessions.watch', 'sessions.prompt', 'sessions.cancel', 'sessions.approve'];
    requireValue(allowed.includes(method), 'METHOD_NOT_FOUND', 'Unknown gateway method.', 404);
    const session = this.session(params.sessionId);
    const adapter = this.adapters.get(session.agentId);
    await adapter.start();
    if (!session.hydrated) {
      session.loading ??= adapter.read(session).then(() => { session.hydrated = true; }).finally(() => { session.loading = null; });
      await session.loading;
    }
    if (method === 'sessions.read') return this.snapshot(session);
    if (method === 'sessions.watch') {
      requireValue(Number.isSafeInteger(params.after) && params.after >= 0 && typeof params.epoch === 'string', 'INVALID_CURSOR', 'Invalid watch cursor.');
      const matches = () => params.epoch === this.epoch && params.after === session.cursor;
      if (matches() && !signal?.aborted) await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); this.waiters.delete(wake); signal?.removeEventListener('abort', finish); resolve(); };
        const wake = () => { if (!matches() || this.closed) finish(); };
        const timer = setTimeout(finish, 20000);
        this.waiters.add(wake);
        signal?.addEventListener('abort', finish, { once: true });
      });
      return this.snapshot(session);
    }
    if (method === 'sessions.prompt') {
      requireValue(typeof params.text === 'string' && params.text.trim().length > 0 && Buffer.byteLength(params.text) <= 256 * 1024, 'INVALID_PROMPT', 'Enter a message of at most 256 KiB.');
      requireValue(!session.running, 'SESSION_BUSY', 'Wait for the current turn or stop it first.', 409);
      session.running = true; session.error = null;
      this.changed(session);
      try { await adapter.prompt(session, params.text); }
      catch (error) {
        // A lost response does not prove the Agent rejected the prompt.
        session.running = !['AGENT_RPC_ERROR', 'INVALID_PROMPT', 'AGENT_CLOSED'].includes(error.code);
        session.error = session.running ? 'Prompt outcome is unknown. Stop the turn or reconnect the node before sending again.' : error.message;
        this.changed(session); throw error;
      }
      return this.snapshot(session);
    }
    if (method === 'sessions.cancel') { await adapter.cancel(session); return this.snapshot(session); }
    requireValue(params.decision === 'allow' || params.decision === 'reject', 'INVALID_DECISION', 'Only a one-time allow or reject is supported.');
    const approval = session.approvals.find(item => item.id === params.approvalId);
    requireValue(approval && !approval.pending, 'APPROVAL_EXPIRED', 'Approval is no longer pending.', 409);
    approval.pending = true; this.changed(session);
    try { await adapter.approve(session, params.approvalId, params.decision); }
    catch (error) { session.error = 'Approval delivery failed; reopen the session before deciding again.'; this.changed(session); throw error; }
    return this.snapshot(session);
  }
  async close() {
    this.closed = true;
    for (const wake of [...this.waiters]) wake();
    await Promise.allSettled([...this.adapters.values()].map(adapter => adapter.close()));
    await this.saveQueue;
  }
}
