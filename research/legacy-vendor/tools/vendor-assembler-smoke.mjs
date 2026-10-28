/** Smoke: feed a real session's raw events into the vendored official Chat assembler. */
import fs from 'node:fs';
import { scanSessions, resolveDshHome, readSessionEventsSync } from '../lib/session-bridge.js';

const source = fs.readFileSync('vendor/dist/assembler.cjs', 'utf8');
const styles = [];
const documentStub = {
  createElement: (tag) => ({ tag, style: {}, dataset: {}, textContent: '', appendChild() {}, setAttribute() {} }),
  head: { appendChild: (node) => styles.push(node) },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { appendChild() {}, style: {} },
  documentElement: { style: {} },
};
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  memo: (component) => component,
  forwardRef: (render) => (props) => render(props, { current: null }),
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
  Children: { map: (children, fn) => (Array.isArray(children) ? children.map(fn) : children), toArray: (c) => (Array.isArray(c) ? c : [c]), only: (c) => c },
  cloneElement: (element, props) => ({ ...element, props: { ...(element.props || {}), ...(props || {}) } }),
  isValidElement: () => true,
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
};
const jsxRuntime = { jsx: (type, props) => ({ type, props: props || {} }), jsxs: (type, props) => ({ type, props: props || {} }), Fragment: 'Fragment' };
const required = [];
function fakeRequire(name) {
  required.push(name);
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  return new Proxy({}, { get: () => undefined });
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
  console.log('FAIL assembler eval:', error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n') : error);
  process.exit(1);
}
const { createChatAssembler } = moduleObject.exports;
if (typeof createChatAssembler !== 'function') {
  console.log('FAIL createChatAssembler missing; exports:', Object.keys(moduleObject.exports).join(','));
  process.exit(1);
}
console.log('PASS assembler bundle evaluated; requires:', [...new Set(required)].join(',') || '(none)');

const dshHome = resolveDshHome();
const sessions = await scanSessions(dshHome);
const entriesList = [...sessions.entries()].sort((left, right) => (right[1].updatedAt || 0) - (left[1].updatedAt || 0));
let candidate = null;
let candidateSize = Infinity;
for (const [sessionId, meta] of entriesList) {
  const all = readSessionEventsSync(dshHome, sessionId, { limit: 5000 });
  if (!all || all.length === 0 || all.length >= candidateSize) continue;
  const hasUser = all.some((event) => event.type === 'user/message');
  const hasAssistant = all.some((event) => event.type === 'assistant/message');
  if (hasUser && hasAssistant) {
    candidate = { sessionId, file: meta.file };
    candidateSize = all.length;
  }
}
console.log('local sessions:', sessions.size, '| picked:', candidate && candidate.sessionId);
let events = candidate ? readSessionEventsSync(dshHome, candidate.sessionId, { limit: 5000 }) : null;
let sourceLabel = candidate ? `${candidate.sessionId}` : 'synthetic';
if (!events || events.length === 0) {
  sourceLabel = 'synthetic';
  events = [
    { seq: 1, time: 1700000000000, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: 1700000000001, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 3, time: 1700000000002, type: 'user/message', data: { message: { content: [{ type: 'text', text: '你好' }] }, source: { kind: 'user' } } },
    { seq: 4, time: 1700000000003, type: 'assistant/message', data: { turn: 1, step: 1, content: [{ type: 'text', text: '你好！' }] } },
    { seq: 5, time: 1700000000004, type: 'turn/end', data: { turn: 1, reason: 'stop' } },
  ];
}
const userSample = events.find((event) => event.type === 'user/message');
if (userSample) console.log('DEBUG user event:', JSON.stringify(userSample).slice(0, 400));
const asstSample = events.find((event) => event.type === 'assistant/message');
if (asstSample) console.log('DEBUG assistant event:', JSON.stringify(asstSample).slice(0, 300));
console.log(`using events: ${sourceLabel} (${events.length} events, types:`, [...new Set(events.slice(0, 20).map((event) => event.type))].join(','), ')');

const assembler = createChatAssembler();
try {
  assembler.replace(events);
} catch (error) {
  console.log('FAIL assembler.replace:', error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n') : error);
  process.exit(1);
}
const snapshot = assembler.snapshot();
if (!snapshot) {
  console.log('FAIL grouped("chat") snapshot missing');
  process.exit(1);
}
console.log('DEBUG snapshot type:', typeof snapshot, '| ctor:', snapshot && snapshot.constructor && snapshot.constructor.name, '| keys:', snapshot ? Object.keys(snapshot).slice(0, 12).join(',') : 'null');
const resolved = snapshot && typeof snapshot.snapshot === 'function' ? snapshot.snapshot() : snapshot;
if (resolved && resolved !== snapshot) console.log('DEBUG resolved keys:', Object.keys(resolved).slice(0, 12).join(','));
const entries = (resolved && resolved.entries) || [];
const kinds = {};
for (const entry of entries) {
  const key = entry && entry.kind === 'group' ? `group:${entry.group?.kind ?? '?'}` : `node:${entry?.node?.kind ?? '?'}`;
  kinds[key] = (kinds[key] || 0) + 1;
}
console.log('PASS official chat snapshot:', entries.length, 'entries |', JSON.stringify(kinds));
if (entries.length === 0) {
  console.log('FAIL snapshot has no entries');
  process.exit(1);
}
const chatSnapshot = (() => { const probe = moduleObject.exports.createChatAssembler(); probe.replace(events); return probe.raw ? probe.raw() : null; })();
if (typeof moduleObject.exports.createChatAssembler === 'function') {
  const probe = moduleObject.exports.createChatAssembler();
  probe.replace(events);
  const raw = probe.chatSnapshot ? probe.chatSnapshot() : null;
  if (raw) {
    console.log('DEBUG chat snapshot keys:', Object.keys(raw).join(','));
    const sample = (raw.legacy && raw.legacy.nodes) ? raw.legacy.nodes.slice(0, 6) : [];
    const byKind = new Map();
    for (const node of raw.legacy.nodes) if (!byKind.has(node.kind)) byKind.set(node.kind, node);
    for (const [kind, node] of byKind) {
      console.log('DEBUG kind:', kind, '| keys:', Object.keys(node).join(','));
      if (kind === 'user' || kind === 'assistant' || kind === 'context') console.log('DEBUG  sample:', JSON.stringify(node).slice(0, 400));
    }
    const firstTurn = raw.timeline.turnOrder[0];
    console.log('DEBUG turn sample:', firstTurn, JSON.stringify(raw.timeline.turns.get(firstTurn)).slice(0, 300));
    console.log('DEBUG timings keys:', raw.legacy.turnTimings ? raw.legacy.turnTimings.size : '?', '| turnEnds:', raw.legacy.turnEnds ? raw.legacy.turnEnds.size : '?');
    const keys = raw.locations.getTurn(firstTurn);
    console.log('DEBUG turn node keys:', keys.length, keys.slice(0, 5).join(','));
    console.log('DEBUG timeline turns:', raw.timeline && raw.timeline.turnOrder ? raw.timeline.turnOrder.length : '?', '| order:', raw.order ? raw.order.length : '?');
  }
}
const probeDbg = moduleObject.exports.createChatAssembler();
probeDbg.replace(events);
const dbgSnap = probeDbg.chatSnapshot ? probeDbg.chatSnapshot() : null;
if (dbgSnap) {
  const sampleKeys = dbgSnap.order.slice(0, 10);
  for (const key of sampleKeys) {
    const node = dbgSnap.nodes.get(key);
    console.log('DEBUG order:', key, '=>', node ? node.kind : 'undefined');
  }
  const kinds = new Set();
  for (const key of dbgSnap.order) { const node = dbgSnap.nodes.get(key); if (node) kinds.add(node.kind); }
  console.log('DEBUG order kinds:', [...kinds].join(','));
  console.log('DEBUG legacy kinds:', [...new Set(dbgSnap.legacy.nodes.map((n) => n.kind))].join(','), '| total', dbgSnap.legacy.nodes.length);
  for (const key of dbgSnap.order) {
    const node = dbgSnap.nodes.get(key);
    if (node && (node.kind === 'assistant-step' || node.kind === 'tool-call')) {
      console.log('DEBUG', node.kind, 'data:', JSON.stringify(node.data).slice(0, 500));
    }
    if (node && node.kind === 'tool-call') {
      console.log('DEBUG tool-call node keys:', Object.keys(node).join(','));
      console.log('DEBUG tool-call sample:', JSON.stringify(node).slice(0, 400));
      break;
    }
  }
}
const probe2 = moduleObject.exports.createChatAssembler();
probe2.replace(events);
const projected = typeof probe2.messages === 'function' ? probe2.messages() : [];
const roleCounts = {};
for (const row of projected) roleCounts[row.role] = (roleCounts[row.role] || 0) + 1;
console.log('DEBUG projected rows:', projected.length, '| roles:', JSON.stringify(roleCounts));
const ends = projected.filter((row) => row.role === 'turn-end');
console.log('DEBUG turn-end rows:', ends.length, '| sample:', JSON.stringify(ends[0] || null));
if (projected.length === 0) { console.log('FAIL buildMessages produced no rows'); process.exit(1); }
if (ends.length === 0) { console.log('FAIL buildMessages produced no turn-end rows'); process.exit(1); }
const tools = projected.filter((row) => row.role === 'tool');
if (tools.length === 0) { console.log('FAIL buildMessages produced no tool rows'); process.exit(1); }
console.log('PASS official projection:', projected.length, 'rows |', tools.length, 'tool rows |', ends.length, 'turn ends');
console.log('PASS vendor assembler smoke complete');
