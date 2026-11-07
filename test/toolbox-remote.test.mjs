import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler, PREFIX } from '../lib/toolbox-server.js';
import { createHostRuntime } from '../toolbox/web/src/hostRuntime.js';

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)) };
}

function frame(host) {
  const win = { parent: host, frameElement: { getAttribute: () => '1' },
    location: { search: '' }, document: { baseURI: host.document.baseURI }, localStorage: storage(), btoa };
  win.fetch = () => { throw new Error('iframe local transport must not be used'); };
  return win;
}

test('remote iframe reads and writes the selected backend through the host, with isolated credentials', async t => {
  const seen = [], carried = [];
  let refreshes = 0;
  const backend = await serve(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    assert.equal(req.headers.authorization, 'Bearer remote-test-key');
    assert.equal(req.headers.cookie, undefined);
    if (req.method === 'POST') refreshes++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accounts: [{ uid: 'remote-account', credits: 4321 }], refreshes }));
  });
  const plugin = await serve(t, createHandler({ backendPort: backend.port }));
  const host = { document: { baseURI: plugin.url + '/' }, localStorage: storage(), __DSH_REMOTE_SESSION__: { peerId: 'home' },
    // The real remote transport drops Authorization and Cookie headers.
    fetch: (url, options) => {
      assert.equal(new Headers(options.headers).has('authorization'), false);
      carried.push({ url, ...JSON.parse(options.body) });
      return fetch(url, options);
    } };
  const child = frame(host), runtime = createHostRuntime(child);
  child.localStorage.setItem('wb2api.key', 'local-test-key');
  runtime.storage.setItem('wb2api.key', 'remote-test-key');
  assert.equal(host.localStorage.getItem('wb2api.key'), 'remote-test-key');
  assert.equal(child.localStorage.getItem('wb2api.key'), 'local-test-key');
  const headers = { authorization: 'Bearer ' + runtime.storage.getItem('wb2api.key') };
  const result = await (await runtime.fetchAPI(runtime.apiBase + 'overview', { headers })).json();
  assert.equal(result.accounts[0].uid, 'remote-account');
  assert.equal(result.accounts[0].credits, 4321);
  for (const path of ['config', 'balance_all', 'desktop/switch', 'benefits/accounts/remote-account/rewards']) {
    await runtime.fetchAPI(runtime.apiBase + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{"confirmed":true}' });
  }
  assert.equal(refreshes, 4);
  assert.ok(seen.every(item => item.url.startsWith('/panel/api/')));
  assert.ok(carried.every(item => item.url === plugin.url + PREFIX + 'bridge'));
  const multipart = new FormData();
  multipart.append('file', new Blob([new Uint8Array([0, 128, 255])]), 'test.json');
  await runtime.fetchAPI(runtime.apiBase + 'import/cockpit?replace=1', { method: 'POST', headers, body: multipart });
  assert.match(seen.at(-1).headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.equal(seen.at(-1).url, '/panel/api/import/cockpit?replace=1');
  assert.ok(seen.at(-1).body.includes(Buffer.from([0, 128, 255])));
});

test('remote failures, cancellation and machine changes never fall back to local data', async () => {
  const host = { document: { baseURI: 'http://localhost/' }, localStorage: storage(), __DSH_REMOTE_SESSION__: { peerId: 'home' } };
  let calls = 0;
  host.fetch = async () => { calls++; throw new Error('remote offline'); };
  const runtime = createHostRuntime(frame(host));
  await assert.rejects(runtime.fetchAPI(runtime.apiBase + 'overview'), /remote offline/);
  assert.equal(calls, 1);
  host.__DSH_REMOTE_SESSION__.peerId = 'local';
  await assert.rejects(runtime.fetchAPI(runtime.apiBase + 'overview'), /已切换电脑/);
  assert.equal(calls, 1);
  host.__DSH_REMOTE_SESSION__.peerId = 'home';
  const abort = new AbortController();
  abort.abort();
  host.fetch = async (_url, options) => { options.signal.throwIfAborted(); };
  const cancelled = createHostRuntime(frame(host));
  await assert.rejects(cancelled.fetchAPI(cancelled.apiBase + 'overview', { signal: abort.signal }), { name: 'AbortError' });
  host.fetch = async () => { host.__DSH_REMOTE_SESSION__.peerId = 'other'; return Response.json({ accounts: ['stale'] }); };
  const stale = createHostRuntime(frame(host));
  await assert.rejects(stale.fetchAPI(stale.apiBase + 'overview'), /已切换电脑/);
});

test('standalone and local DSH retain their normal API authentication', async () => {
  const calls = [];
  const host = { document: { baseURI: 'http://localhost/' }, localStorage: storage(), fetch: async (...args) => { calls.push(args); return Response.json({ machine: 'local' }); } };
  const local = createHostRuntime(frame(host));
  await local.fetchAPI(local.apiBase + 'overview', { headers: { authorization: 'Bearer local-key' } });
  assert.equal(calls[0][0], 'http://localhost/workbuddy-accounts/api/overview');
  assert.equal(calls[0][1].headers.authorization, 'Bearer local-key');
  const standalone = { ...host, location: { search: '' } };
  standalone.parent = standalone;
  const normal = createHostRuntime(standalone);
  assert.equal(normal.embedded, false);
  assert.equal(normal.apiBase, null);
  assert.equal(normal.storage, standalone.localStorage);
});

test('remote bridge validates paths, methods, credentials and origin before forwarding', async t => {
  let requests = 0;
  const backend = await serve(t, (_req, res) => { requests++; res.writeHead(401); res.end('{"error":"invalid_api_key"}'); });
  const plugin = await serve(t, createHandler({ backendPort: backend.port }));
  const payload = { path: 'overview', method: 'GET', authorization: 'Bearer test' };
  const post = (data, headers = {}) => fetch(plugin.url + PREFIX + 'bridge', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
  for (const path of ['../healthz', '%2e%2e/healthz', 'http://other/', '/overview', 'overview#secret']) assert.equal((await post({ ...payload, path })).status, 400);
  for (const extra of [{ method: 'DELETE' }, { authorization: '' }, { body: 'a===' }, { method: 'POST', body: 'a===' }, { contentType: 'test\r\nCookie: secret' }]) {
    assert.ok([400, 401].includes((await post({ ...payload, ...extra })).status));
  }
  assert.equal((await post(payload, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(payload, { 'x-forwarded-for': '127.0.0.1' })).status, 403);
  assert.equal(requests, 0);
  const denied = await post(payload);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, 'invalid_api_key');
  assert.equal(requests, 1);
  assert.deepEqual(await (await fetch(plugin.url + PREFIX + 'runtime')).json(), { protocol: 1 });
});
