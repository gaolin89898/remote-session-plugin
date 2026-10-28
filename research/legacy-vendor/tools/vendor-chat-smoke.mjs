/** Smoke: load vendored official ChatView bundle and inspect its requirements. */
import fs from 'node:fs';

const source = fs.readFileSync('vendor/dist/ui-chat.cjs', 'utf8');
const styles = [];
const documentStub = {
  createElement: (tag) => ({ tag, style: {}, dataset: {}, textContent: '', appendChild() {} }),
  head: { appendChild: (node) => styles.push(node) },
  getElementById: () => null,
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { appendChild() {}, style: {} },
};

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  memo: (component) => component,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useContext: () => undefined,
  createContext: (value) => ({ _default: value, Provider: 'Provider', Consumer: 'Consumer' }),
  useId: () => 'id',
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useReducer: (_reducer, initial) => [initial, () => {}],
  useTransition: () => [false, (fn) => fn()],
  forwardRef: (render) => {
    const component = (props) => render(props, { current: null });
    component.displayName = 'ForwardRef';
    return component;
  },
  useImperativeHandle: () => {},
  useDebugValue: () => {},
  Children: { map: (children, fn) => (Array.isArray(children) ? children.map(fn) : children), toArray: (c) => (Array.isArray(c) ? c : [c]), only: (c) => c },
  cloneElement: (element, props) => ({ ...element, props: { ...(element.props || {}), ...(props || {}) } }),
  isValidElement: () => true,
  useDeferredValue: (value) => value,
  startTransition: (fn) => fn(),
  StrictMode: 'StrictMode',
  Fragment: 'Fragment',
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
  return new Proxy(
    {},
    {
      get: () => undefined,
    },
  );
}

const moduleObject = { exports: {} };
try {
  new Function('module', 'exports', 'require', 'document', 'window', 'navigator', 'localStorage', source)(
    moduleObject,
    moduleObject.exports,
    fakeRequire,
    documentStub,
    { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    { userAgent: 'smoke' },
    { getItem: () => null, setItem() {} },
  );
} catch (error) {
  console.log('FAIL bundle eval:', error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error);
  process.exit(1);
}
const exportsList = Object.keys(moduleObject.exports || {});
console.log('PASS bundle evaluated; requires:', [...new Set(required)].join(','), '| exports:', exportsList.join(','));
if (typeof moduleObject.exports.ChatView !== 'function') {
  console.log('FAIL ChatView export missing');
  process.exit(1);
}
console.log('PASS ChatView export present; stylesheets injected:', styles.length);
console.log('PASS vendor chat smoke complete');
