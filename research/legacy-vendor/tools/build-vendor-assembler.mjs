import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const SRC = path.resolve('vendor/.src');
const OUT_DIR = path.resolve('vendor/dist');
const ENTRY = path.resolve('tools/vendor-entry-assembler.ts');

/** Real npm packages that must resolve from node_modules instead of the proxy. */
const REAL_PACKAGES = [
  'diff',
  'anser',
  'simple-icons',
  'immer',
  'oniguruma-to-es',
  'oniguruma-parser',
  'regex-recursion',
  'regex',
  'zustand',
  'micromark',
  'mdast',
  'hast',
  'unist',
  'vfile',
  'katex',
  'character-entities',
  'decode-named-character-reference',
  'devlop',
  'longest-streak',
  'markdown-table',
  'zwitch',
  'bail',
  'extend',
  'is-plain-obj',
  'trough',
  'ccount',
  'escape-string-regexp',
  'unified',
  'remark',
  'rehype',
  'property-information',
  'space-separated-tokens',
  'comma-separated-tokens',
  'html-void-elements',
  'trim-lines',
  'style-to-object',
  'inline-style-parser',
  'stringify-entities',
];

const externalProxy = {
  name: 'external-proxy',
  setup(build) {
    build.onResolve({ filter: /^[^./]/u }, (args) => {
      if (args.path === 'react' || args.path === 'react/jsx-runtime' || args.path === 'react-dom' || args.path === 'react-dom/client') return undefined;
      if (args.path === 'clsx' || args.path === '@tanstack/react-virtual') return undefined;
      if (args.path.startsWith('@deepseek-ai/')) return undefined;
      if (path.isAbsolute(args.path) || /^[A-Za-z]:[\\/]/u.test(args.path)) return undefined;
      if (/^shiki(\/|$)/u.test(args.path) || args.path.startsWith('@shikijs/')) {
        return { path: path.resolve('tools/shims/shiki.ts') };
      }
      for (const name of REAL_PACKAGES) {
        if (args.path === name || args.path.startsWith(`${name}/`) || args.path.startsWith(`${name}-`)) return undefined;
      }
      if (process.env.VENDOR_ALLOW_PROXY !== '1') {
        return { errors: [{ text: `Unregistered external dependency: ${args.path} (imported by ${args.importer})` }] };
      }
      return { path: path.resolve('tools/shims/proxy.cjs') };
    });
  },
};

const cssModules = {
  name: 'css-modules',
  setup(build) {
    let counter = 0;
    const hash = (text) => {
      let value = 0;
      for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) >>> 0;
      counter += 1;
      return `dsh-${value.toString(36)}${counter}`;
    };
    build.onLoad({ filter: /\.module\.css$/u }, (args) => {
      const source = fs.readFileSync(args.path, 'utf8');
      const base = path.basename(args.path, '.module.css');
      const mapping = new Map();
      const css = source
        .replace(/:global\(([^()]*)\)/gu, (_m, inner) => inner)
        .replace(/\.([A-Za-z_][A-Za-z0-9_-]*)/gu, (_m, name) => {
          if (!mapping.has(name)) mapping.set(name, `${base}-${hash(base + name)}`);
          return `.${mapping.get(name)}`;
        });
      const literal = [...mapping.entries()].map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`).join(',');
      return {
        contents: `
const mapping = {${literal}};
(function () {
  try {
    const style = document.createElement('style');
    style.dataset.dshVendor = ${JSON.stringify(base)};
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
  } catch {}
})();
export default mapping;
`,
        loader: 'js',
        resolveDir: path.dirname(args.path),
      };
    });
    build.onLoad({ filter: /\.css$/u }, (args) => (args.path.endsWith('.module.css') ? undefined : { contents: '', loader: 'js' }));
  },
};


fs.mkdirSync(OUT_DIR, { recursive: true });
await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  outfile: path.join(OUT_DIR, 'assembler.cjs'),
  absWorkingDir: SRC,
  alias: {
    clsx: path.resolve('tools/shims/clsx.ts'),
    '@deepseek-ai/cordis': `${SRC}/vendor/cordis/src/index.ts`,
    '@deepseek-ai/schemastery': `${SRC}/vendor/schemastery/src/index.ts`,
    '@deepseek-ai/dsh-brand': `${SRC}/packages/util/brand/src/index.ts`,
    '@deepseek-ai/dsh-util-values': `${SRC}/packages/util/values/src/index.ts`,
    '@deepseek-ai/dsh-session/surface': `${SRC}/packages/core/session/src/surface.ts`,
    '@deepseek-ai/dsh-session/types': `${SRC}/packages/core/session/src/types.ts`,
    '@deepseek-ai/dsh-token-meter/client': path.resolve('tools/shims/token-meter.ts'),
    '@deepseek-ai/dsh-client-store': `${SRC}/packages/client/store/src/index.ts`,
    '@deepseek-ai/cosmokit': path.resolve('tools/shims/proxy.cjs'),
    '@tanstack/react-virtual': path.resolve('tools/shims/react-virtual.ts'),
    '@deepseek-ai/dsh-client-ui-primitives': path.resolve('tools/shims/primitive-entry.ts'),
    '@deepseek-ai/dsh-util-workspace-path': `${SRC}/packages/util/workspace-path/src/index.ts`,
    '@deepseek-ai/dsh-session/types': path.resolve('tools/shims/proxy.cjs'),
    'shiki/core': path.resolve('tools/shims/shiki.ts'),
    'shiki/engine/javascript': path.resolve('tools/shims/shiki.ts'),
    '@shikijs/langs/typescript': path.resolve('tools/shims/shiki.ts'),
    '@shikijs/langs/shellscript': path.resolve('tools/shims/shiki.ts'),
    '@shikijs/langs/json': path.resolve('tools/shims/shiki.ts'),
  },
  loader: { '.svg': 'text', '.woff2': 'dataurl' },
  plugins: [externalProxy, cssModules],
  logLevel: 'warning',
  metafile: true,
});
fs.mkdirSync(path.resolve('lib/vendor'), { recursive: true });
fs.copyFileSync(path.join(OUT_DIR, 'assembler.cjs'), path.resolve('lib/vendor/assembler.cjs'));
const size = fs.statSync(path.join(OUT_DIR, 'assembler.cjs')).size;
console.log(`built vendor/dist/assembler.cjs (${(size / 1024).toFixed(1)} KB)`);
