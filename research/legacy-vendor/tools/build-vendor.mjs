import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

/**
 * Build the vendored official UI primitives into a CommonJS module whose
 * `require('react')` resolves against the calling plugin's module loader.
 *
 * CSS modules are compiled by a tiny built-in implementation: every class
 * becomes a stable `dsh-<hash>` name and the transformed stylesheet is
 * injected once through a <style> element at module evaluation time.
 */
const ROOT = path.resolve('vendor/.src/packages/client/ui-primitives/src');
const ENTRY = path.resolve('tools/vendor-entry.tsx');
const OUT_DIR = path.resolve('vendor/dist');

let styleId = 0;
function hashName(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  styleId += 1;
  return `dsh-${hash.toString(36)}${styleId}`;
}

function compileCssModule(source, filePath) {
  const base = path.basename(filePath, '.module.css');
  const mapping = new Map();
  const className = (name) => {
    if (!mapping.has(name)) mapping.set(name, `${base}-${hashName(base + name)}`);
    return mapping.get(name);
  };
  // Rewrite selectors: .foo → .<mapped>; strip :global(...) wrappers.
  const css = source
    .replace(/:global\(([^()]*)\)/gu, (_match, inner) => inner)
    .replace(/\.([A-Za-z_][A-Za-z0-9_-]*)/gu, (_match, name) => `.${className(name)}`);
  const mappingLiteral = [...mapping.entries()]
    .map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
    .join(',\n');
  return `
const mapping = {\n${mappingLiteral}\n};
(function () {
  try {
    const css = ${JSON.stringify(css)};
    const style = document.createElement('style');
    style.dataset.dshVendor = ${JSON.stringify(base)};
    style.textContent = css;
    document.head.appendChild(style);
  } catch (error) {
    /* non-browser runtime: styles are optional */
  }
})();
export default mapping;
`;
}

const cssModulesPlugin = {
  name: 'css-modules',
  setup(build) {
    build.onLoad({ filter: /\.module\.css$/u }, (args) => ({
      contents: compileCssModule(fs.readFileSync(args.path, 'utf8'), args.path),
      loader: 'js',
      resolveDir: path.dirname(args.path),
    }));
    build.onLoad({ filter: /\.css$/u }, (args) => ({
      contents: '',
      loader: 'js',
    }));
  },
};

const entrySource = `
export { DisclosureRow } from ${JSON.stringify(
  path.join(ROOT, 'DisclosureRow.tsx').replaceAll('\\', '/'),
)};
export { TextShimmer } from ${JSON.stringify(path.join(ROOT, 'TextShimmer.tsx').replaceAll('\\', '/'))};
export {
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
} from ${JSON.stringify(path.join(ROOT, 'icons/index.tsx').replaceAll('\\', '/'))};
`;
fs.writeFileSync(ENTRY, entrySource);

fs.mkdirSync(OUT_DIR, { recursive: true });
await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  outfile: path.join(OUT_DIR, 'ui-primitives.cjs'),
  loader: { '.svg': 'text' },
  plugins: [cssModulesPlugin],
  alias: { clsx: path.resolve('tools/shims/clsx.ts') },
  logLevel: 'warning',
});

const size = fs.statSync(path.join(OUT_DIR, 'ui-primitives.cjs')).size;
console.log(`built vendor/dist/ui-primitives.cjs (${(size / 1024).toFixed(1)} KB)`);
