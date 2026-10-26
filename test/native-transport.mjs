import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
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
  const gateway = new NativeGateway({
    clientModules: { graph: () => ({ entries: (options.clientEntries || coreEntries).map(id => ({ id })) }) },
    connection: {
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
  const localStorage = storage([['dsh.conversation.same-id', 'local draft']]);
  let reloaded = false;
  const win = {
    crypto: webcrypto, atob, btoa, document: { baseURI: 'http://localhost/mounted/' },
    sessionStorage: storage([['dsh.remote-session.machine.v1', 'company']]), localStorage,
    location: { reload: () => { reloaded = true; } }, addEventListener: () => {},
    __DSH_TRANSPORT__: options.transport,
    fetch: async (url, init) => {
      assert.equal(new URL(url).pathname, '/mounted/remote-session/api/native');
      const input = JSON.parse(init.body);
      nativeCalls.push(input);
      const result = await gateway.dispatch('home', input);
      return Response.json({ ok: true, result });
    },
  };
  installNativeTransport(win);
  return { win, gateway, localStorage, calls, nativeCalls, disposed: () => disposed, reloaded: () => reloaded };
}

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

test('remote boot excludes unsupported plugins and their dependents before desktop activation', async () => {
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
    assert.deepEqual(f.win.__DSH_BOOT__.entries.map(e => e.id), coreEntries);
    assert.deepEqual(f.win.__DSH_BOOT__.batches[0].entries, coreEntries);
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
      else f.win.__DSH_BOOT__ = { entries: [], batches: [] };
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
    f.win.localStorage.clear();
    assert.equal(f.localStorage.getItem('dsh.conversation.same-id'), 'local draft');
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
