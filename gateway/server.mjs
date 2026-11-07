import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentGateway, GatewayError, requireValue, tokenMatches } from './core.mjs';
import { CodexAdapter, OpenCodeAdapter } from './process-adapters.mjs';
import { DshAdapter } from './dsh-adapter.mjs';

export async function loadConfig(file) {
  const config = JSON.parse(await readFile(file, 'utf8')), directory = path.dirname(path.resolve(file));
  config.host ||= '127.0.0.1'; config.port ??= 3490;
  requireValue(typeof config.id === 'string' && typeof config.name === 'string' && Array.isArray(config.workspaces) && config.workspaces.length > 0, 'INVALID_CONFIG', 'Configure a node ID, name and workspaces.');
  requireValue(Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535, 'INVALID_CONFIG', 'Invalid listen port.');
  config.workspaces = config.workspaces.map(item => ({ ...item, path: path.resolve(directory, item.path) }));
  config.stateFile = path.resolve(directory, config.stateFile || 'sessions.json');
  for (const agent of Object.values(config.agents || {})) {
    if (agent.tokenFile) agent.tokenFile = path.resolve(directory, agent.tokenFile);
  }
  const tokenFile = config.tokenFile && path.resolve(directory, config.tokenFile);
  const token = process.env.DSH_AGENT_TOKEN || (tokenFile && (await readFile(tokenFile, 'utf8')).trim());
  requireValue(typeof token === 'string' && token.length >= 32, 'INVALID_CONFIG', 'Use a gateway token of at least 32 characters in a private token file or DSH_AGENT_TOKEN.');
  return { config, token };
}

export async function createGatewayServer(config, token, adapters) {
  requireValue(typeof token === 'string' && token.length >= 32, 'INVALID_CONFIG', 'Gateway authentication is required.');
  if (!adapters) {
    adapters = new Map();
    for (const [id, item] of Object.entries(config.agents || {})) {
      if (item.enabled === false) continue;
      requireValue(/^[\w-]{1,80}$/.test(id), 'INVALID_CONFIG', 'Invalid Agent ID.');
      const Type = { codex: CodexAdapter, opencode: OpenCodeAdapter, dsh: DshAdapter }[item.kind];
      requireValue(Type, 'INVALID_CONFIG', 'Unknown Agent adapter.');
      adapters.set(id, new Type(id, { command: item.kind, ...item }));
    }
  }
  const gateway = new AgentGateway(config, adapters);
  await gateway.initialize();
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    const json = (status, value) => {
      if (res.destroyed) return;
      const body = JSON.stringify(value);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://gateway.invalid');
      if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
      requireValue(!req.headers.origin, 'ORIGIN_REFUSED', 'Use the native client or the authenticated DSH proxy.', 403);
      requireValue(tokenMatches(req.headers.authorization?.replace(/^Bearer /, ''), token), 'UNAUTHORIZED', 'Gateway authentication failed.', 401);
      requireValue(req.method === 'POST' && url.pathname === '/v1/call', 'NOT_FOUND', 'Unknown route.', 404);
      requireValue(requests < 256, 'BUSY', 'Too many pending requests.', 429);
      requireValue(/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''), 'CONTENT_TYPE', 'Expected application/json.', 415);
      requests++;
      try {
        let length = 0; const chunks = [];
        for await (const chunk of req) {
          length += chunk.length;
          requireValue(length <= 512 * 1024, 'REQUEST_TOO_LARGE', 'Request exceeded 512 KiB.', 413);
          chunks.push(chunk);
        }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GatewayError('INVALID_JSON', 'Invalid JSON request.'); }
        requireValue(body && typeof body === 'object' && !Array.isArray(body) && typeof body.method === 'string', 'INVALID_REQUEST', 'Expected method and params.');
        const result = await gateway.call(body.method, body.params, abort.signal);
        json(200, { ok: true, result });
      } finally { requests--; }
    } catch (error) {
      json(error.status || 500, { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error instanceof GatewayError ? error.message : 'Gateway operation failed. Check the node configuration.' } });
    }
  });
  server.requestTimeout = 65000;
  server.headersTimeout = 15000;
  return { server, gateway, async close() { const closing = new Promise(resolve => server.close(resolve)); await gateway.close(); server.closeAllConnections(); await closing; } };
}
