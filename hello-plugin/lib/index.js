// dsh-hello-plugin — Host half.
//
// Loaded by the DSH node process as an ESM cordis plugin (package.json "main"
// -> lib/index.js). A plugin module exports:
//   name   — plugin name used in logs / fiber tree
//   inject — services that must exist before apply() runs (cordis fiber inject)
//   apply  — mount point; everything registered here must be disposed via
//            ctx.effect(...) so HMR/plugin reload can tear the plugin down
//   Config — optional schemastery schema for this row's `config:` in cordis.patch.yml
//
// `webServer` is the host HTTP service; every third-party plugin route goes
// through the same `ctx.webServer.register({ kind: 'prefix' | 'exact', path, handler })`.
export const name = 'dsh-hello-plugin';

export const inject = ['webServer'];

export function apply(ctx) {
  ctx.logger?.info?.('dsh-hello-plugin: host half mounted');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/hello/api',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://dsh.internal');
          if (req.method === 'GET' && url.pathname === '/hello/api/ping') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                ok: true,
                plugin: 'dsh-hello-plugin',
                pid: process.pid,
                dshHome: process.env.DSH_HOME ?? null,
                at: new Date().toISOString(),
              }),
            );
            return;
          }
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'not-found' }));
        },
      }),
    'dsh-hello-plugin: /hello/api route',
  );
}
