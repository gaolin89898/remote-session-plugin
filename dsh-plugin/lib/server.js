import { readFile } from 'node:fs/promises';

export const PREFIX = '/workbuddy-accounts/';
const assets = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['accounts.js', 'text/javascript; charset=utf-8'],
  ['index.css', 'text/css; charset=utf-8'],
]);

function loopback(host) {
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host === '::ffff:127.0.0.1';
}

// The bridge grants no remote access to desktop operations. In addition to
// the backend's Bearer authentication, require a local peer and same-origin UI.
export function localRequest(req) {
  if (!loopback(req.socket.remoteAddress)) return false;
  if (['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip'].some(h => req.headers[h])) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  try {
    const host = new URL('http://' + req.headers.host);
    if (!loopback(host.hostname.replace(/^\[|\]$/g, ''))) return false;
    if (host.username || host.password || host.pathname !== '/' || host.search || host.hash) return false;
    if (req.headers.origin) {
      const origin = new URL(req.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== req.headers.origin || origin.host !== host.host) return false;
    }
    return true;
  } catch { return false; }
}

function json(res, status, error) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error }));
}

export function createHandler({ backendPort = 7863 } = {}) {
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) throw new Error('backendPort must be an integer from 1 to 65535');
  // Only the port is configurable. No remote URL, credentials or redirect target.
  const backend = `http://127.0.0.1:${backendPort}`;
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!localRequest(req)) return json(res, 403, 'AI 工具箱仅支持从运行 DSH 的本机访问');
    const url = new URL(req.url, 'http://local.invalid');
    if (!url.pathname.startsWith(PREFIX)) return json(res, 404, 'Not found');
    const relative = url.pathname.slice(PREFIX.length);
    if (!relative.startsWith('api/')) {
      const file = relative || 'index.html';
      if (!assets.has(file) || !['GET', 'HEAD'].includes(req.method)) return json(res, 404, 'Not found');
      try {
        const body = await readFile(new URL('../public/' + file, import.meta.url));
        res.writeHead(200, {
          'content-type': assets.get(file), 'cache-control': 'no-cache',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
          'x-frame-options': 'SAMEORIGIN',
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      } catch { return json(res, 503, '页面尚未构建，请运行 npm run build'); }
    }
    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, 'Method not allowed');
    const authorization = req.headers.authorization || '';
    if (!/^Bearer \S+$/i.test(authorization)) return json(res, 401, '请输入本机服务的管理密钥');
    // Fixed prefix + plain path prevents encoded traversal outside /panel/api/.
    const apiPath = relative.slice(4);
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(apiPath)) return json(res, 400, 'Invalid API path');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 330_000);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) return json(res, 413, '上传文件不能超过 32 MB');
        chunks.push(chunk);
      }
      // Forward only the Bearer key and content type. Browser cookies and proxy
      // headers never reach Go. The local-origin fence above runs first.
      const upstream = await fetch(`${backend}/panel/api/${apiPath}${url.search}`, {
        method: req.method, redirect: 'manual', signal: controller.signal,
        headers: { authorization, 'content-type': req.headers['content-type'] || 'application/json' },
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      });
      if (upstream.status >= 300 && upstream.status < 400) return json(res, 502, '本机服务返回了不支持的重定向');
      const body = Buffer.from(await upstream.arrayBuffer());
      if (res.destroyed) return;
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      if (!res.destroyed) json(res, 502, `无法连接本机账号服务（127.0.0.1:${backendPort}），请确认后端已启动`);
    } finally {
      clearTimeout(timeout);
      res.off('close', disconnected);
    }
  };
}
