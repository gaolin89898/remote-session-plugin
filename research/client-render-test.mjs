/**
 * Headless smoke test for the Client half.
 *
 * Evaluates lib/client.js against a tiny React/hook runtime, runs apply()
 * against fake slots, then renders the whole page tree (function + class
 * components, recursively) with synthetic relay state and transcript data.
 * Catches eval/apply/render crashes without a browser.
 */
import fs from 'node:fs';
import path from 'node:path';

const bundlePath = path.join(process.cwd(), 'lib/client.js');
const code = fs.readFileSync(bundlePath, 'utf8');

/* ---------- fake window/document/module loader ---------- */
let definition = null;
const windowStub = {
  __ModuleLoader__: {
    load(value) {
      definition = value;
    },
  },
};
const documentStub = {
  baseURI: 'http://127.0.0.1:3080/',
  createElement() {
    return { style: {}, appendChild() {} };
  },
};

/* ---------- minimal React with hooks ---------- */
let currentInstance = null;
let hookIndex = 0;
let dirty = false;

const ReactStub = {};
ReactStub.createElement = (type, props, ...children) => ({
  type,
  props: { ...(props || {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
});
ReactStub.useState = (initial) => {
  const instance = currentInstance;
  const index = hookIndex++;
  if (!instance) return [typeof initial === 'function' ? initial() : initial, () => {}];
  if (!instance.hooks[index]) instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
  const slot = instance.hooks[index];
  if (!slot.setter) {
    slot.setter = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (value !== slot.value) {
        slot.value = value;
        dirty = true;
      }
    };
  }
  return [slot.value, slot.setter];
};
ReactStub.useEffect = (callback) => {
  if (currentInstance) currentInstance.effects.push(callback);
};
ReactStub.useRef = (initial) => {
  const instance = currentInstance;
  const index = hookIndex++;
  if (!instance) return { current: initial };
  if (!instance.hooks[index]) instance.hooks[index] = { current: initial };
  return instance.hooks[index];
};
ReactStub.useCallback = (callback) => callback;
ReactStub.useMemo = (factory) => factory();
ReactStub.useLayoutEffect = ReactStub.useEffect;
ReactStub.Component = class Component {
  constructor(props) {
    this.props = props;
    this.state = {};
  }
  setState(partial) {
    this.state = { ...this.state, ...partial };
  }
};
ReactStub.PureComponent = ReactStub.Component;

/* ---------- evaluate the bundle ---------- */
let moduleExports;
try {
  new Function('window', 'document', 'console', 'globalThis', code)(windowStub, documentStub, console, globalThis);
  if (!definition || typeof definition.factory !== 'function') throw new Error('module loader received no factory');
  moduleExports = definition.factory((name) => {
    if (name === 'react') return ReactStub;
    if (name.includes('ui-primitives')) return { MarkdownText: (props) => ({ type: 'markdown', props }) };
    throw new Error('unexpected require: ' + name);
  });
  console.log('PASS bundle eval; exports:', Object.keys(moduleExports || {}).join(','));
} catch (error) {
  console.log('FAIL bundle eval:', error && error.stack ? error.stack : error);
  process.exit(1);
}

/* ---------- fake slots/context ---------- */
const registrations = [];
const ctx = {
  slots: {
    register(spec, component) {
      registrations.push({ spec, component });
      return () => {};
    },
    inject(name, callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  },
  effect(fn) {
    const dispose = fn();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
  get() {
    return null;
  },
};
try {
  moduleExports.apply(ctx);
  console.log('PASS apply; slots:', registrations.map((item) => item.spec.name).join(','));
} catch (error) {
  console.log('FAIL apply:', error && error.stack ? error.stack : error);
  process.exit(1);
}

const mainComponent = (registrations.find((item) => item.spec.name === 'main') || {}).component;
if (typeof mainComponent !== 'function') {
  console.log('FAIL no main component registered');
  process.exit(1);
}

/* ---------- fake fetch: relay snapshot + transcript ---------- */
const now = Date.now();
const statePayload = {
  ok: true,
  relay: { connected: true, url: 'https://relay.example', lastError: null },
  self: { id: 'home', name: '家里' },
  peers: [
    {
      id: 'server',
      name: '服务器',
      online: true,
      sessions: [
        { id: 'session-abc', title: '测试会话', cwd: 'C:\\Users\\demo\\project', updatedAt: now - 60000, running: true },
        { id: 'session-def', title: '另一个会话', cwd: 'C:\\Users\\demo\\project', updatedAt: now - 3600000, running: false },
      ],
    },
  ],
};
const transcriptPayload = {
  ok: true,
  session: { id: 'session-abc', title: '测试会话', cwd: 'C:\\Users\\demo\\project', running: true, updatedAt: now },
  messages: [
    { seq: 1, at: now - 5000, role: 'user', text: '帮我看看项目结构' },
    { seq: 2, at: now - 4900, role: 'context', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' },
    { seq: 3, at: now - 4800, role: 'reasoning', text: '先列一下目录，再读关键文件。' },
    { seq: 4, at: now - 4700, role: 'tool', text: 'total 12 drwxr-xr-x ...', tool: { name: 'bash', args: '{"command":"ls -la"}', callId: 'call-1', done: true } },
    { seq: 5, at: now - 4600, role: 'tool', text: '阅读完成', tool: { name: 'read', args: '{"path":"README.md"}', callId: 'call-2', isError: true, done: true } },
    { seq: 6, at: now - 4500, role: 'assistant', text: '## 项目结构\n\n- `src/` 源码\n- `lib/` 库' },
    { seq: 7, at: now - 4400, role: 'turn-end', turn: 1, durationMs: 476000, reason: 'done' },
    { seq: 8, at: now - 4300, role: 'user', text: '再帮我跑一下测试' },
    { seq: 9, at: now - 4200, role: 'tool', text: 'running tests...', tool: { name: 'bash', args: '{"command":"npm test"}', callId: 'call-3', done: false } },
    { seq: 10, at: now - 4100, role: 'system', text: '执行失败：llm-deepseek: no API key for provider route "deepseek-official"' },
  ],
  total: 8,
  truncated: false,
};
const fetchCalls = [];
globalThis.fetch = async (url, options) => {
  const body = options && typeof options.body === 'string' ? JSON.parse(options.body) : {};
  fetchCalls.push({ url: String(url), body });
  const method = String(url).split('/').pop();
  const payload = method === 'state' ? statePayload : method === 'transcript' ? transcriptPayload : { ok: true };
  return { ok: true, status: 200, json: async () => payload };
};

/* ---------- recursive test renderer ---------- */
const instances = new Map();
function renderElement(element, pathKey) {
  if (element === null || element === undefined || typeof element === 'boolean') return;
  if (typeof element === 'string' || typeof element === 'number') return;
  if (Array.isArray(element)) {
    element.forEach((child, index) => renderElement(child, pathKey + '.' + index));
    return;
  }
  if (typeof element.type === 'function') {
    const key =
      (element.type.name || 'anon') + ':' + String((element.props && element.props.key) || pathKey || '');
    let instance = instances.get(key);
    if (!instance) {
      instance = { hooks: [], effects: [] };
      instances.set(key, instance);
    }
    const isClass = element.type.prototype && typeof element.type.prototype.render === 'function';
    hookIndex = 0;
    currentInstance = instance;
    let tree;
    try {
      if (isClass) {
        const component = new element.type(element.props);
        component.props = element.props;
        component.state = component.state || {};
        tree = component.render();
      } else {
        tree = element.type(element.props);
      }
    } finally {
      currentInstance = null;
    }
    renderElement(tree, key);
    return;
  }
  renderElement(element.props ? element.props.children : undefined, pathKey + '.c');
}

function TestWrapper() {
  return ReactStub.createElement(mainComponent, {});
}

async function renderUntilStable() {
  for (let pass = 0; pass < 60; pass += 1) {
    dirty = false;
    for (const instance of instances.values()) instance.effects = [];
    renderElement(ReactStub.createElement(TestWrapper), 'root');
    const effects = [];
    for (const instance of instances.values()) effects.push(...instance.effects.splice(0));
    for (const effect of effects) effect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!dirty) return;
  }
}

/* ---------- run ---------- */
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

try {
  await renderUntilStable();
  console.log('PASS render page with relay state; fetches:', fetchCalls.map((call) => call.url.split('/').pop()).join(','));
} catch (error) {
  console.log('FAIL initial render:', error && error.stack ? error.stack : error);
  process.exit(1);
}

// Select the first remote session through the page's selection state, then
// render the whole conversation flow (turn grouping, context row, reasoning,
// tool group, assistant markdown, failure row, running status).
try {
  let selectionSlot = null;
  for (const instance of instances.values()) {
    if (instance.hooks.length >= 6 && instance.hooks[5] && typeof instance.hooks[5].setter === 'function') {
      selectionSlot = instance.hooks[5];
      break;
    }
  }
  if (!selectionSlot) throw new Error('selection hook not found');
  selectionSlot.setter({ peerId: 'server', sessionId: 'session-abc' });
  dirty = false;
  await renderUntilStable();
  const transcriptCall = fetchCalls.find((call) => call.url.split('/').pop() === 'transcript');
  if (!transcriptCall) throw new Error('transcript endpoint was not called after selection');
  if (transcriptCall.body.sessionId !== 'session-abc') {
    throw new Error('transcript used wrong selection: ' + JSON.stringify(transcriptCall.body));
  }
  const rendered = [...instances.keys()].map((key) => key.split(':')[0]);
  const expected = ['TurnBlock', 'TurnProcessRow', 'MessageRow', 'ToolRow'];
  const missing = expected.filter((name) => !rendered.includes(name));
  if (missing.length) throw new Error('conversation components missing from render tree: ' + missing.join(','));
  console.log('PASS render conversation flow for', transcriptCall.body.peerId + '/' + transcriptCall.body.sessionId);
  console.log('PASS rendered components:', expected.join(','));

  // Expand the settled turn's process row and make sure thinking rows appear.
  const turnKeys = [...instances.keys()].filter((key) => key.startsWith('TurnBlock:'));
  let expanded = false;
  for (const key of turnKeys) {
    const hooks = instances.get(key).hooks;
    if (hooks[0] && typeof hooks[0].setter === 'function' && hooks[0].value === null) {
      hooks[0].setter(true);
      expanded = true;
      break;
    }
  }
  if (!expanded) throw new Error('no closed turn to expand');
  dirty = false;
  await renderUntilStable();
  const after = [...instances.keys()].map((key) => key.split(':')[0]);
  if (!after.includes('ReasoningRow')) throw new Error('expanded turn did not render ReasoningRow');
  console.log('PASS expanded turn process renders ReasoningRow + ToolRow');
} catch (error) {
  console.log('FAIL conversation flow:', error && error.stack ? error.stack : error);
  process.exit(1);
}

console.log('fetch calls:', fetchCalls.length);
process.exit(0);
