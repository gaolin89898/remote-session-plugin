import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { realpath, readFile } from 'node:fs/promises';
import { GatewayError, requireValue } from './core.mjs';
import { eventsToMessages } from '../lib/session-bridge.js';

/** Connects to stock dsh web; no remote-session plugin is installed on the Host. */
export class DshAdapter {
  kind = 'dsh';
  capabilities = { history: true, streaming: true, cancel: true, approvals: true, files: false, terminal: false };
  constructor(id, config) {
    this.id = id; this.config = config; this.name = config.name || id; this.status = 'configured';
    this.streams = new Map();
    const url = new URL(config.url);
    requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'INVALID_CONFIG', 'DSH URL must be an HTTP(S) base address without credentials.');
    this.base = url.href.replace(/\/$/, '');
  }
  attach(gateway) { this.gateway = gateway; }
  start() {
    if (this.socket?.readyState === WebSocket.OPEN && this.clientId) return Promise.resolve();
    this.starting ??= this.initialize().then(() => { this.status = 'ready'; }, error => { this.status = 'unavailable'; this.socket?.terminate(); throw error; }).finally(() => { this.starting = null; });
    return this.starting;
  }
  async initialize() {
    const token = this.config.tokenFile ? (await readFile(this.config.tokenFile, 'utf8')).trim() : process.env[this.config.tokenEnv || 'DSH_WEB_TOKEN'];
    requireValue(token, 'DSH_TOKEN_REQUIRED', 'Set the DSH launch-token file or environment variable on the execution node.', 503);
    const url = new URL(this.base + '/'); url.searchParams.set('token', token);
    const headers = this.config.hostHeader ? { host: this.config.hostHeader } : {};
    const login = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    requireValue(login.status === 200 || login.status === 302 || login.status === 303, 'DSH_AUTH_FAILED', 'DSH refused the launch token or trusted host.', 502);
    this.cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    await login.body?.cancel();
    requireValue(this.cookie, 'DSH_AUTH_FAILED', 'DSH did not issue a login cookie.', 502);
    this.clientId = null;
    const socket = this.socket = new WebSocket(this.base.replace(/^http/, 'ws') + '/api/remote.mux', { headers: { ...headers, cookie: this.cookie }, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 15000 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new GatewayError('DSH_TIMEOUT', 'DSH event channel did not become ready.', 504)), 20000);
      const fail = () => { clearTimeout(timer); reject(new GatewayError('DSH_DISCONNECTED', 'DSH event channel disconnected.', 502)); };
      socket.on('error', fail);
      socket.once('open', () => this.open('$events', {}, value => {
        if (value.type === 'ready') { this.clientId = value.clientId; clearTimeout(timer); resolve(); }
        else this.hostEvent(value);
      }));
      socket.on('message', data => {
        try {
          const frame = JSON.parse(data.toString()), stream = this.streams.get(frame.streamId);
          if (frame.type === 'item') stream?.next(frame.value);
          else if (frame.type === 'error') stream?.error(new GatewayError('DSH_STREAM_ERROR', frame.error?.message || 'DSH stream failed.', 502));
        } catch { socket.terminate(); }
      });
      socket.once('close', () => {
        fail(); this.status = 'unavailable'; this.clientId = null;
        for (const stream of this.streams.values()) stream.error(new GatewayError('DSH_DISCONNECTED', 'Reopen the session to reconnect to DSH.', 503));
        this.streams.clear();
        for (const session of this.gateway.sessions.values()) if (session.agentId === this.id) {
          session.hydrated = false; session.approvals = []; session.running = false;
          session.error = 'DSH disconnected. Reopen the session to recover.'; this.gateway.changed(session);
        }
      });
    });
  }
  open(endpoint, args, next, error = () => {}) {
    const streamId = randomUUID();
    this.streams.set(streamId, { next, error });
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    return streamId;
  }
  async rpc(endpoint, args) {
    const rpcId = randomUUID();
    const response = await fetch(this.base + '/api/' + endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json', cookie: this.cookie, ...(this.config.hostHeader ? { host: this.config.hostHeader } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    });
    requireValue(response.ok, 'DSH_HTTP_ERROR', `DSH returned HTTP ${response.status}.`, 502);
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      requireValue(size <= 8 * 1024 * 1024, 'DSH_RESPONSE_LIMIT', 'DSH response exceeded the gateway limit.', 502);
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(text);
    requireValue(body.rpcId === rpcId && body.result, 'DSH_PROTOCOL_ERROR', 'DSH returned an invalid RPC envelope.', 502);
    if (!body.result.ok) throw new GatewayError(body.result.error?.code || 'DSH_ERROR', body.result.error?.message || 'DSH request failed.', 502);
    return body.result.value;
  }
  async list(workspace) {
    const result = await this.rpc('session/list', { _request: {} });
    for (const item of result.items || []) {
      let cwd; try { cwd = await realpath(item.cwd); } catch { continue; }
      if (cwd !== workspace.path || item.parentSessionId) continue;
      const session = this.gateway.register(this.id, workspace.id, item.sessionId, item.projections?.values?.title);
      session.running = item.running === true;
    }
  }
  async create(workspace) {
    const result = await this.rpc('session/create', { request: { cwd: workspace.path } });
    return this.gateway.register(this.id, workspace.id, result.sessionId, 'DSH');
  }
  async read(session) {
    if (session.streamId && this.streams.has(session.streamId)) {
      this.socket.send(JSON.stringify({ type: 'cancel', streamId: session.streamId })); this.streams.delete(session.streamId);
    }
    session.events = []; session.messages = [];
    await new Promise((resolve, reject) => {
      let ready = false; const queuedFrames = [];
      const stop = error => {
        clearTimeout(timer);
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId: session.streamId }));
        this.streams.delete(session.streamId);
        session.hydrated = false; session.error = error.message; this.gateway.changed(session); reject(error);
      };
      const timer = setTimeout(() => stop(new GatewayError('DSH_TIMEOUT', 'DSH session snapshot timed out.', 504)), 20000);
      session.streamId = this.open('session/follow', { request: { address: { kind: 'session', sessionId: session.nativeId }, assistantStream: true, maxMessages: 500 } }, value => {
        if (value.type === 'snapshot') {
          void (async () => {
            requireValue(await realpath(value.header?.cwd) === this.gateway.workspace(session.workspaceId).path, 'SESSION_WORKSPACE_MISMATCH', 'DSH returned another working directory.', 409);
            session.events = [...(value.records || []).map(item => item.event), ...session.events];
            session.hasMore = value.hasMore === true;
            this.fold(session); session.error = null; ready = true;
            session.streamRevision = value.assistantStream?.revision ?? 0;
            const active = value.assistantStream?.activeAttempt;
            if (active) {
              session.running = true;
              for (const item of active.stream || []) {
                if (item.type === 'chunk') this.chunk(session, active.attemptId, item.chunk);
                else if (item.type === 'text-chunks' || item.type === 'reasoning-chunks') this.chunk(session, active.attemptId, { type: item.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: item.index, text: (item.texts || []).join('') });
              }
            }
            for (const frame of queuedFrames) this.frame(session, frame);
            clearTimeout(timer); resolve();
          })().catch(stop);
        } else if (value.type === 'event') {
          session.events.push(value.event);
          if (session.events.length > 4000) { session.events.shift(); session.hasMore = true; }
          if (ready) this.fold(session);
        } else if (value.type === 'assistant-stream') {
          const frame = value.frame;
          if (ready) this.frame(session, frame);
          else if (queuedFrames.length < 2000) queuedFrames.push(frame);
        }
      }, stop);
    });
  }
  frame(session, frame) {
    if (!frame || frame.revision <= session.streamRevision) return;
    session.streamRevision = frame.revision;
    if (frame.type === 'chunk') this.chunk(session, frame.attemptId, frame.chunk);
  }
  chunk(session, attemptId, chunk) {
    if (!['text-delta', 'reasoning-delta'].includes(chunk?.type)) return;
    this.gateway.message(session, chunk.type === 'text-delta' ? 'assistant' : 'reasoning', chunk.text || chunk.delta, `draft:${attemptId}:${chunk.index ?? 0}`, true);
  }
  fold(session) {
    const value = eventsToMessages(session.events, { maxMessages: 1000, maxChars: 100000, includeReasoning: true, includeTools: true });
    const drafts = session.messages.filter(item => item.id.startsWith('draft:'));
    session.messages = value.messages.map(item => ({ id: `${item.seq}:${item.role}`, role: item.role, text: item.text, at: item.at }));
    if (!['assistant/message', 'turn/end', 'turn/cancel'].includes(session.events.at(-1)?.type)) session.messages.push(...drafts);
    if (value.title) session.title = value.title;
    const last = session.events.findLast(item => item.type === 'turn/start' || item.type === 'turn/end');
    if (last) session.running = last.type === 'turn/start';
    this.gateway.changed(session);
  }
  async prompt(session, text) {
    await this.rpc('session/prompt', { request: { requestId: randomUUID(), sessionId: session.nativeId, mode: 'queue', content: [{ type: 'text', text }] } });
  }
  async cancel(session) { await this.rpc('session/cancel', { request: { sessionId: session.nativeId } }); }
  hostEvent(value) {
    if (value.type === 'cancel') {
      for (const session of this.gateway.sessions.values()) if (session.agentId === this.id) {
        session.approvals = session.approvals.filter(item => item.id !== value.eventId); this.gateway.changed(session);
      }
      return;
    }
    if (value.type !== 'waterfall') return;
    const session = [...this.gateway.sessions.values()].find(item => item.agentId === this.id && item.nativeId === value.agentId);
    if (value.event === 'approval/request' && session) {
      if (!session.approvals.some(item => item.id === value.eventId)) session.approvals.push({ id: value.eventId, title: value.request?.reason || value.request?.toolName || 'DSH tool' });
      this.gateway.changed(session);
    } else {
      void this.rpc('$events/result', { clientId: this.clientId, eventId: value.eventId, outcome: { kind: 'next' } }).catch(() => {});
    }
  }
  async approve(session, approvalId, decision) {
    await this.rpc('$events/result', { clientId: this.clientId, eventId: approvalId, outcome: { kind: 'result', value: decision === 'allow' ? 'allowed-once' : 'rejected' } });
    session.approvals = session.approvals.filter(item => item.id !== approvalId); this.gateway.changed(session);
  }
  async close() { this.socket?.terminate(); }
}
