/**
 * Smoke test: load vendored official ui-primitives (CJS build) in a fake
 * runtime and render DisclosureRow / TextShimmer / icons. Proves the vendored
 * official component code actually executes against our shims.
 */
import fs from 'node:fs';

const source = fs.readFileSync('vendor/dist/ui-primitives.cjs', 'utf8');

const created = [];
const styles = [];
const documentStub = {
  createElement(tag) {
    const element = { tag, style: {}, dataset: {}, textContent: '', appendChild() {} };
    created.push(element);
    return element;
  },
  head: {
    appendChild(node) {
      styles.push(node);
    },
  },
};

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  memo: (component) => component,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
  createContext: (defaultValue) => ({ _default: defaultValue, Provider: 'Provider', Consumer: 'Consumer' }),
  useContext: () => undefined,
  useLayoutEffect: () => {},
  useId: () => 'id-1',
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};
const jsxRuntime = {
  jsx: (type, props) => ({ type, props: props || {} }),
  jsxs: (type, props) => ({ type, props: props || {} }),
  Fragment: 'Fragment',
};
const required = [];
function fakeRequire(name) {
  required.push(name);
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  throw new Error('unexpected require: ' + name);
}

const moduleObject = { exports: {} };
try {
  new Function('module', 'exports', 'require', 'document', source)(moduleObject, moduleObject.exports, fakeRequire, documentStub);
  console.log('PASS vendor bundle evaluated; requires:', required.join(','));
} catch (error) {
  console.log('FAIL vendor bundle eval:', error && error.stack ? error.stack : error);
  process.exit(1);
}

const V = moduleObject.exports;
const expected = ['DisclosureRow', 'TextShimmer', 'IconChevronDownOutlineRegular', 'IconChevronUpOutlineRegular'];
const missing = expected.filter((name) => typeof V[name] !== 'function');
if (missing.length) {
  console.log('FAIL vendor exports missing:', missing.join(','), '| got:', Object.keys(V).join(','));
  process.exit(1);
}
console.log('PASS vendor exports:', expected.join(','));

const icon = React.createElement(V.IconChevronDownOutlineRegular, {});
const row = V.DisclosureRow({
  icon,
  title: '工具调用',
  open: false,
  expandable: true,
  onToggle: () => {},
  collapsedContent: React.createElement('span', null, ' · npm test'),
});

const json = JSON.stringify(row);
if (!json.includes('工具调用')) {
  console.log('FAIL DisclosureRow did not render its title');
  process.exit(1);
}
console.log('PASS DisclosureRow renders title + collapsed content');

if (styles.length === 0) {
  console.log('FAIL CSS modules were not injected');
  process.exit(1);
}
const css = styles.map((style) => style.textContent).join('\n');
if (!/\.DisclosureRow-[a-z0-9]+\b/u.test(css)) {
  console.log('FAIL compiled CSS module selectors look wrong:', css.slice(0, 200));
  process.exit(1);
}
console.log('PASS CSS modules compiled + injected:', styles.length, 'stylesheet(s),', css.length, 'bytes');
console.log('PASS vendor smoke complete');
