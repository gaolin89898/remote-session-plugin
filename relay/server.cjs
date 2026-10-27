'use strict';
/**
 * DSH 跨端会话中转（relay）
 * - 只做消息转发与在线状态/会话索引快照，不落盘、不保存会话内容
 * - 鉴权：共享令牌（/etc/dsh-relay/token）
 * - 监听 127.0.0.1:3098，由 nginx 以 /dsh-relay/ 前缀对外暴露
 */
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3098);
const HOST = '127.0.0.1';
const TOKEN = fs.readFileSync(process.env.TOKEN_FILE || '/etc/dsh-relay/token', 'utf8').trim();
const MAX_BODY = 64 * 1024 * 1024;
const QUEUE_CAP = 500;
const MAX_ID = 64;
/** Offline instances leave the peer snapshot after this quiet period. */
const OFFLINE_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, {id:string,name:string,meta:object,sessions:any[],sse:any,queue:any[],lastSeen:number}>} */
const instances = new Map();

function tokenOk(t) {
  if (typeof t !== 'string' || t.length !== TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN)); } catch { return false; }
}
function peersSnapshot(excludeId) {
  const now = Date.now();
  return [...instances.values()]
    .filter((i) => i.id !== excludeId && (i.sse || now - i.lastSeen < OFFLINE_TTL_MS))
    .map((i) => ({ id: i.id, name: i.name, online: !!i.sse, meta: i.meta || {}, sessions: i.sessions || [] }));
}
function send(inst, event, data) {
  if (!inst || !inst.sse) return;
  try { inst.sse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
}
function fanout(event, data, exceptId) {
  for (const i of instances.values()) if (i.id !== exceptId) send(i, event, data);
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { const e = new Error('too large'); e.status = 413; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function validId(v) { return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID; }

function handleRegister(msg, res) {
  if (!validId(msg.id)) return json(res, 400, { ok: false, error: 'bad_id' });
  const id = msg.id;
  let inst = instances.get(id);
  const isNew = !inst;
  if (!inst) {
    inst = { id, name: '', meta: {}, sessions: [], sse: null, queue: [], lastSeen: Date.now() };
    instances.set(id, inst);
  }
  if (typeof msg.previousId === 'string' && msg.previousId.length > 0 && msg.previousId !== id && validId(msg.previousId)) {
    const previous = instances.get(msg.previousId);
    if (previous) {
      if (previous.sse) { try { previous.sse.end(); } catch { /* ignore */ } }
      instances.delete(msg.previousId);
      fanout('peer', { type: 'offline', instance: { id: msg.previousId, name: previous.name, online: false } }, id);
    }
  }
  if (typeof msg.name === 'string') inst.name = msg.name.slice(0, 64);
  if (msg.meta && typeof msg.meta === 'object') inst.meta = msg.meta;
  if (Array.isArray(msg.sessions)) inst.sessions = msg.sessions;
  inst.lastSeen = Date.now();
  if (isNew) fanout('peer', { type: 'online', instance: { id: inst.id, name: inst.name, online: !!inst.sse, meta: inst.meta, sessions: inst.sessions } });
  return json(res, 200, { ok: true, peers: peersSnapshot(id) });
}

function handleIndex(msg, res) {
  const inst = instances.get(msg.id);
  if (!inst) return json(res, 404, { ok: false, error: 'unknown_instance' });
  if (Array.isArray(msg.sessions)) inst.sessions = msg.sessions;
  inst.lastSeen = Date.now();
  fanout('peer.index', { id: inst.id, sessions: inst.sessions }, inst.id);
  return json(res, 200, { ok: true });
}

function handlePublish(msg, res) {
  if (!validId(msg.from)) return json(res, 400, { ok: false, error: 'bad_from' });
  const from = instances.get(msg.from);
  if (!from) return json(res, 404, { ok: false, error: 'unknown_instance' });
  from.lastSeen = Date.now();
  const envelope = { from: msg.from, type: String(msg.type || '').slice(0, 64), payload: msg.payload ?? null, id: typeof msg.id === 'string' ? msg.id : undefined, ts: Date.now() };
  if (msg.to === '*') {
    fanout('message', envelope, msg.from);
    return json(res, 200, { ok: true, delivered: 'broadcast' });
  }
  const target = instances.get(msg.to);
  if (!target) return json(res, 404, { ok: false, error: 'unknown_target' });
  if (!target.sse) return json(res, 409, { ok: false, error: 'target_offline' });
  send(target, 'message', envelope);
  return json(res, 200, { ok: true });
}

function handleStream(req, res, url) {
  const id = url.searchParams.get('id') || '';
  const token = url.searchParams.get('token') || '';
  if (!validId(id) || !tokenOk(token)) return json(res, 401, { ok: false, error: 'unauthorized' });
  const inst = instances.get(id);
  if (!inst) return json(res, 404, { ok: false, error: 'unknown_instance' });
  if (inst.sse) { try { inst.sse.end(); } catch { /* ignore */ } }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  inst.sse = res;
  inst.lastSeen = Date.now();
  res.write(`event: ready\ndata: ${JSON.stringify({ peers: peersSnapshot(id) })}\n\n`);
  fanout('peer', { type: 'online', instance: { id: inst.id, name: inst.name, online: true, meta: inst.meta, sessions: inst.sessions } }, id);
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 20000);
  const cleanup = () => {
    clearInterval(hb);
    if (inst.sse === res) {
      inst.sse = null;
      inst.lastSeen = Date.now();
      fanout('peer', { type: 'offline', instance: { id: inst.id, name: inst.name, online: false } }, id);
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://relay.invalid');
  let p = url.pathname.replace(/\/+$/, '');
  if (p === '') p = '/';
  try {
    if (req.method === 'GET' && p === '/health') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/v1/stream') return handleStream(req, res, url);
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' });
    const body = await readBody(req);
    let msg;
    try { msg = JSON.parse(body || '{}'); } catch { return json(res, 400, { ok: false, error: 'json' }); }
    if (!tokenOk(msg.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (p === '/v1/register') return handleRegister(msg, res);
    if (p === '/v1/index') return handleIndex(msg, res);
    if (p === '/v1/publish') return handlePublish(msg, res);
    if (p === '/v1/peers') return json(res, 200, { ok: true, peers: peersSnapshot(msg.id) });
    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    return json(res, e.status || 500, { ok: false, error: e.status === 413 ? 'too_large' : 'internal' });
  }
});

// offline sweep: forget instances that stayed offline past the TTL
setInterval(() => {
  const now = Date.now();
  for (const [id, inst] of instances) {
    if (inst.sse) continue;
    if (now - inst.lastSeen < OFFLINE_TTL_MS) continue;
    instances.delete(id);
    fanout('peer', { type: 'offline', instance: { id, name: inst.name, online: false } }, id);
  }
}, 60_000).unref();

server.listen(PORT, HOST, () => console.log(`[dsh-relay] listening on ${HOST}:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
