import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { RestartController } from '../lib/restart.js';

const fetchHttp = globalThis.fetch.bind(globalThis);
const peer = { id: 'remote', name: 'Remote', online: true, sessions: [] };

async function host(t, { relay = false, config = {}, sessionEvents = [], incompatible = false, profile = 'web', forbidden = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-host-api-test-'));
  if (sessionEvents.length) {
    const directory = path.join(home, 'sessions/fixture/session-fixture');
    await mkdir(directory, { recursive: true });
    const header = { type: 'session', id: 'session-fixture', cwd: home };
    await writeFile(path.join(directory, 'session.jsonl'), [header, ...sessionEvents].map(value => JSON.stringify(value)).join('\n') + '\n');
  }
  const cleanups = [];
  let handler;
  const server = createServer((req, res) => { void handler(req, res); });
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  const ctx = {
    effect(start, label) {
      if (relay || !label.endsWith(': relay')) cleanups.push(start());
    },
    on() { return () => {}; },
    get(name) { if (name === 'profileContext') return { name: profile }; },
    webServer: {
      register(route) { handler = route.handler; return () => {}; },
      match: () => null,
      getOrigin: () => 'http://127.0.0.1:' + server.address().port,
    },
    sessionController: { list: async () => ({ items: [] }) },
    connection: {
      authenticatedUrl: url => url,
      requestRejection: () => forbidden ? 'forbidden' : undefined,
      createPeer: () => ({ dispose: async () => {} }),
      createSharedFetchHandler: () => ({ fetch: async request => new Response(await request.arrayBuffer()) }),
    },
    typertGateway: { wireStream: incompatible ? {} : { open: async function *() {}, failure: error => ({ message: error.message }) } },
    clientModules: { graph: () => ({ entries: [], batches: [] }), fetchBundle: async () => new Response('fixture') },
  };
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    apply(ctx, { relayUrl: 'http://relay.fixture', token: 'fixture-only', instanceId: 'home', ...config });
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/remote-session/api/`;
  const request = async (action, body = {}) => {
    const response = await fetchHttp(base + action, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json() };
  };
  request.raw = (action, init = {}) => fetchHttp(base + action, { ...init, signal: AbortSignal.timeout(10000) });
  return request;
}

function relayFetch(onPublish, peers = [peer], results = {}) {
  let stream;
  const queued = [];
  return async (url, init) => {
    const route = new URL(url).pathname;
    if (route === '/v1/register' || route === '/v1/peers') return Response.json({ ok: true, peers });
    if (route === '/v1/stream') {
      assert.equal(new URL(url).searchParams.has('token'), false);
      assert.equal(init.headers.authorization, 'Bearer fixture-only');
      return new Response(new ReadableStream({ start(controller) {
        stream = controller;
        for (const frame of queued) controller.enqueue(frame);
        init.signal.addEventListener('abort', () => controller.error(new Error('stream aborted')), { once: true });
      } }));
    }
    if (route === '/v1/publish') {
      const message = JSON.parse(init.body);
      const pending = onPublish(message);
      if (pending !== undefined) return pending;
      const answer = results[message.payload.method];
      const result = typeof answer === 'function' ? await answer(message.payload.params) : answer ?? (message.payload.method === 'version' ? { version: '1.0.0' } : []);
      const envelope = { from: message.to, type: 'rpc.result', id: message.id, payload: { ok: true, result } };
      const frame = new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`);
      if (stream) stream.enqueue(frame);
      else queued.push(frame);
    }
    return Response.json({ ok: true });
  };
}

test('RPC timeout settles while publish is pending and a late publish failure is handled', { timeout: 15000 }, async t => {
  const started = Promise.withResolvers();
  const published = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', relayFetch(message => {
    if (message.payload.method === 'version') {
      started.resolve();
      return published.promise;
    }
  }));
  const request = await host(t, { relay: true });
  try {
    await started.promise;
    await new Promise(resolve => setTimeout(resolve, 5200));
    const state = await request('state');
    assert.equal(state.status, 200);
    assert.equal(state.body.peers.find(value => value.id === peer.id).version, 'legacy');
  } finally {
    published.reject(new Error('late publish failure'));
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('native capability failures are visible in settings and reject requests before execution', async t => {
  const request = await host(t, { incompatible: true });
  const settings = await request('settings');
  assert.equal(settings.body.native.supported, false);
  assert.match(settings.body.native.error, /wireStream.open/);
  const probe = await request('native', { peerId: 'local', operation: 'probe' });
  assert.equal(probe.status, 409);
  assert.match(probe.body.error, /wireStream.failure/);
});

test('host runtime follows the DSH profile in state, settings and relay registration', async t => {
  const registrations = [];
  const fetchRelay = relayFetch(() => {}, []);
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (new URL(url).pathname === '/v1/register') registrations.push(JSON.parse(init.body));
    return fetchRelay(url, init);
  });
  for (const [profile, runtime] of [['desktop', 'desktop'], ['web', 'web'], ['custom-web', 'web']]) {
    const request = await host(t, { relay: true, profile });
    assert.equal((await request('state')).body.self.runtime, runtime);
    assert.equal((await request('settings')).body.runtime, runtime);
    assert.equal(registrations.at(-1).meta.runtime, runtime);
  }
});

test('peer runtime comes from the target metadata and stays unknown for older targets', async t => {
  const peers = [
    { ...peer, id: 'web', meta: { runtime: 'web' } },
    { ...peer, id: 'desktop', meta: { runtime: 'desktop' } },
    { ...peer, id: 'older' },
    { ...peer, id: 'invalid', meta: { runtime: 'linux' } },
  ];
  t.mock.method(globalThis, 'fetch', relayFetch(() => {}, peers));
  const request = await host(t, { relay: true, profile: 'desktop' });
  const state = (await request('state')).body;
  assert.equal(state.self.runtime, 'desktop');
  assert.deepEqual(Object.fromEntries(state.peers.map(value => [value.id, value.runtime])), {
    web: 'web', desktop: 'desktop', older: null, invalid: null,
  });
});

test('restart API acknowledges a prepared local restart and reports its live status', async t => {
  const job = {};
  const status = { supported: true, bootId: 'before', state: 'restarting' };
  let committed = 0;
  t.mock.method(RestartController.prototype, 'prepare', async () => job);
  t.mock.method(RestartController.prototype, 'status', () => status);
  t.mock.method(RestartController.prototype, 'commit', value => { assert.equal(value, job); committed++; });
  const request = await host(t);
  const result = await request('restart', { peerId: 'local', command: 'must never be executed' });
  assert.equal(result.status, 200);
  assert.equal(result.body.bootId, 'before');
  assert.equal(committed, 1);
  assert.equal((await request('restart/status', { peerId: 'local' })).body.state, 'restarting');
});

test('restart API routes only to the selected online peer and never forwards client commands', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', relayFetch(message => { calls.push(message); }, [peer], {
    restart: { supported: true, state: 'restarting', bootId: 'before' },
    restartStatus: { supported: true, state: 'idle', bootId: 'after' },
  }));
  const request = await host(t, { relay: true });
  const result = await request('restart', { peerId: peer.id, command: 'must never be executed' });
  assert.equal(result.body.bootId, 'before');
  const restart = calls.find(message => message.payload.method === 'restart');
  assert.equal(restart.to, peer.id);
  assert.deepEqual(restart.payload.params, {});
  assert.equal((await request('restart/status', { peerId: peer.id })).body.bootId, 'after');
  assert.equal((await request('restart', { peerId: 'unregistered' })).status, 409);
});

test('restart API rejects unauthorized requests and unsupported local lifecycles before execution', async t => {
  const denied = await host(t, { forbidden: true });
  assert.equal((await denied('restart', { peerId: 'local' })).status, 403);
  const request = await host(t);
  assert.equal((await request('restart/status', { peerId: 'local' })).body.supported, false);
  assert.equal((await request('restart', { peerId: 'local' })).status, 409);
});

test('transcript defaults to 100 messages and respects an explicit override', async t => {
  const sessionEvents = Array.from({ length: 150 }, (_, seq) => ({
    seq, type: 'user/message', time: seq, data: { content: [{ type: 'text', text: 'message ' + seq }] },
  }));
  for (const [config, expected] of [[{}, 100], [{ maxMessages: 7 }, 7]]) {
    const request = await host(t, { config, sessionEvents });
    const transcript = await request('transcript', { sessionId: 'session-fixture' });
    assert.equal(transcript.status, 200);
    assert.equal(transcript.body.total, 150);
    assert.equal(transcript.body.messages.length, expected);
    assert.equal(transcript.body.truncated, true);
  }
});

test('RPC publish failures reach the HTTP caller', async t => {
  t.mock.method(globalThis, 'fetch', relayFetch(message => {
    if (message.payload.method === 'native') return Promise.reject(new Error('publish failed'));
  }));
  const request = await host(t, { relay: true });
  const response = await request('native', { peerId: peer.id, operation: 'probe' });
  assert.equal(response.status, 500);
  assert.match(response.body.error, /publish failed/);
});

test('manual refresh wakes relay cooldown and preserves an established connection', { timeout: 25000 }, async t => {
  let available = false;
  let registrations = 0;
  let streams = 0;
  const fetchRelay = relayFetch(() => {}, []);
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const route = new URL(url).pathname;
    if (route === '/v1/register') registrations++;
    if (!available) return Promise.reject(new Error('relay unavailable'));
    if (route === '/v1/stream') streams++;
    return fetchRelay(url, init);
  });
  const request = await host(t, { relay: true });
  const deadline = Date.now() + 18000;
  let state;
  do {
    state = (await request('state')).body;
    if (state.relay.paused) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(state.relay.paused, true);
  assert.equal(registrations, 5);

  available = true;
  await request('refresh');
  const reconnectDeadline = Date.now() + 1000;
  do {
    state = (await request('state')).body;
    if (state.relay.connected) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < reconnectDeadline);
  assert.equal(state.relay.connected, true);
  assert.equal(state.relay.paused, false);
  assert.equal(registrations, 6);
  assert.equal(streams, 1);

  assert.equal((await request('refresh')).body.relay.connected, true);
  assert.equal(registrations, 6);
  assert.equal(streams, 1);
});

test('native HTTP uploads preserve binary bodies beyond the ordinary JSON limit', async t => {
  const request = await host(t);
  for (const size of [800 * 1024, 2 * 1024 * 1024]) {
    const bytes = Buffer.alloc(size, 0xa5);
    const response = await request('native', {
      peerId: 'local', clientId: 'upload', requestId: 'upload', operation: 'fetch',
      route: 'api/upload', method: 'POST', contentType: 'application/octet-stream',
      bodyBase64: bytes.toString('base64'),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(response.body.result.body, 'base64'), bytes);
  }
});

test('client resource HTTP route forwards revisioned URLs and raw bytes only to the selected online peer', async t => {
  const bytes = Buffer.alloc(700 * 1024, 0xa5);
  const calls = [];
  const released = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', relayFetch(message => {
    if (message.payload.method === 'native') calls.push(message);
    if (message.payload.params?.operation === 'release') released.resolve();
  }, [peer], { native: input => {
    if (input.operation === 'resource-open') return { resourceId: 'snapshot', length: bytes.length, contentType: 'application/javascript' };
    if (input.operation === 'resource-read') {
      const chunk = bytes.subarray(input.offset, input.offset + 256 * 1024);
      return { body: chunk.toString('base64'), next: input.offset + chunk.length };
    }
    return {};
  } }));
  const request = await host(t, { relay: true });
  const route = 'resource/remote/plugins/??@fixture/client.js&rev=revision';
  const response = await request.raw(route);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/javascript');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await released.promise;
  assert.equal(calls[0].payload.params.route, '/plugins/??@fixture/client.js&rev=revision');
  assert.ok(calls.every(call => call.to === peer.id && call.payload.params.clientId === calls[0].payload.params.clientId));
  assert.equal(calls.at(-1).payload.params.operation, 'release');
  const count = calls.length;
  assert.equal((await request.raw(route, { method: 'POST' })).status, 405);
  assert.equal((await request.raw('resource/unknown/plugins/file.js')).status, 409);
  assert.equal(calls.length, count);
  const denied = await host(t, { relay: true, forbidden: true });
  assert.equal((await denied.raw(route)).status, 403);
  assert.equal(calls.length, count);
});

test('malformed resource chunks abort the response and still release their remote snapshot', async t => {
  const calls = [];
  const released = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', relayFetch(() => {}, [peer], { native: input => {
    calls.push(input);
    if (input.operation === 'release') released.resolve();
    if (input.operation === 'resource-open') return { resourceId: 'bad', length: 20, contentType: 'application/javascript' };
    return { body: 'YQ==', next: 19 };
  } }));
  const request = await host(t, { relay: true });
  await assert.rejects(async () => {
    const response = await request.raw('resource/remote/plugins/??fixture/client.js&rev=revision');
    await response.arrayBuffer();
  });
  await released.promise;
  assert.equal(calls.at(-1).operation, 'release');
});

test('resource reads overlap within a bounded window and preserve bytes despite out-of-order replies', async t => {
  const chunkSize = 256 * 1024;
  const bytes = Buffer.alloc(chunkSize * 12 + 37);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  let active = 0;
  let maximum = 0;
  const completed = [];
  const released = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', relayFetch(() => {}, [peer], { native: async input => {
    if (input.operation === 'release') { released.resolve(); return {}; }
    if (input.operation === 'resource-open') return { resourceId: 'parallel', length: bytes.length, chunkSize, contentType: 'application/javascript', immutable: true };
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, input.offset % (4 * chunkSize) === 0 ? 30 : 1));
    active -= 1;
    completed.push(input.offset);
    const chunk = bytes.subarray(input.offset, input.offset + chunkSize);
    return { body: chunk.toString('base64'), next: input.offset + chunk.length };
  } }));
  const request = await host(t, { relay: true });
  const response = await request.raw('resource/remote/plugins/??fixture/client.js&rev=parallel');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await released.promise;
  assert.equal(maximum, 4);
  assert.notEqual(completed[0], 0, 'the first chunk must finish after a prefetched chunk');
  assert.equal(completed.length, 13);
});

test('resource caching requires both a versioned URL and an immutable upstream artifact', async t => {
  let immutable = true;
  t.mock.method(globalThis, 'fetch', relayFetch(() => {}, [peer], { native: input => {
    if (input.operation === 'resource-open') return { resourceId: 'cache', length: 0, chunkSize: 256 * 1024, contentType: 'application/javascript', immutable };
    return {};
  } }));
  const request = await host(t, { relay: true });
  const first = await request.raw('resource/remote/plugins/fixture/client.js?rev=first');
  assert.equal(first.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  const changed = await request.raw('resource/remote/plugins/fixture/client.js?rev=changed');
  assert.notEqual(first.url, changed.url);
  assert.equal(changed.headers.get('cache-control'), first.headers.get('cache-control'));
  assert.equal((await request.raw('resource/remote/plugins/fixture/client.js')).headers.get('cache-control'), 'private, no-store');
  immutable = false;
  assert.equal((await request.raw('resource/remote/plugins/fixture/client.js?rev=mutable')).headers.get('cache-control'), 'private, no-store');
});

test('failed prefetched reads release the snapshot and observe other pending rejections', async t => {
  const chunkSize = 256 * 1024;
  const released = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let reads = 0;
  t.mock.method(globalThis, 'fetch', relayFetch(message => {
    const input = message.payload.params;
    if (input?.operation === 'resource-read') {
      return new Promise((resolve, reject) => setTimeout(() => {
        reads += 1;
        if (reads === 4) finished.resolve();
        reject(new Error('prefetch failed'));
      }, input.offset === 0 ? 1 : 30));
    }
  }, [peer], { native: input => {
    if (input.operation === 'resource-open') return { resourceId: 'failure', length: 4 * chunkSize, chunkSize, contentType: 'application/javascript' };
    if (input.operation === 'release') released.resolve();
    return {};
  } }));
  const request = await host(t, { relay: true });
  await assert.rejects(async () => {
    const response = await request.raw('resource/remote/plugins/fixture/client.js?rev=failed');
    await response.arrayBuffer();
  });
  await released.promise;
  await finished.promise;
  assert.equal(reads, 4);
});

test('oversized ordinary and native bodies return JSON 413 without resetting the socket', async t => {
  const request = await host(t);
  for (const [action, limit] of [['state', 1024 * 1024], ['native', 32 * 1024 * 1024]]) {
    const body = Buffer.alloc(limit + 1, 0x20);
    body[0] = 0x7b;
    body[body.length - 1] = 0x7d;
    const response = await request(action, body);
    assert.equal(response.status, 413);
    assert.equal(response.body.ok, false);
    assert.match(response.body.error, /body too large/);
  }
  assert.equal((await request('state')).status, 200);
});
