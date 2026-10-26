// dsh-hello-plugin — Client half (served by dsh-client-modules at
// /plugins/dsh-hello-plugin/client.js, discovered through package.json
// `"dsh": { "client": { ... } }` + `"./client"` export).
//
// Format contract: the bundle is NOT plain ESM. It must call the shell-owned
// `window.__ModuleLoader__.load({ id, factory })` with `id` === package name
// and a factory that behaves like a CommonJS module and RETURNS `module.exports`.
// `require(spec)` inside the factory resolves the shared module table
// (react, @deepseek-ai/dsh-client-* ...) plus `require.async()` for lazy chunks.
// The factory body is lazy: it runs on first materialization, so DOM/CSS side
// effects must live inside it.
window.__ModuleLoader__.load({
  id: 'dsh-hello-plugin',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** Client plugin identity / cordis inject list (client services only). */
    const name = 'dsh-hello-plugin';
    const inject = [];

    function apply(ctx) {
      const el = document.createElement('div');
      el.id = 'dsh-hello-plugin';
      el.textContent = 'dsh-hello-plugin: client half loaded';
      el.style.cssText =
        'position:fixed;right:12px;bottom:12px;z-index:9999;padding:6px 10px;border-radius:8px;' +
        'font:12px ui-monospace,monospace;background:#1f6feb;color:#fff;opacity:.85;pointer-events:none';

      ctx.effect(
        () => {
          document.body.appendChild(el);
          fetch('/hello/api/ping')
            .then((r) => r.json())
            .then((data) => console.log('[dsh-hello-plugin] host route replied:', data))
            .catch((error) => console.warn('[dsh-hello-plugin] host route failed:', error));
          return () => el.remove();
        },
        'dsh-hello-plugin: client mount',
      );
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
