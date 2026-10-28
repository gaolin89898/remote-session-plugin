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
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenario = process.argv[2];
if (!scenario) {
  for (const name of ['healthy', 'empty', 'empty-events', 'flow-load', 'flow-render', 'assembler-load', 'events-load', 'missing-export']) {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), name], { stdio: 'inherit' });
  }
  process.exit(0);
}

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
const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
ReactStub.useEffect = (callback, deps) => {
  const index = hookIndex++;
  if (!currentInstance) return;
  const before = currentInstance.hooks[index];
  if (!before || !sameDeps(before.deps, deps)) {
    currentInstance.hooks[index] = { deps };
    currentInstance.effects.push(callback);
  }
};
ReactStub.useRef = (initial) => {
  const instance = currentInstance;
  const index = hookIndex++;
  if (!instance) return { current: initial };
  if (!instance.hooks[index]) instance.hooks[index] = { current: initial };
  return instance.hooks[index];
};
ReactStub.useMemo = (factory, deps) => {
  const index = hookIndex++;
  if (!currentInstance) return factory();
  const before = currentInstance.hooks[index];
  if (!before || !sameDeps(before.deps, deps)) currentInstance.hooks[index] = { deps, value: factory() };
  return currentInstance.hooks[index].value;
};
ReactStub.useCallback = (callback, deps) => ReactStub.useMemo(() => callback, deps);
ReactStub.useLayoutEffect = ReactStub.useEffect;
ReactStub.Component = function Component(props) {
  this.props = props;
  this.state = {};
};
ReactStub.Component.prototype.setState = function (partial) {
  this.state = { ...this.state, ...partial };
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
if (scenario === 'empty') transcriptPayload.messages = [];
const vendorExports = [
  'VendorChatFlow', 'VendorComposer', 'VendorSessionHeader', 'VendorHero',
  'VendorSidebarProjectRow', 'VendorSidebarSessionRow', 'VendorSidebarSectionHeader',
  'VendorSidebarOverflowButton', 'VendorSidebarHeaderActions', 'VendorSidebarSearchPill',
  'ensureVendorIcons', 'VendorActionIcon',
];
const flowSource = "var React = require('react');\n" + vendorExports.map((name) =>
  `module.exports.${name} = function ${name}(props) {
    ${name === 'VendorChatFlow' && scenario === 'flow-render' ? "throw new Error('fixture render failure');" : ''}
    return React.createElement('div', null, ${JSON.stringify(name)});
  };`,
).join('\n') + (scenario === 'missing-export' ? '\ndelete module.exports.VendorComposer;' : '');
const assemblerSource = `module.exports.createChatAssembler = function () { return {
  replace: function () {},
  messages: function () { return ${scenario === 'empty' ? '[]' : "[{ role: 'assistant', text: 'official fixture' }]"}; },
  chatSnapshot: function () { return { timeline: { turnOrder: [] } }; },
  snapshot: function () { return { entries: [{ kind: 'node', key: 'fixture' }] }; }
}; };`;
globalThis.fetch = async (url, options) => {
  const body = options && typeof options.body === 'string' ? JSON.parse(options.body) : {};
  fetchCalls.push({ url: String(url), body });
  const method = String(url).split('/').pop();
  if (method === 'vendor-flow' || method === 'vendor-assembler') {
    const failed = scenario === 'flow-load' && method === 'vendor-flow' || scenario === 'assembler-load' && method === 'vendor-assembler';
    return { ok: !failed, status: failed ? 503 : 200, text: async () => method === 'vendor-flow' ? flowSource : assemblerSource };
  }
  if (method === 'events' && scenario === 'events-load') return { ok: false, status: 503, json: async () => ({ error: 'fixture events failure' }) };
  const payload = method === 'state' || method === 'refresh' ? statePayload : method === 'transcript' ? transcriptPayload
    : method === 'events' ? { ok: true, events: scenario === 'empty' || scenario === 'empty-events' ? [] : [{ seq: 1, type: 'user/message', data: {} }] } : { ok: true };
  return { ok: true, status: 200, json: async () => payload };
};

/* ---------- recursive test renderer ---------- */
const instances = new Map();
let visibleText = '';
function renderElement(element, pathKey) {
  if (element === null || element === undefined || typeof element === 'boolean') return;
  if (typeof element === 'string' || typeof element === 'number') { visibleText += String(element); return; }
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
        try {
          renderElement(tree, key);
        } catch (error) {
          if (typeof element.type.getDerivedStateFromError !== 'function') throw error;
          component.state = { ...component.state, ...element.type.getDerivedStateFromError(error) };
          component.componentDidCatch?.(error);
          renderElement(component.render(), key);
        }
        return;
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
    visibleText = '';
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
  console.log('PASS render page:', scenario);
} catch (error) {
  console.log('FAIL initial render:', error && error.stack ? error.stack : error);
  process.exit(1);
}

// Select a remote session and verify the official-only render/error paths.
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
  const legacy = ['TurnBlock', 'TurnProcessRow', 'MessageRow', 'ToolRow', 'ReasoningRow', 'MarkdownBoundary'];
  assert.ok(legacy.every(name => !rendered.includes(name)), 'legacy components rendered');
  if (scenario === 'healthy') {
    for (const name of ['VendorChatFlow', 'VendorComposer', 'VendorSessionHeader', 'VendorSidebarSectionHeader']) {
      assert.ok(rendered.includes(name), 'missing official component: ' + name);
    }
    assert.doesNotMatch(visibleText, /官方.*失败/);
  } else if (scenario === 'empty') {
    assert.ok(rendered.includes('VendorHero'));
    assert.ok(rendered.includes('VendorComposer'));
    assert.doesNotMatch(visibleText, /官方.*失败/);
  } else {
    assert.match(visibleText, /官方.*失败/);
    assert.ok(!visibleText.includes('帮我看看项目结构'), 'raw bridge messages leaked into the body');
    if (scenario === 'flow-load' || scenario === 'missing-export') assert.ok(!rendered.includes('VendorChatFlow'));
  }
  console.log('PASS official-only conversation:', scenario);
} catch (error) {
  console.log('FAIL conversation flow:', error && error.stack ? error.stack : error);
  process.exit(1);
}

console.log('fetch calls:', fetchCalls.length);
process.exit(0);
