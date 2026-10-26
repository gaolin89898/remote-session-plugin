import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['tools/machine-client.tsx'], outfile: 'lib/client.js',
  bundle: true, format: 'cjs', platform: 'browser', target: ['chrome110'], jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  banner: { js: "window.__ModuleLoader__.load({ id: 'dsh-remote-session', factory: (require) => { var module = { exports: {} }; var exports = module.exports;" },
  footer: { js: 'return module.exports; } });' },
});
console.log('built native machine switcher -> lib/client.js');
