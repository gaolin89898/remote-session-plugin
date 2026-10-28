import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { NativeGateway } from '../lib/native-gateway.js';
import { installNativeTransport } from '../lib/native-transport.js';

function storage(entries = []) {
  const values = new Map(entries);
  return {
    getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

const coreEntries = ['dsh-remote-session', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-api-session-controller'];

function fixture(options = {}) {
  const calls = [];
  let disposed = 0;
  const entries = (options.clientEntries || coreEntries).map(id => ({ id, url: 'plugins/??' + id + '/client.js&rev=fixture', rev: 'fixture' }));
  const gateway = new NativeGateway({
    webServer: {
      getOrigin: () => options.origin || 'http://127.0.0.1:1',
      match: options.match || (pathname => pathname.startsWith('/dsh-market/') ? { kind: 'prefix', path: '/dsh-market/' } : null),
    },
    clientModules: {
      graph: () => options.graph || ({ rev: 'fixture', entries, batches: [{ phase: 'application', url: 'plugins/??batch/client.js&rev=fixture', rev: 'fixture', entries: entries.map(e => e.id) }] }),
      fetchBundle: async request => options.resource ? options.resource(request) : new Response('fixture', { headers: { 'content-type': 'application/javascript' } }),
    },
    connection: {
      authenticatedUrl: url => url + '?token=private-launch-token',
      createPeer: () => ({ dispose: async () => { disposed += 1; } }),
      createSharedFetchHandler: () => ({ fetch: async request => {
        const body = new Uint8Array(await request.arrayBuffer());
        return new Response(body, { headers: { 'content-type': request.headers.get('content-type') || 'application/octet-stream' } });
      } }),
    },
    typertGateway: { wireStream: {
      open: async function *(endpoint, payload, uplink, peer, signal) {
        calls.push({ endpoint, payload, peer });
        if (endpoint === 'fail') throw Object.assign(new Error('forbidden'), { code: 'gateway/interactions-forbidden' });
        if (endpoint === 'hold') { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return; }
        if (endpoint === 'echo') { yield *uplink; return; }
        yield { machine: 'company', payload };
      },
      failure: error => ({ code: error.code || 'gateway/internal', message: error.message, details: {} }),
    } },
  });
  const nativeCalls = [];
  const localCalls = [];
  const localStorage = storage([['dsh.conversation.same-id', 'local draft'], ['third-party.preference', 'local preference']]);
  let reloaded = false;
  const win = {
    crypto: webcrypto, atob, btoa, document: { baseURI: options.baseURI || 'http://localhost/mounted/' },
    sessionStorage: storage([['dsh.remote-session.machine.v1', 'company']]), localStorage,
    location: { reload: () => { reloaded = true; } }, addEventListener: () => {},
    __DSH_TRANSPORT__: options.transport,
    __ModuleLoader__: { mode: 'queue', pendingQueue: [] },
    fetch: async (url, init) => {
      if (new URL(url).pathname !== new URL('remote-session/api/native', win.document.baseURI).pathname) {
        localCalls.push(String(url));
        return Response.json({ machine: 'local' });
      }
      const input = JSON.parse(init.body);
      nativeCalls.push(input);
      const result = await gateway.dispatch('home', input);
      return Response.json({ ok: true, result });
    },
  };
  installNativeTransport(win);
  return { win, gateway, localStorage, calls, nativeCalls, localCalls, disposed: () => disposed, reloaded: () => reloaded };
}

async function httpFixture(t, handler, options = {}) {
  const seen = [];
  const failures = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      seen.push(url.pathname);
      if (url.pathname === '/') {
        assert.equal(url.searchParams.get('token'), 'private-launch-token');
        res.writeHead(303, { 'set-cookie': 'dsh-auth=target-private; HttpOnly; SameSite=Strict; Path=/', location: '/' });
        res.end();
        return;
      }
      assert.equal(req.headers.cookie, 'dsh-auth=target-private');
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers.origin, 'http://127.0.0.1:' + server.address().port);
      await handler(req, res);
    } catch (error) { failures.push(error); res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const f = fixture({ ...options, origin: 'http://127.0.0.1:' + server.address().port });
  t.after(async () => {
    await f.gateway.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  return { ...f, seen };
}

test('plugin HTTP reads and writes target the selected host without exposing its authentication', async t => {
  let enabled = true;
  const f = await httpFixture(t, async (req, res) => {
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      enabled = JSON.parse(Buffer.concat(chunks)).enabled;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'plugin-secret=private' });
    res.end(JSON.stringify({ machine: 'company', plugins: ['remote-only'], enabled, query: req.url.split('?')[1] }));
  });
  const first = await f.win.fetch('/dsh-market/installed?tab=installed', {
    headers: { cookie: 'local-cookie', authorization: 'Bearer local-token' },
  });
  assert.deepEqual(await first.json(), { machine: 'company', plugins: ['remote-only'], enabled: true, query: 'tab=installed' });
  assert.equal(first.headers.has('set-cookie'), false);
  const updated = await f.win.fetch('dsh-market/toggle', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  });
  assert.equal((await updated.json()).enabled, false);
  assert.equal(enabled, false);
  assert.deepEqual(f.seen, ['/', '/dsh-market/installed', '/dsh-market/toggle']);
  assert.equal(f.localCalls.length, 0);
  assert.ok(f.nativeCalls.every(call => call.peerId === 'company'));
  assert.ok(!JSON.stringify(f.nativeCalls).includes('target-private'));
  assert.ok(!JSON.stringify(f.nativeCalls).includes('private-launch-token'));
  assert.equal([...f.gateway.clients.values()][0].streams.size, 0);
});

test('registered HTTP routes support desktop URLs while machine controls and external fetch stay local', async t => {
  const f = await httpFixture(t, (_req, res) => res.end('remote'), {
    baseURI: 'dsh-app://app/', match: pathname => pathname === '/another-plugin/settings' ? { path: pathname } : null,
  });
  assert.equal(await (await f.win.fetch('another-plugin/settings')).text(), 'remote');
  assert.equal((await (await f.win.fetch('dsh-app://app/remote-session/api/state')).json()).machine, 'local');
  assert.equal((await (await f.win.fetch('https://external.example/catalog')).json()).machine, 'local');
  assert.deepEqual(f.localCalls, ['dsh-app://app/remote-session/api/state', 'https://external.example/catalog']);
  const probe = await f.gateway.dispatch('home', { operation: 'probe' });
  assert.equal(probe.httpProtocol, 1);
  f.gateway.dispatch = async () => ({ ...probe, httpProtocol: undefined });
  await assert.rejects(f.win.__DSH_REMOTE_SESSION__.switchMachine('older'), /1\.2\.2/);
  assert.equal(f.reloaded(), false);
});

test('plugin HTTP refuses unregistered routes and other services, and never follows redirects', async t => {
  const f = await httpFixture(t, (_req, res) => {
    res.writeHead(302, { location: '/api/private', 'set-cookie': 'redirect-secret=private' });
    res.end();
  });
  const input = { operation: 'http-open', clientId: 'http-test', streamId: 'http-stream', method: 'GET' };
  for (const route of ['http://external/dsh-market/installed', '//external/dsh-market/installed', '/api/settings',
    '/', '/index.html', '/plugins/foo', '/assets/foo', '/connect', '/remote-session/api/native', '/dsh-market/../api/private']) {
    await assert.rejects(f.gateway.dispatch('home', { ...input, route }), /Invalid plugin HTTP route/);
  }
  await assert.rejects(f.win.fetch('/unknown-plugin/settings'), error => error.status === 404);
  f.gateway.ctx.webServer.match = () => ({ path: '/' });
  await assert.rejects(f.win.fetch('/fallback'), error => error.status === 404);
  f.gateway.ctx.webServer.match = () => ({ path: '/dsh-market/' });
  const response = await f.win.fetch('/dsh-market/redirect');
  assert.equal(response.status, 302);
  assert.equal(response.headers.has('location'), false);
  assert.equal(response.headers.has('set-cookie'), false);
  await response.text();
  assert.deepEqual(f.seen, ['/', '/dsh-market/redirect']);
});

test('plugin HTTP streams large binary responses and preserves empty and error responses', async t => {
  const bytes = Buffer.from(Array.from({ length: 1500000 }, (_, index) => index % 256));
  const f = await httpFixture(t, (req, res) => {
    if (req.url.endsWith('empty')) { res.writeHead(204); res.end(); return; }
    if (req.url.endsWith('missing')) { res.writeHead(404); res.end('missing remotely'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    res.end(bytes);
  });
  const response = await f.win.fetch('/dsh-market/export');
  assert.equal(response.headers.has('content-length'), false);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.ok(f.nativeCalls.filter(call => call.operation === 'pull').length > 1);
  for (const [route, method, status] of [['export', 'HEAD', 200], ['empty', 'GET', 204]]) {
    const empty = await f.win.fetch('/dsh-market/' + route, { method });
    assert.equal(empty.status, status);
    assert.equal(empty.body, null);
  }
  const missing = await f.win.fetch('/dsh-market/missing');
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'missing remotely');
});

test('plugin HTTP returns headers before completion and cancels pending remote reads', { timeout: 10000 }, async t => {
  const closed = [];
  const f = await httpFixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('started');
    res.on('close', () => closed.push(req.url));
  });
  for (const mode of ['abort', 'cancel']) {
    const abort = new AbortController();
    const response = await f.win.fetch('/dsh-market/slow-' + mode, { signal: abort.signal });
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'started');
    const pending = reader.read();
    if (mode === 'abort') {
      const rejected = assert.rejects(pending, error => error.name === 'AbortError');
      abort.abort();
      await rejected;
    } else { await reader.cancel(); assert.equal((await pending).done, true); }
  }
  const deadline = Date.now() + 2000;
  while (closed.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(closed.sort(), ['/dsh-market/slow-abort', '/dsh-market/slow-cancel']);
  assert.equal([...f.gateway.clients.values()][0].streams.size, 0);
});

test('native unary fetch preserves binary bodies and cancellation target', async () => {
  const f = fixture();
  try {
    const bytes = Uint8Array.from([0, 255, 1, 128]);
    const response = await f.win.__DSH_TRANSPORT__.fetch('api/test/bytes', {
      method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream' },
    });
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.ok(f.nativeCalls.every(call => call.peerId === 'company'));
    await assert.rejects(f.gateway.dispatch('home', {
      operation: 'fetch', clientId: 'client', requestId: 'request', method: 'GET', route: 'http://external/api/test',
    }), /Invalid native API route/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(f.win.__DSH_TRANSPORT__.fetch('api/test/bytes', { signal: abort.signal }));
  } finally { await f.gateway.dispose(); }
});

test('native probes identify missing host APIs and reject malformed client graphs', async () => {
  const f = fixture();
  try {
    const required = [
      [f.gateway.ctx.connection, 'createPeer'], [f.gateway.ctx.connection, 'createSharedFetchHandler'],
      [f.gateway.ctx.typertGateway.wireStream, 'open'], [f.gateway.ctx.typertGateway.wireStream, 'failure'],
      [f.gateway.ctx.clientModules, 'graph'],
      [f.gateway.ctx.clientModules, 'fetchBundle'],
      [f.gateway.ctx.webServer, 'match'], [f.gateway.ctx.webServer, 'getOrigin'],
      [f.gateway.ctx.connection, 'authenticatedUrl'],
    ];
    for (const [owner, key] of required) {
      const original = owner[key];
      owner[key] = null;
      assert.equal(f.gateway.status().supported, false);
      await assert.rejects(f.gateway.dispatch('home', { operation: 'probe' }), error => error.status === 409 && error.message.includes(key));
      owner[key] = original;
    }
    for (const graph of [null, { entries: null }, { entries: [{}] }]) {
      f.gateway.ctx.clientModules.graph = () => graph;
      await assert.rejects(f.gateway.dispatch('home', { operation: 'probe' }), error => error.status === 409 && /DSH/.test(error.message));
    }
    f.gateway.ctx.clientModules.graph = () => { throw new Error('unavailable'); };
    await assert.rejects(f.gateway.dispatch('home', { operation: 'probe' }), error => error.status === 409 && /DSH/.test(error.message));
    assert.equal(f.gateway.clients.size, 0);
  } finally { await f.gateway.dispose(); }
});

test('machine switching rejects missing target UI components before changing selection', async () => {
  const f = fixture({ clientEntries: ['dsh-remote-session'] });
  try {
    await assert.rejects(f.win.__DSH_REMOTE_SESSION__.switchMachine('another'), /dsh-client-ui-workspace/);
    assert.equal(f.win.sessionStorage.getItem('dsh.remote-session.machine.v1'), 'company');
    assert.equal(f.reloaded(), false);
  } finally { await f.gateway.dispose(); }
});

test('remote boot loads the target composition, including remote-only plugins, before desktop activation', async () => {
  const f = fixture({ clientEntries: [...coreEntries, 'dependent-ui', '@deepseek-ai/dsh-client-hmr'],
    transport: { rpc: { call() { throw new Error('local RPC leaked'); } }, streamBaseUrl: 'http://127.0.0.1:9000' } });
  const translation = '@deepseek-ai/dsh-experimental-client-ui-cot-translation';
  const localOnly = [translation, 'dependent-ui', '@deepseek-ai/dsh-client-hmr'];
  const entries = [...coreEntries, ...localOnly].map(id => ({
    id, url: 'plugins/' + id, rev: 'fixture', ...(id === 'dependent-ui' ? { inject: [translation] } : {}),
  }));
  try {
    const original = { rev: 'fixture', entries, batches: [{ phase: 'application', url: 'plugins/batch', rev: 'fixture', entries: entries.map(e => e.id) }] };
    f.win.__DSH_BOOT__ = original;
    await f.win.__DSH_BOOT_READY__.resolve();
    await f.win.__DSH_BOOT_READY__.promise;
    assert.deepEqual(f.win.__DSH_BOOT__.entries.map(e => e.id), [...coreEntries, 'dependent-ui']);
    assert.deepEqual(f.win.__DSH_BOOT__.batches[0].entries, [...coreEntries, 'dependent-ui']);
    assert.ok(f.win.__DSH_BOOT__.entries.every(entry => entry.url.startsWith('http://localhost/mounted/remote-session/api/resource/company/plugins/')));
    assert.equal(original.entries.length, entries.length, 'the local graph must stay intact');
    assert.equal(f.win.__DSH_TRANSPORT__.rpc, undefined);
    assert.equal(f.win.__DSH_TRANSPORT__.streamBaseUrl, 'http://127.0.0.1:9000');
    assert.equal(f.reloaded(), false);
  } finally { await f.gateway.dispose(); }
});

test('unavailable or incompatible remote boot restores local selection without opening desktop recovery', async () => {
  for (const offline of [false, true]) {
    const f = fixture();
    try {
      if (offline) f.gateway.dispatch = async () => { throw new Error('offline'); };
      else f.gateway.ctx.clientModules.graph = () => ({ entries: [], batches: [] });
      let started = false;
      void f.win.__DSH_BOOT_READY__.promise.then(() => { started = true; });
      await f.win.__DSH_BOOT_READY__.resolve();
      assert.equal(f.win.sessionStorage.getItem('dsh.remote-session.machine.v1'), 'local');
      assert.equal(f.reloaded(), true);
      assert.equal(started, false);
      assert.ok(f.win.sessionStorage.getItem('dsh.remote-session.boot-failure.v1'));
    } finally { await f.gateway.dispose(); }
  }
});

test('remote resources are revisioned registry artifacts, transferred in bounded chunks and isolated by source', async () => {
  const bytes = Buffer.from('remote-module-\u4e2d\u6587\n'.repeat(100000));
  const seen = [];
  const f = fixture({ resource: async request => {
    seen.push(request.url);
    return request.url.endsWith('rev=fixture') ? new Response(bytes, { headers: { 'content-type': 'application/javascript' } }) : new Response(null, { status: 404 });
  } });
  const input = { clientId: 'assets', operation: 'resource-open', route: '/plugins/??remote-only/client.js&rev=fixture' };
  try {
    const resource = await f.gateway.dispatch('home', input);
    assert.equal(resource.length, bytes.length);
    assert.equal(resource.contentType, 'application/javascript');
    const chunks = [];
    for (let offset = 0; offset < resource.length;) {
      const chunk = await f.gateway.dispatch('home', { clientId: input.clientId, operation: 'resource-read', resourceId: resource.resourceId, offset });
      const body = Buffer.from(chunk.body, 'base64');
      assert.ok(body.length <= 256 * 1024);
      chunks.push(body); offset = chunk.next;
    }
    assert.deepEqual(Buffer.concat(chunks), bytes);
    await assert.rejects(f.gateway.dispatch('stranger', { clientId: input.clientId, operation: 'resource-read', resourceId: resource.resourceId, offset: 0 }), /expired/);
    for (const route of ['http://outside/plugins/file', '/api/settings', '/plugins/../../etc/passwd', '/remote-session/api/native']) {
      await assert.rejects(f.gateway.dispatch('home', { ...input, route }), /Invalid client resource/);
    }
    assert.equal(seen.length, 1);
    await assert.rejects(f.gateway.dispatch('home', { ...input, route: '/plugins/not-advertised' }), error => error.status === 404);
    await f.gateway.dispatch('home', { clientId: input.clientId, operation: 'resource-close', resourceId: resource.resourceId });
    await assert.rejects(f.gateway.dispatch('home', { clientId: input.clientId, operation: 'resource-read', resourceId: resource.resourceId, offset: 0 }), /expired/);
  } finally { await f.gateway.dispose(); }
});

test('full remote composition rejects older peers and external script URLs before activation', async () => {
  for (const legacy of [true, false]) {
    const f = fixture();
    try {
      if (legacy) f.gateway.ctx.clientModules.fetchBundle = undefined;
      else {
        const graph = f.gateway.ctx.clientModules.graph();
        graph.entries[0].url = 'https://outside/client.js';
        f.gateway.ctx.clientModules.graph = () => graph;
      }
      let activated = false;
      void f.win.__DSH_BOOT_READY__.promise.then(() => { activated = true; });
      await f.win.__DSH_BOOT_READY__.resolve();
      assert.equal(activated, false);
      assert.equal(f.reloaded(), true);
      assert.equal(f.win.sessionStorage.getItem('dsh.remote-session.machine.v1'), 'local');
    } finally { await f.gateway.dispose(); }
  }
});

test('pending resource opens count toward the transfer limit and cannot outlive client release', async () => {
  const ready = Promise.withResolvers();
  const f = fixture({ resource: async () => { await ready.promise; return new Response('module'); } });
  const request = { clientId: 'assets', operation: 'resource-open', route: '/plugins/??fixture/client.js&rev=fixture' };
  try {
    const pending = Array.from({ length: 4 }, () => f.gateway.dispatch('home', request));
    const settled = Promise.allSettled(pending);
    await assert.rejects(f.gateway.dispatch('home', request), /Too many/);
    await f.gateway.dispatch('home', { clientId: 'assets', operation: 'release' });
    ready.resolve();
    const results = await settled;
    assert.ok(results.every(result => result.status === 'rejected' && /expired/.test(result.reason.message)));
    assert.equal(f.gateway.clients.size, 0);
  } finally { ready.resolve(); await f.gateway.dispose(); }
});

test('native streams preserve values, uplink, typed failures and close scopes', async () => {
  const f = fixture();
  try {
    const transport = f.win.__DSH_TRANSPORT__;
    const values = [];
    for await (const value of transport.openStream('session/follow', { args: { id: 'same-id' } }, new AbortController().signal)) values.push(value);
    assert.deepEqual(values, [{ machine: 'company', payload: { args: { id: 'same-id' } } }]);
    async function *upload() { yield { n: 1 }; yield { n: 2 }; }
    const echo = [];
    for await (const value of transport.openStream('echo', {}, new AbortController().signal, upload())) echo.push(value);
    assert.deepEqual(echo, [{ n: 1 }, { n: 2 }]);
    await assert.rejects(async () => {
      for await (const _value of transport.openStream('fail', {}, new AbortController().signal)) {}
    }, error => error.dshRemoteStreamFailure.kind === 'remote' && error.dshRemoteStreamFailure.code === 'gateway/interactions-forbidden');
    const abort = new AbortController();
    const iterator = transport.openStream('hold', {}, abort.signal);
    const pending = iterator.next();
    await new Promise(resolve => setTimeout(resolve, 10)); abort.abort();
    await assert.rejects(pending);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok([...f.gateway.clients.values()].every(client => client.streams.size === 0));
  } finally { await f.gateway.dispose(); }
  assert.ok(f.disposed() >= 1);
});

test('streams cannot be pulled by another source and duplicate pulls replay once', async () => {
  const f = fixture();
  const request = { clientId: 'test', streamId: 'one' };
  try {
    await f.gateway.dispatch('home', { ...request, operation: 'open', endpoint: 'stream', payload: {} });
    const first = await f.gateway.dispatch('home', { ...request, operation: 'pull', sequence: 0 });
    const replay = await f.gateway.dispatch('home', { ...request, operation: 'pull', sequence: 0 });
    assert.deepEqual(first, replay);
    await assert.rejects(f.gateway.dispatch('stranger', { ...request, operation: 'pull', sequence: 0 }), /expired/);
    await assert.rejects(f.gateway.dispatch('home', { ...request, operation: 'pull', sequence: 3 }), /sequence/);
  } finally { await f.gateway.dispose(); }
});

test('native history snapshots are fragmented across bounded relay replies', async () => {
  const f = fixture();
  try {
    const payload = { history: '\u4e2d\u6587\n'.repeat(200000) };
    const values = [];
    for await (const value of f.win.__DSH_TRANSPORT__.openStream('session/follow', payload, new AbortController().signal)) values.push(value);
    assert.deepEqual(values, [{ machine: 'company', payload }]);
    assert.ok(f.nativeCalls.filter(call => call.operation === 'pull').length > 1);
  } finally { await f.gateway.dispose(); }
});

test('machine selections and drafts remain isolated; returning local preserves its carrier', async () => {
  const f = fixture();
  try {
    assert.equal(f.win.localStorage.getItem('dsh.conversation.same-id'), null);
    f.win.localStorage.setItem('dsh.conversation.same-id', 'company draft');
    assert.equal(f.localStorage.getItem('dsh.conversation.same-id'), 'local draft');
    assert.equal(f.localStorage.getItem('dsh.remote-session.host.company.dsh.conversation.same-id'), 'company draft');
    assert.equal(f.win.localStorage.getItem('third-party.preference'), null);
    f.win.localStorage.setItem('third-party.preference', 'remote preference');
    assert.equal(f.localStorage.getItem('third-party.preference'), 'local preference');
    f.win.localStorage.clear();
    assert.equal(f.localStorage.getItem('dsh.conversation.same-id'), 'local draft');
    assert.equal(f.localStorage.getItem('third-party.preference'), 'local preference');
    assert.equal(f.win.localStorage.length, 0);
    await f.win.__DSH_REMOTE_SESSION__.switchMachine('local');
    assert.equal(f.win.sessionStorage.getItem('dsh.remote-session.machine.v1'), 'local');
    assert.equal(f.reloaded(), true);
    const original = {};
    const local = { ...f.win, __DSH_REMOTE_SESSION__: undefined, __DSH_TRANSPORT__: original, localStorage: f.localStorage };
    installNativeTransport(local);
    assert.equal(local.__DSH_TRANSPORT__, original);
    assert.equal(local.localStorage, f.localStorage);
  } finally { await f.gateway.dispose(); }
});
