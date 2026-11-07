import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler, localRequest, PREFIX } from '../lib/toolbox-server.js';
import { registerToolboxRoute } from '../lib/index.js';

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

test('local bridge rejects remote peers, DNS rebinding, cross-origin and forwarded requests', () => {
  const request = (headers = {}, address = '127.0.0.1') => ({ socket: { remoteAddress: address }, headers: { host: '127.0.0.1:3080', ...headers } });
  assert.equal(localRequest(request()), true);
  assert.equal(localRequest(request({ origin: 'http://127.0.0.1:3080' })), true);
  for (const headers of [
    { host: 'evil.example:3080' }, { origin: 'http://evil.example' },
    { origin: 'http://127.0.0.1:5174' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { forwarded: 'for=1.2.3.4' },
    { 'x-forwarded-for': '127.0.0.1' }, { host: 'evil@127.0.0.1:3080' },
  ]) assert.equal(localRequest(request(headers)), false, JSON.stringify(headers));
  assert.equal(localRequest(request({}, '192.168.1.9')), false);
  assert.throws(() => createHandler({ backendPort: 'http://evil.example' }));
});

test('forwards the supplied Bearer key and JSON to the fixed local API only', async t => {
  const requests = [];
  const backend = await serve(t, (req, res) => {
    requests.push({ url: req.url, headers: req.headers, method: req.method });
    res.writeHead(200, { 'content-type': 'application/json' });
    req.pipe(res);
  });
  const ui = await serve(t, createHandler({ backendPort: backend.port }));
  const response = await fetch(ui.url + PREFIX + 'api/accounts/test/tasks/auto?check=1', {
    method: 'POST', headers: { Authorization: 'Bearer unit-test', 'content-type': 'application/json', Cookie: 'dsh_secret=private', Origin: ui.url },
    body: JSON.stringify({ task_code: 'test' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { task_code: 'test' });
  assert.equal(requests[0].url, '/panel/api/accounts/test/tasks/auto?check=1');
  assert.equal(requests[0].headers.authorization, 'Bearer unit-test');
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(requests[0].headers.origin, undefined);
  assert.equal(requests[0].headers['x-forwarded-for'], undefined);
  const unauthenticated = await fetch(ui.url + PREFIX + 'api/overview');
  assert.equal(unauthenticated.status, 401);
  const crossSite = await fetch(ui.url + PREFIX + 'api/overview', { headers: { Authorization: 'Bearer unit-test', Origin: 'http://evil.example' } });
  assert.equal(crossSite.status, 403);
  const traversal = await fetch(ui.url + PREFIX + 'api/%2e%2e%2fhealthz', { headers: { Authorization: 'Bearer unit-test' } });
  assert.equal(traversal.status, 400);
  const secret = await fetch(ui.url + PREFIX + 'config.json');
  assert.equal(secret.status, 404);
  assert.equal(requests.length, 1);
});

test('preserves authentication errors and never follows backend redirects', async t => {
  let calls = 0;
  const backend = await serve(t, (req, res) => {
    calls++;
    if (req.url.endsWith('/redirect')) { res.writeHead(302, { location: '/secret' }); res.end(); return; }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"invalid_api_key"}');
  });
  const ui = await serve(t, createHandler({ backendPort: backend.port }));
  const headers = { Authorization: 'Bearer invalid' };
  const denied = await fetch(ui.url + PREFIX + 'api/overview', { headers });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, 'invalid_api_key');
  const redirect = await fetch(ui.url + PREFIX + 'api/redirect', { headers });
  assert.equal(redirect.status, 502);
  assert.equal(calls, 2);
});

test('plugin registers one disposable toolbox route without starting the backend', () => {
  let registered, disposed = false;
  const cleanup = registerToolboxRoute({
    webServer: { register(route) { registered = route; return () => { disposed = true; }; } },
  }, 7863);
  assert.equal(registered.path, PREFIX.slice(0, -1));
  assert.equal(typeof registered.handler, 'function');
  cleanup();
  assert.equal(disposed, true);
});
