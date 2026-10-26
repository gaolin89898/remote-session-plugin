import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'research/browser/out');
fs.mkdirSync(outDir, { recursive: true });

const bakedMode = process.env.BAKED_CLIENT === '1';
const clientSource = fs.readFileSync(
  bakedMode
    ? path.join(root, 'dist/dsh-remote-session/lib/client.js')
    : path.join(root, 'lib/client.js'),
  'utf8',
);
const flowSource = fs.readFileSync(path.join(root, 'lib/vendor/flow.cjs'), 'utf8');
const assemblerSource = fs.readFileSync(path.join(root, 'lib/vendor/assembler.cjs'), 'utf8');

const now = Date.now();
const events = [
  { seq: 1, time: now - 9000, type: 'turn/start', data: { turn: 1 }, surfaceOp: 'append' },
  { seq: 2, time: now - 8950, type: 'permission/preset', data: { preset: 'read-only' }, surfaceOp: 'append' },
  { seq: 2, time: now - 8900, type: 'step/start', data: { turn: 1, step: 1 }, surfaceOp: 'append' },
  { seq: 2, time: now - 9000, type: 'request/header', data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high', maxTokens: 8192 }, tools: [] } }, surfaceOp: 'append' },
  { seq: 2, time: now - 8990, type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'goal-1', revision: 1, objective: '继续吧', phase: 'active', maxGoalRounds: 256 }, roundsStarted: 1, createdAt: now - 9000, updatedAt: now - 8990 }, surfaceOp: 'append' },
  { seq: 2, time: now - 8980, type: 'user/message', data: { content: [{ type: 'text', text: '<hindsight_knowledge_refresh> hidden memory reminder' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  { seq: 2, time: now - 8970, type: 'system/message', data: { turn: 1, step: 1, message: { id: 'sys-1', role: 'system', content: [{ type: 'text', text: 'Time sampled while preparing turn 1 — hidden context row' }], source: { kind: 'request-prompt' } } }, surfaceOp: 'append' },
  { seq: 3, time: now - 8950, type: 'developer/message', data: { turn: 1, step: 1, message: { id: 'dev-1', role: 'developer', content: [{ type: 'text', text: 'model changed: hidden context row' }], source: { kind: 'runtime-context' } } }, surfaceOp: 'append' },
  { seq: 3, time: now - 8800, type: 'user/message', data: { content: [{ type: 'text', text: '你好，帮我看看这个仓库' }, { type: 'image', attachment: { attachmentId: 'sha256:0000000000000000000000000000000000000000000000000000000000000001', mediaType: 'image/png', width: 2, height: 2, bytes: 70, name: 'image.png' } }], source: { kind: 'user' } }, surfaceOp: 'append' },
  { seq: 4, time: now - 7000, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '先读一下项目结构，再回答。' }, { type: 'text', text: '好的，我先看一下目录结构。' }] } }, surfaceOp: 'append' },
  { seq: 5, time: now - 6000, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_browser_1', name: 'bash', arguments: '{"command":"ls -la"}' }, surfaceOp: 'append' },
  { seq: 6, time: now - 5000, type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call_browser_1' }, content: [{ type: 'tool-result', toolCallId: 'call_browser_1', content: [{ type: 'text', text: 'total 12\n\n(Omitted 2048 bytes. Full formatted result stored at: C:/Users/x/.dsh/spill/abc.txt. Read the full result from the spill file with read_file.)' }] }] } }, surfaceOp: 'append' },
  { seq: 7, time: now - 4000, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'msg-assistant-final', role: 'assistant', content: [{ type: 'reasoning', text: '文件读到了，可以总结。' }, { type: 'text', text: '这是**官方渲染**的回复，代码块：\n\n```ts\nexport const answer = 42\n```\n\n文件链接：[src/index.ts](src/index.ts)' }] } }, surfaceOp: 'append' },
  { seq: 8, time: now - 3000, type: 'step/end', data: { turn: 1, step: 1 }, surfaceOp: 'append' },
  { seq: 9, time: now - 2000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, surfaceOp: 'append' },
  { seq: 10, time: now - 1800, type: 'turn/start', data: { turn: 2 }, surfaceOp: 'append' },
  { seq: 11, time: now - 1700, type: 'step/start', data: { turn: 2, step: 1 }, surfaceOp: 'append' },
  { seq: 12, time: now - 1600, type: 'user/message', data: { content: [{ type: 'text', text: '第二轮：把结论整理成要点' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  { seq: 13, time: now - 1200, type: 'assistant/message', data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '要点一：官方渲染已对齐。' }] } }, surfaceOp: 'append' },
  { seq: 14, time: now - 900, type: 'step/end', data: { turn: 2, step: 1 }, surfaceOp: 'append' },
  { seq: 15, time: now - 800, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, surfaceOp: 'append' },
];

const state = {
  ok: true,
  self: { id: 'home', name: '家里', version: '3.0.0' },
  peers: [
    {
      id: 'home',
      name: '家里',
      online: true,
      version: '3.0.0',
      workspaces: {
        workspaces: [
          {
            id: 'ws-demo',
            title: null,
            path: 'C:/work/demo',
            sessionIds: ['session-official', 'session-a', 'session-b', 'session-c', 'session-d', 'session-e', 'session-f'],
          },
        ],
        archivedSessionIds: ['session-f'],
      },
      sessions: [
        { id: 'session-official', title: '官方渲染验证', cwd: 'C:/work/demo', updatedAt: now, running: false, blank: false },
        { id: 'session-blank', title: '空白会话', cwd: 'C:/work/demo', updatedAt: now - 5000, running: false, blank: true },
        { id: 'session-a', title: 'Token 用量与域名备案咨询', cwd: 'C:/work/demo', updatedAt: now - 15 * 60 * 1000, running: false, blank: false },
        { id: 'session-b', title: '服务器部署 Hermes 服务', cwd: 'C:/work/demo', updatedAt: now - 4 * 60 * 60 * 1000, running: false, blank: false },
        { id: 'session-c', title: '现在 ai 短剧的剧情都是从哪里', cwd: 'C:/work/demo', updatedAt: now - 26 * 60 * 60 * 1000, running: false, blank: false },
        { id: 'session-d', title: '展开其余测试会话', cwd: 'C:/work/demo', updatedAt: now - 50 * 60 * 60 * 1000, running: false, blank: false },
        { id: 'session-e', title: '更多历史会话 A', cwd: 'C:/work/demo', updatedAt: now - 80 * 60 * 60 * 1000, running: false, blank: false },
        { id: 'session-f', title: '更多历史会话 B', cwd: 'C:/work/demo', updatedAt: now - 120 * 60 * 60 * 1000, running: false, blank: false },
      ],
    },
  ],
};

const transcript = {
  ok: true,
  session: { id: 'session-official', title: '官方渲染验证', cwd: 'C:/work/demo', updatedAt: now, running: true },
  messages: [
    { seq: 3, at: now - 8800, role: 'user', text: '你好，帮我看看这个仓库' },
    { seq: 4, at: now - 7000, role: 'assistant', text: '好的，我先看一下目录结构。' },
    { seq: 9, at: now - 2000, role: 'turn-end', turn: 1, durationMs: 7000, reason: 'ok' },
  ],
  total: 3,
  truncated: false,
};

const artworkPath = path.join(root, 'vendor/.src/packages/client/ui-primitives/src/icons/artwork.ts').split(path.sep).join('/');
const entry = path.join(outDir, 'entry.jsx');
fs.writeFileSync(entry, `
import React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ICON_SYMBOLS } from ${JSON.stringify(artworkPath)};

const CLIENT_SOURCE = ${JSON.stringify(clientSource)};
const FLOW_SOURCE = ${JSON.stringify(flowSource)};
const ASSEMBLER_SOURCE = ${JSON.stringify(assemblerSource)};
const STATE = ${JSON.stringify(state)};
const TRANSCRIPT = ${JSON.stringify(transcript)};
const EVENTS = ${JSON.stringify(events)};

const jsxRuntime = {
  jsx: (type, props) => React.createElement(type, props),
  jsxs: (type, props) => React.createElement(type, props),
  jsxDEV: (type, props) => React.createElement(type, props),
  Fragment: React.Fragment,
};
const vendorModules = new Map();
function vendorRequire(name) {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  if (name === 'react-dom') return ReactDOM;
  if (name === 'react-dom/client') return { createRoot };
  return new Proxy({}, { get: () => undefined });
}

const BAKED_MODE = ${bakedMode ? 'true' : 'false'};
const responses = new Map();
let registrations = [];
let pluginModule = null;

window.__ModuleLoader__ = {
  load({ id, factory }) {
    pluginModule = factory(vendorRequire);
    return { id };
  },
};

function respond(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
}
window.fetch = (input, init) => {
  const url = String(input && input.url ? input.url : input);
  const method = url.split('/').pop().split('?')[0];
  if (method === 'state') return respond(STATE);
  const requestBody = (() => { try { return init && init.body ? JSON.parse(String(init.body)) : {}; } catch (_error) { return {}; } })();
  if (method === 'transcript') {
    if (requestBody.sessionId === 'session-blank') {
      return respond({ ok: true, session: { id: 'session-blank', title: '空白会话', cwd: 'C:/work/demo', updatedAt: Date.now(), running: false }, messages: [], total: 0, truncated: false });
    }
    return respond(TRANSCRIPT);
  }
  if (method === 'events') {
    if (requestBody.sessionId === 'session-blank') {
      return respond({ ok: true, session: { id: 'session-blank', running: false }, events: [], hasMore: false });
    }
    const limit = Number(requestBody.limit) || 4000;
    window.__EVENT_LIMITS__ = (window.__EVENT_LIMITS__ || []).concat([limit]);
    if (requestBody.afterSeq) {
      return respond({ ok: true, session: { id: 'session-official', running: false }, events: [], hasMore: false, cursor: EVENTS[EVENTS.length - 1].seq, totalEvents: 12, hasOlder: limit < 1600 });
    }
    const visible = EVENTS;
    return respond({
      ok: true,
      session: { id: 'session-official', running: false },
      events: visible,
      hasMore: false,
      hasOlder: limit < 1600,
      totalEvents: 12,
      cursor: visible[visible.length - 1].seq,
    });
  }
  if (method === 'vendor-assembler' || method === 'vendor-flow' || method === 'vendor-chat') {
    if (BAKED_MODE) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
    if (method === 'vendor-assembler') return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(ASSEMBLER_SOURCE) });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(FLOW_SOURCE) });
  }
  if (method === 'models') {
    window.__MODELS_CALLS__ = (window.__MODELS_CALLS__ || 0) + 1;
    return respond({ ok: true, catalog: {
      default: { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      routableProviders: ['deepseek-account'],
      groups: [{ id: 'deepseek-account', name: 'DeepSeek Account', models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
      ] }, { id: 'custom', name: 'Custom Provider', models: [
        { id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }, { id: 'gamma', name: 'Gamma' },
      ] }],
    } });
  }
  if (method === 'select-model') {
    window.__SELECT_MODEL_CALLS__ = (window.__SELECT_MODEL_CALLS__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, accepted: true });
  }
  if (method === 'settings') {
    return respond({
      ok: true,
      relayUrl: 'http://127.0.0.1:3098',
      instanceId: 'home',
      instanceName: '家里',
      hasToken: true,
      tokenHint: 'c0726',
      relay: { connected: true, lastError: null },
    });
  }
  if (method === 'settings-save') {
    const body = (() => { try { return JSON.parse(String(init && init.body)); } catch (_error) { return {}; } })();
    window.__SETTINGS_SAVE__ = (window.__SETTINGS_SAVE__ || []).concat([body]);
    return respond({
      ok: true,
      relayUrl: body.relayUrl,
      instanceId: body.instanceId,
      instanceName: body.instanceName,
      hasToken: true,
      tokenHint: 'c0726',
      relay: { connected: true, lastError: null },
    });
  }
  if (method === 'goal-action') {
    window.__GOAL_ACTIONS__ = (window.__GOAL_ACTIONS__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, result: { ok: true } });
  }
  if (method === 'permission-catalog') {
    return respond({ ok: true, catalog: {
      options: [
        { value: 'read-only', name: 'Read Only' },
        { value: 'workspace-write', name: 'Workspace Write' },
        { value: 'danger-full-access', name: 'Full access' },
        { value: 'auto', name: 'Auto' },
      ],
      defaultOptions: [{ value: 'workspace-write', name: 'Workspace Write' }],
      defaultPreset: 'workspace-write',
    } });
  }
  if (method === 'permission-set') {
    window.__PERMISSION_SET__ = (window.__PERMISSION_SET__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, result: { ok: true, preset: 'workspace-write' } });
  }
  if (method === 'feedback') {
    return respond({ ok: true, result: { ok: true, value: { items: window.__FEEDBACK_ITEMS__ || [] } } });
  }
  if (method === 'feedback-put') {
    const body = (() => { try { return JSON.parse(String(init && init.body)); } catch (_error) { return {}; } })();
    const request = body.request || {};
    const item = { messageId: request.messageId, rating: request.rating, version: 'v-' + Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
    window.__FEEDBACK_ITEMS__ = (window.__FEEDBACK_ITEMS__ || []).filter((existing) => existing.messageId !== item.messageId).concat([item]);
    window.__FEEDBACK_PUT__ = (window.__FEEDBACK_PUT__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, result: { ok: true, value: item } });
  }
  if (method === 'feedback-delete') {
    const body = (() => { try { return JSON.parse(String(init && init.body)); } catch (_error) { return {}; } })();
    const request = body.request || {};
    window.__FEEDBACK_ITEMS__ = (window.__FEEDBACK_ITEMS__ || []).filter((existing) => existing.messageId !== request.messageId);
    window.__FEEDBACK_DELETE__ = (window.__FEEDBACK_DELETE__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, result: { ok: true, value: { absent: true } } });
  }
  if (method === 'create') {
    window.__CREATE_CALLS__ = (window.__CREATE_CALLS__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, sessionId: 'session-blank' });
  }
  if (method === 'open-path') {
    window.__OPEN_PATH_CALLS__ = (window.__OPEN_PATH_CALLS__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, opened: true });
  }
  if (method === 'commands') {
    return respond({ ok: true, commands: [
      { definitionId: 'x', name: 'compact', description: 'Compact older conversation history' },
      { definitionId: 'y', name: 'feedback', description: 'Record feedback about this session', input: { hint: '<text>' } },
      { definitionId: 'z', name: 'permission', description: 'Switch the permission preset' },
    ] });
  }
  if (method === 'execute-command') {
    window.__COMMAND_CALLS__ = (window.__COMMAND_CALLS__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, accepted: true });
  }
  if (method === 'file-references') {
    window.__FILE_REFERENCE_CALLS__ = (window.__FILE_REFERENCE_CALLS__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, candidates: [] });
  }
  if (method === 'files') {
    window.__FILE_SCAN_CALLS__ = (window.__FILE_SCAN_CALLS__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, candidates: [
      { path: 'src/main.ts', name: 'main.ts' },
      { path: 'src/app.tsx', name: 'app.tsx' },
    ] });
  }
  if (method === 'attachment') {
    window.__ATTACHMENT_CALLS__ = (window.__ATTACHMENT_CALLS__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({
      ok: true,
      attachment: { attachmentId: 'sha256:0000000000000000000000000000000000000000000000000000000000000001', mediaType: 'image/png' },
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    });
  }
  if (method === 'fork') {
    window.__FORK_CALLS__ = (window.__FORK_CALLS__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, sessionId: 'session-forked' });
  }
  if (method === 'send') {
    window.__SEND_CALLS__ = (window.__SEND_CALLS__ || []).concat([init && init.body ? String(init.body) : '']);
    return respond({ ok: true, accepted: true, result: { ok: true } });
  }
  return respond({ ok: true });
};

// Execute the plugin client bundle; it registers into __ModuleLoader__.
new Function(CLIENT_SOURCE.replace(/^\\s*\\/\\/.*$/gmu, ''))();

const slots = {
  register(meta, component) {
    registrations.push({ meta, component });
    return () => {};
  },
  inject(_name, callback) {
    return callback();
  },
  entries() { return registrations; },
};
const ctx = {
  slots,
  effect(run) { const dispose = run(); return typeof dispose === 'function' ? dispose : () => {}; },
  on() { return () => {}; },
  get() { return undefined; },
  provide() { return () => {}; },
};
// Install the product icon sprite the official components reference by id.
try {
  const parser = new DOMParser();
  const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sprite.setAttribute('style', 'display:none');
  sprite.setAttribute('aria-hidden', 'true');
  for (const [id, markup] of Object.entries(ICON_SYMBOLS)) {
    const doc = parser.parseFromString(markup, 'image/svg+xml');
    const svg = doc.documentElement;
    const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
    symbol.setAttribute('id', id);
    for (const attribute of Array.from(svg.attributes)) {
      if (attribute.name === 'xmlns' || attribute.name === 'viewBox') continue;
      symbol.setAttribute(attribute.name, attribute.value);
    }
    symbol.setAttribute('viewBox', svg.getAttribute('viewBox') || '0 0 16 16');
    symbol.innerHTML = svg.innerHTML;
    sprite.appendChild(symbol);
  }
  document.body.appendChild(sprite);
} catch (error) {
  console.warn('icon sprite install failed', error);
}

Promise.resolve(pluginModule && pluginModule.apply ? pluginModule.apply(ctx) : undefined).then(() => {
  const page = registrations.find((entry) => entry.meta && entry.meta.name === 'main');
  const icon = registrations.find((entry) => entry.meta && entry.meta.name === 'sidebar.panellist');
  const host = document.getElementById('root');
  const root = createRoot(host);
  root.render(
    React.createElement('div', { style: { display: 'flex', height: '100vh', background: 'var(--dsw-alias-bg-panel, #fff)' } },
      React.createElement('div', { style: { width: 260, borderRight: '0.5px solid rgba(0,0,0,0.08)', padding: 8, overflow: 'auto' } },
        icon ? React.createElement(icon.component, {}) : null),
      React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' } },
        page ? React.createElement(page.component, {}) : React.createElement('div', null, 'main slot missing')),
    ),
  );
  // Mount the official Settings-page contribution on demand for its spec.
  window.__REGISTRATION_NAMES__ = registrations.map((entry) => entry.meta && entry.meta.name);
  window.__MOUNT_SETTINGS_SECTION__ = () => {
    const entry = registrations.find((candidate) => candidate.meta && candidate.meta.name === 'settings.section');
    if (!entry) return null;
    const container = document.createElement('div');
    container.setAttribute('data-settings-section-host', '');
    container.style.cssText = 'position:fixed;inset:40px 40px auto 40px;max-width:640px;padding:20px;background:var(--dsw-alias-bg-layer-1,#fff);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.25);z-index:9999;';
    document.body.appendChild(container);
    const injected = typeof entry.meta.inject === 'function' ? entry.meta.inject() : {};
    createRoot(container).render(React.createElement(entry.component, { close: () => {}, ...injected }));
    return true;
  };
  window.__UNMOUNT_SETTINGS_SECTION__ = () => {
    const container = document.querySelector('[data-settings-section-host]');
    if (container) container.remove();
  };
  window.__HARNESS_READY__ = true;
});
`);

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  jsx: 'automatic',
  outfile: path.join(outDir, 'harness.js'),
  loader: { '.js': 'js' },
  logLevel: 'warning',
});

fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>remote-session 官方渲染验证</title>
<link rel="stylesheet" href="../../../vendor/.src/packages/client/ui-theme/src/styles/base.css" />
<link rel="stylesheet" href="../../../vendor/.src/packages/client/ui-theme/src/styles/design-platform.css" />
<link rel="stylesheet" href="../../../vendor/.src/packages/client/ui-theme/src/styles/gradient-shadow-text.css" />
<link rel="stylesheet" href="../../../vendor/.src/packages/client/ui-theme/src/styles/shiki.css" />
<link rel="stylesheet" href="../../../vendor/.src/packages/client/ui-theme/src/styles/scrollbar.css" />
<link rel="stylesheet" href="../../../vendor/.src/packages/client/ui-theme/src/styles/focus.css" />
<link rel="stylesheet" href="../../../vendor/.src/packages/client/ui-theme/src/styles/corner-shape.css" />
<style>html,body,#root{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style>
</head><body><div id="root"></div><script src="./harness.js"></script></body></html>
`);
console.log('harness built ->', path.join(outDir, 'index.html'));
