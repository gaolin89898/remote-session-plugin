/** Smoke: render the vendored official ChatFlow with a real assembled snapshot. */
import fs from 'node:fs';
import { scanSessions, resolveDshHome, readSessionEventsSync } from '../lib/session-bridge.js';

const documentStub = {
  createElement: (tag) => ({ tag, style: {}, dataset: {}, textContent: '', appendChild() {}, setAttribute() {} }),
  head: { appendChild() {} },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { appendChild() {}, style: {} },
  documentElement: { style: {} },
};
function makeReact() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: children.length > 0 ? { ...(props || {}), children } : { ...(props || {}) } }),
    cloneElement: (element, props) => ({ ...element, props: { ...(element.props || {}), ...(props || {}) } }),
    memo: (component) => component,
    forwardRef: (render) => {
      const component = (props) => render(props, { current: null });
      return component;
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useContext: (context) => context && context._default,
    createContext: (value) => ({ _default: value, Provider: 'Provider', Consumer: 'Consumer' }),
    useId: () => 'id',
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useReducer: (_reducer, initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useTransition: () => [false, (fn) => fn()],
    useDeferredValue: (value) => value,
    startTransition: (fn) => fn(),
    useImperativeHandle: () => {},
    useDebugValue: () => {},
    Children: { map: (children, fn) => (Array.isArray(children) ? children.map(fn) : children), toArray: (c) => (Array.isArray(c) ? c : [c]), only: (c) => c, forEach: (c, fn) => (Array.isArray(c) ? c.forEach(fn) : fn(c)) },
    isValidElement: (value) => Boolean(value && typeof value === 'object' && value.type !== undefined),
    Fragment: 'Fragment',
    StrictMode: 'StrictMode',
    Suspense: 'Suspense',
  };
  return React;
}
function makeJsxRuntime(React) {
  return {
    jsx: (type, props) => React.createElement(type, props),
    jsxs: (type, props) => React.createElement(type, props),
    Fragment: 'Fragment',
  };
}

function loadBundle(file, React) {
  const source = fs.readFileSync(file, 'utf8');
  const jsxRuntime = makeJsxRuntime(React);
  const moduleObject = { exports: {} };
  const fakeRequire = (name) => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'react-dom') return {};
    if (name === 'react-dom/client') return {};
    return new Proxy({}, { get: () => undefined });
  };
  new Function('module', 'exports', 'require', 'document', 'window', 'navigator', 'localStorage', source)(
    moduleObject,
    moduleObject.exports,
    fakeRequire,
    documentStub,
    { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    { userAgent: 'smoke' },
    { getItem: () => null, setItem() {} },
  );
  return moduleObject.exports;
}

const React = makeReact();
const flowSource = fs.readFileSync('vendor/dist/flow.cjs', 'utf8');
const assemblerVendor = loadBundle('vendor/dist/assembler.cjs', React);
const flowVendor = loadBundle('vendor/dist/flow.cjs', React);
console.log('PASS bundles loaded | flow exports:', Object.keys(flowVendor).join(','));

// Synthetic official event stream: one completed turn with reasoning, a reply,
// and one tool call with a result.
const now = Date.now();
const events = [
  { seq: 1, time: now - 9000, type: 'turn/start', data: { turn: 1 }, surfaceOp: 'append' },
  { seq: 2, time: now - 8900, type: 'step/start', data: { turn: 1, step: 1 }, surfaceOp: 'append' },
  { seq: 3, time: now - 8800, type: 'user/message', data: { content: [{ type: 'text', text: '官方渲染测试' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  { seq: 4, time: now - 7000, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '先确认问题再回答。' }, { type: 'text', text: '这是**官方**回复。' }] } }, surfaceOp: 'append' },
  { seq: 5, time: now - 6000, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_smoke_1', name: 'web_search', arguments: '{"queries":["官方 UI"]}' }, surfaceOp: 'append' },
  { seq: 6, time: now - 5000, type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call_smoke_1' }, content: [{ type: 'tool-result', toolCallId: 'call_smoke_1', content: [{ type: 'text', text: '搜索结果：官方 UI 文档' }] }] } }, surfaceOp: 'append' },
  // The running write already renders DiffBlock from its arguments, exercising
  // the vendored `diff.structuredPatch` dependency without a settled result.
  { seq: 7, time: now - 4500, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_diff_smoke_1', name: 'write', arguments: '{"file_path":"notes/diff-smoke.txt","content":"old line\\nnew line"}' }, surfaceOp: 'append' },
  { seq: 8, time: now - 4000, type: 'step/end', data: { turn: 1, step: 1 }, surfaceOp: 'append' },
  { seq: 9, time: now - 3000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, surfaceOp: 'append' },
];

const assembler = assemblerVendor.createChatAssembler();
assembler.replace(events);
const grouped = assembler.snapshot();
const entries = grouped && grouped.entries ? grouped.entries : [];
console.log('PASS assembled snapshot | entries:', entries.length, '| kinds:', entries.map((entry) => entry.kind).join(','));

const groupSources = new Map();
if (grouped && typeof grouped.groupSource === 'function') {
  for (const entry of entries) if (entry.kind === 'group') groupSources.set(entry.key, grouped.groupSource(entry.key));
}
console.log('DEBUG group sources:', groupSources.size);
const flow = flowVendor.VendorChatFlow || flowVendor.default;
if (typeof flow !== 'function') {
  console.log('FAIL VendorChatFlow export missing');
  process.exit(1);
}

const rendered = [];
function renderNode(node, depth) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (depth > 60) return;
  if (typeof node === 'string' || typeof node === 'number') {
    rendered.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) renderNode(child, depth + 1);
    return;
  }
  if (typeof node.type === 'function') {
    let produced;
    try {
      produced = node.type(node.props || {});
    } catch (error) {
      rendered.push(`[ERR ${node.type.name || 'component'}: ${error && error.message}]`);
      return;
    }
    renderNode(produced, depth + 1);
    return;
  }
  const props = node.props || {};
  if (props.children !== undefined) renderNode(props.children, depth + 1);
}

let tree;
try {
  tree = flow({ snapshot: assembler.chatSnapshot(), entries, groupSources, running: false, openDisclosures: true, cwd: 'C:/work' });
} catch (error) {
  console.log('FAIL VendorChatFlow threw:', error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error);
  process.exit(1);
}
renderNode(tree, 0);
const text = rendered.join('\n');
const checks = [
  ['user prompt', text.includes('官方渲染测试')],
  ['assistant reply', text.includes('官方')],
  ['tool activity', /web_search|搜索|工具/i.test(text)],
  ['file diff card', text.includes('notes/diff-smoke.txt') && text.includes('old line') && text.includes('new line')],
  ['bundled diff implementation', /function structuredPatch\(/.test(flowSource)],
  ['no render exceptions', !text.includes('[ERR ')],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} flow contains ${label}`);
  if (!ok) failed += 1;
}
console.log('rendered text length:', text.length, '| error markers:', (text.match(/\[ERR/g) || []).length);
if (failed > 0) {
  console.log('--- rendered excerpt ---');
  console.log(text.slice(0, 1500));
  process.exit(1);
}
// Real-session pass: official assembler + official flow over a real session file.
const dshHome = resolveDshHome();
const sessions = await scanSessions(dshHome);
const entriesList = [...sessions.entries()].sort((left, right) => (right[1].updatedAt || 0) - (left[1].updatedAt || 0));
let real = null;
for (const [sessionId, meta] of entriesList) {
  const window = readSessionEventsSync(dshHome, sessionId, { limit: 600 });
  if (!window || window.length === 0) continue;
  const userEvent = window.find((event) => event.type === 'user/message');
  if (!userEvent) continue;
  real = { sessionId, events: window, userEvent };
  break;
}
if (real) {
  const realAssembler = assemblerVendor.createChatAssembler();
  realAssembler.replace(real.events);
  const realGrouped = realAssembler.snapshot();
  const realEntries = realGrouped && realGrouped.entries ? realGrouped.entries : [];
  const realGroups = new Map();
  if (realGrouped && typeof realGrouped.groupSource === 'function') {
    for (const entry of realEntries) if (entry.kind === 'group') realGroups.set(entry.key, realGrouped.groupSource(entry.key));
  }
  const realTree = flow({ snapshot: realAssembler.chatSnapshot(), entries: realEntries, groupSources: realGroups, running: false, openDisclosures: true, cwd: 'C:/real' });
  rendered.length = 0;
  renderNode(realTree, 0);
  const realText = rendered.join('\n');
  const realErrors = (realText.match(/\[ERR /g) || []).length;
  const expected = JSON.stringify(real.userEvent.data).includes('text')
    ? String(real.userEvent.data.content?.[0]?.text || '').slice(0, 12)
    : '';
  const hasRows = /已完成|思考|工具|调用|回复/.test(realText);
  const substantive = realText.length > 200;
  console.log(`${real.sessionId} real session render:`, realText.length, 'chars | rows:', hasRows, '| substantive:', substantive);
  console.log('real render error markers:', realErrors);
  if (realErrors > 0) console.log('real render errors:', realText.split('\n').filter((line) => line.includes('[ERR ')).slice(0, 6));
  if (!hasRows || !substantive || realErrors > 0) {
    console.log('--- real render excerpt ---');
    console.log(realText.slice(0, 1200));
  }
  console.log(`${hasRows && substantive && realErrors === 0 ? 'PASS' : 'FAIL'} official flow renders a real session`);
  if (!hasRows || !substantive || realErrors > 0) process.exit(1);
} else {
  console.log('SKIP real session pass (no local session with user message)');
}
// Running pass: an open Turn must render the official RunningStatus row.
const runningEvents = events.filter((event) => event.type !== 'turn/end');
const runningAssembler = assemblerVendor.createChatAssembler();
runningAssembler.replace(runningEvents);
const runningGrouped = runningAssembler.snapshot();
const runningEntries = runningGrouped && runningGrouped.entries ? runningGrouped.entries : [];
const runningGroups = new Map();
if (runningGrouped && typeof runningGrouped.groupSource === 'function') {
  for (const entry of runningEntries) if (entry.kind === 'group') runningGroups.set(entry.key, runningGrouped.groupSource(entry.key));
}
const runningTree = flow({ snapshot: runningAssembler.chatSnapshot(), entries: runningEntries, groupSources: runningGroups, running: true, openDisclosures: true, cwd: 'C:/work' });
rendered.length = 0;
renderNode(runningTree, 0);
const runningText = rendered.join('\n');
const hasStatus = /深度求索中/.test(runningText);
const runningErrors = (runningText.match(/\[ERR /g) || []).length;
console.log(`${hasStatus && runningErrors === 0 ? 'PASS' : 'FAIL'} running turn renders official RunningStatus`);
console.log('running render error markers:', runningErrors);
if (runningErrors > 0) console.log('running render errors:', runningText.split('\n').filter((line) => line.includes('[ERR ')).slice(0, 6));
if (!hasStatus || runningErrors > 0) {
  console.log('--- running render excerpt ---');
  console.log(runningText.slice(0, 800));
  process.exit(1);
}
console.log('PASS vendor flow smoke complete');
