import { randomUUID } from 'node:crypto';

const EMPTY = { async *[Symbol.asyncIterator]() {} };
const MAX_BUFFER = 512 * 1024;
const LEASE_MS = 60000;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function identity(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw invalid('Invalid native client identity');
  return value;
}

/** A bounded queue that pauses producers until the consumer drains it. */
class Inbox {
  items = [];
  bytes = 0;
  ended = false;
  failure = null;
  waiters = new Set();
  wake() {
    for (const wake of [...this.waiters]) wake();
  }
  wait(ms = 10000) {
    return new Promise(resolve => {
      const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, ms);
      this.waiters.add(wake);
    });
  }
  async push(value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_BUFFER) throw invalid('Native stream item exceeds relay buffer limit');
    while (!this.ended && this.bytes + bytes > MAX_BUFFER) await this.wait();
    if (this.ended) return;
    this.items.push({ value, bytes });
    this.bytes += bytes;
    this.wake();
  }
  end(failure = null) { this.ended = true; this.failure = failure; this.wake(); }
  drain() {
    const values = [];
    let bytes = 0;
    while (this.items.length && bytes + this.items[0].bytes <= MAX_BUFFER) {
      const item = this.items.shift();
      bytes += item.bytes;
      this.bytes -= item.bytes;
      values.push(item.value);
    }
    this.wake();
    return values;
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.items.length) {
      if (!this.items.length) { await this.wait(); continue; }
      for (const value of this.drain()) yield value;
    }
  }
}

/** Carry the official Gateway protocol through an authenticated paired relay. */
export class NativeGateway {
  clients = new Map();
  constructor(ctx) {
    this.ctx = ctx;
    this.sweepTimer = setInterval(() => {
      for (const [key, client] of this.clients) {
        if (Date.now() - client.touched > LEASE_MS) void this.release(key);
      }
    }, 15000);
    this.sweepTimer.unref?.();
  }

  status() {
    const required = [
      ['connection.createPeer', this.ctx.connection?.createPeer],
      ['connection.createSharedFetchHandler', this.ctx.connection?.createSharedFetchHandler],
      ['typertGateway.wireStream.open', this.ctx.typertGateway?.wireStream?.open],
      ['typertGateway.wireStream.failure', this.ctx.typertGateway?.wireStream?.failure],
      ['clientModules.graph', this.ctx.clientModules?.graph],
    ];
    const missing = required.filter(([, value]) => typeof value !== 'function').map(([name]) => name);
    return {
      supported: missing.length === 0,
      error: missing.length ? '当前 DSH 不支持原生远程连接，缺少接口：' + missing.join(', ') + '。请更新 DSH 后重启。' : null,
    };
  }

  client(source, clientId) {
    identity(source);
    identity(clientId);
    const key = JSON.stringify([source, clientId]);
    let client = this.clients.get(key);
    if (!client) {
      if (this.clients.size >= 64) throw invalid('Too many native clients');
      client = {
        key, touched: Date.now(), streams: new Map(), requests: new Map(),
        peer: this.ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' }),
      };
      this.clients.set(key, client);
    }
    client.touched = Date.now();
    return client;
  }

  async dispatch(source, input) {
    if (!input || typeof input !== 'object') throw invalid('Missing native request');
    const gateway = this.ctx.typertGateway;
    const status = this.status();
    if (!status.supported) throw Object.assign(new Error(status.error), { status: 409 });
    if (input.operation === 'probe') {
      let graph;
      try { graph = this.ctx.clientModules.graph(); } catch {
        throw Object.assign(new Error('无法读取目标 DSH 客户端组件，请更新 DSH 后重启。'), { status: 409 });
      }
      if (!Array.isArray(graph?.entries) || !graph.entries.every(entry => typeof entry?.id === 'string')) {
        throw Object.assign(new Error('目标 DSH 客户端组件格式不兼容，请更新 DSH 后重启。'), { status: 409 });
      }
      return { protocol: 1, clientEntries: graph.entries.map(entry => entry.id) };
    }
    const client = this.client(source, input.clientId);
    if (input.operation === 'release') { await this.release(client.key); return {}; }
    if (input.operation === 'cancel') {
      client.requests.get(input.requestId)?.abort();
      return {};
    }
    if (input.operation === 'fetch') return this.fetch(client, input);
    if (input.operation === 'open') {
      identity(input.streamId);
      if (client.streams.has(input.streamId)) throw invalid('Duplicate native stream');
      if (client.streams.size >= 128) throw invalid('Too many native streams');
      if (typeof input.endpoint !== 'string' || input.endpoint.length > 256) throw invalid('Invalid native endpoint');
      const stream = {
        abort: new AbortController(), inbox: new Inbox(), uplink: new Inbox(),
        sequence: 0, uplinkSequence: 0, last: null, pulling: false,
      };
      client.streams.set(input.streamId, stream);
      stream.pump = (async () => {
        try {
          const source = await gateway.wireStream.open(
            input.endpoint, input.payload, input.uplink ? stream.uplink : EMPTY,
            client.peer, stream.abort.signal,
          );
          for await (const value of source) {
            if (stream.abort.signal.aborted) break;
            // History snapshots can exceed one relay message. Bound each
            // carrier frame while retaining the original native value.
            const serialized = JSON.stringify(value);
            if (serialized.length > 16 * 1024 * 1024) throw invalid('Native stream snapshot exceeds relay limit');
            for (let offset = 0; offset < serialized.length; offset += 32768) {
              if (stream.abort.signal.aborted) break;
              await stream.inbox.push({ text: serialized.slice(offset, offset + 32768), final: offset + 32768 >= serialized.length });
            }
          }
          stream.inbox.end();
        } catch (error) {
          stream.inbox.end(gateway.wireStream.failure(error));
        }
      })();
      return { streamId: input.streamId };
    }
    const stream = client.streams.get(input.streamId);
    if (!stream) {
      if (input.operation === 'close') return {};
      throw invalid('Native stream expired; reconnect to the machine');
    }
    if (input.operation === 'close') {
      this.closeStream(client, input.streamId);
      return {};
    }
    if (input.operation === 'uplink') {
      if (input.sequence === stream.uplinkSequence - 1) return {};
      if (input.sequence !== stream.uplinkSequence) throw invalid('Native uplink sequence mismatch');
      if (input.done) stream.uplink.end();
      else await stream.uplink.push(input.value);
      stream.uplinkSequence += 1;
      return {};
    }
    if (input.operation !== 'pull') throw invalid('Unknown native operation');
    if (stream.last?.sequence === input.sequence) return stream.last;
    if (input.sequence !== stream.sequence || stream.pulling) throw invalid('Native pull sequence mismatch');
    stream.pulling = true;
    try {
      if (!stream.inbox.items.length && !stream.inbox.ended) await stream.inbox.wait();
      const values = stream.inbox.drain();
      stream.last = {
        sequence: stream.sequence++, values,
        done: stream.inbox.ended && stream.inbox.items.length === 0,
        failure: stream.inbox.items.length === 0 ? stream.inbox.failure : null,
      };
      return stream.last;
    } finally { stream.pulling = false; }
  }

  async fetch(client, input) {
    // Only the official shared API channel is exposed; callers cannot name a
    // host, filesystem path, credential, or arbitrary local HTTP service.
    const route = String(input.route || '');
    const url = new URL(route, 'http://dsh.internal/');
    if (url.origin !== 'http://dsh.internal' || !url.pathname.startsWith('/api/')) throw invalid('Invalid native API route');
    if (!['GET', 'HEAD', 'POST'].includes(input.method)) throw invalid('Invalid native HTTP method');
    identity(input.requestId);
    if (client.requests.has(input.requestId) || client.requests.size >= 64) throw invalid('Too many native requests');
    const abort = new AbortController();
    client.requests.set(input.requestId, abort);
    try {
      const request = new Request(url, {
        method: input.method, signal: abort.signal,
        headers: { 'content-type': String(input.contentType || 'application/json') },
        ...input.bodyBase64 === undefined ? {} : { body: Buffer.from(input.bodyBase64, 'base64') },
      });
      const handler = this.ctx.connection.createSharedFetchHandler('/api');
      const response = await handler.fetch(request, client.peer);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > 8 * 1024 * 1024) throw invalid('Native API response exceeds relay limit');
      return { status: response.status, headers: [...response.headers], body: body.toString('base64') };
    } finally { client.requests.delete(input.requestId); }
  }

  closeStream(client, id) {
    const stream = client.streams.get(id);
    if (!stream) return;
    client.streams.delete(id);
    stream.abort.abort();
    stream.inbox.end();
    stream.uplink.end();
  }

  async release(key) {
    const client = this.clients.get(key);
    if (!client) return;
    this.clients.delete(key);
    for (const id of client.streams.keys()) this.closeStream(client, id);
    for (const abort of client.requests.values()) abort.abort();
    await client.peer.dispose();
  }

  async dispose() {
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.clients.keys()].map(key => this.release(key)));
  }
}
