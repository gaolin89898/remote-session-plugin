import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'research/browser/out');
const pageFile = 'file:///' + path.join(outDir, 'index.html').replaceAll('\\', '/');

const executablePath = process.env.DSH_CHROMIUM
  || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

await page.goto(pageFile, { waitUntil: 'load' });
await page.waitForFunction(() => window.__HARNESS_READY__ === true, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.getByText('官方渲染验证').first().click().catch(() => {});
await page.waitForTimeout(2500);
// Sidebar: expand the peer so the official workspace/session rows are visible.
for (let attempt = 0; attempt < 3; attempt += 1) {
  const rows = await page.evaluate(() => document.querySelectorAll('[role="treeitem"]').length);
  if (rows >= 3) break;
  await page.getByText('家里', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(500);
}
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, 'sidebar.png'), clip: { x: 280, y: 0, width: 285, height: 760 } });

// Composer interaction: official Lexical editor must accept typing and Enter.
const editor = page.locator('[data-input-scroll] [contenteditable="true"]').first();
const editorCount = await editor.count();
if (editorCount > 0) {
  await editor.click();
  await page.keyboard.type('你好远端编辑器');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
}
const sendCalls = await page.evaluate(() => (window.__SEND_CALLS__ || []).length);
const sendBodiesAll = await page.evaluate(() => window.__SEND_CALLS__ || []);
const sendMode = sendBodiesAll.length > 0 ? (/\"mode\":\"([a-z]+)\"/.exec(String(sendBodiesAll[0])) || [])[1] || null : null;
console.log('SEND', JSON.stringify({ calls: sendCalls, mode: sendMode }));
// Official file-reference chip flow: type `@`, pick a candidate, then send.
if (editorCount > 0) {
  await editor.click();
  await page.keyboard.type('@src');
  await page.waitForTimeout(500);
}
const mentionOpen = await page.locator('[data-trigger-menu]').count();
let mentionPicked = false;
if (mentionOpen > 0) {
  await page.locator('[data-trigger-menu] button').first().click();
  await page.waitForTimeout(400);
  mentionPicked = (await page.evaluate(() => /main\.ts/.test(document.body.innerText)));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}
const fileReferenceCalls = await page.evaluate(() => (window.__FILE_REFERENCE_CALLS__ || []).length);
const fileScanCalls = await page.evaluate(() => (window.__FILE_SCAN_CALLS__ || []).length);
const sendBodies = await page.evaluate(() => window.__SEND_CALLS__ || []);
const mentionSent = sendBodies.some((body) => String(body).includes('src/main.ts'));
console.log('MENTION', JSON.stringify({ open: mentionOpen > 0, picked: mentionPicked, calls: fileReferenceCalls, scans: fileScanCalls, sent: mentionSent }));

// Slash command menu: `/` opens the host catalog and runs through execute-command.
if (editorCount > 0) {
  await editor.click();
  await page.keyboard.type('/');
  await page.waitForTimeout(500);
}
const commandMenu = await page.locator('[data-trigger-menu]').count();
let commandPicked = false;
if (commandMenu > 0) {
  await page.locator('[data-trigger-menu] button').first().click();
  await page.waitForTimeout(400);
  commandPicked = /compact/.test(await page.evaluate(() => document.body.innerText));
  const editorState = await page.evaluate(() => {
    const root = document.querySelector('[data-input-scroll] [contenteditable="true"]');
    return { text: root ? root.innerText : null, html: root ? root.innerHTML.slice(0, 400) : null };
  });
  console.log('EDITOR-AFTER-PICK', JSON.stringify(editorState));
  await editor.click();
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const afterEnter = await page.evaluate(() => {
    const root = document.querySelector('[data-input-scroll] [contenteditable="true"]');
    return { text: root ? root.innerText : null, sendCalls: (window.__SEND_CALLS__ || []).length, commandCalls: (window.__COMMAND_CALLS__ || []).length };
  });
  console.log('AFTER-ENTER', JSON.stringify(afterEnter));
}
let commandCalls = await page.evaluate(() => window.__COMMAND_CALLS__ || []);
const compactRan = commandCalls.some((body) => String(body).includes('/compact'));
// Command with arguments: /feedback + typed text must submit the full line.
let feedbackLine = null;
if (editorCount > 0) {
  await editor.click();
  await page.keyboard.type('/feed');
  await page.waitForTimeout(500);
  const feedbackMenu = await page.locator('[data-trigger-menu] button', { hasText: '/feedback' }).count();
  if (feedbackMenu > 0) {
    await page.locator('[data-trigger-menu] button', { hasText: '/feedback' }).first().click();
    await page.waitForTimeout(250);
    await editor.click();
    await page.keyboard.type(' the button is good');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    commandCalls = await page.evaluate(() => window.__COMMAND_CALLS__ || []);
    const match = commandCalls.map((body) => String(body)).filter((body) => body.includes('/feedback'));
    feedbackLine = match.length > 0 ? match[match.length - 1] : null;
  }
}
const commandRan = commandCalls.some((body) => String(body).includes('/compact'));
console.log('COMMAND', JSON.stringify({
  menu: commandMenu > 0,
  picked: commandPicked,
  compact: compactRan,
  feedback: feedbackLine ? /\/feedback the button is good/.test(feedbackLine) : false,
  calls: commandCalls.map((body) => String(body).slice(0, 220)),
}));

// File link in assistant Markdown must call the remote open-path endpoint.
let openFileCalls = 0;
const clickedFileLink = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((node) => node.innerText.trim() === 'src/index.ts');
  if (!button) return false;
  button.click();
  return true;
});
if (clickedFileLink) await page.waitForTimeout(600);
openFileCalls = await page.evaluate(() => (window.__OPEN_PATH_CALLS__ || []).length);
console.log('OPENFILE', JSON.stringify({ calls: openFileCalls }));

// Composer model pill: shows the session model and switches through select-model.
const modelPillText = await page.evaluate(() => {
  const button = document.querySelector('[aria-label^="选择模型，当前"]');
  return button ? button.innerText.trim() : null;
});
let modelSwitched = false;
if (modelPillText) {
  await page.locator('[aria-label^="选择模型，当前"]').first().click();
  await page.waitForTimeout(300);
  const menuOpen = await page.getByRole('menu', { name: '模型与推理等级' }).count();
  if (menuOpen > 0) {
    await page.getByRole('menuitem', { name: /^模型/ }).click();
    await page.getByRole('menuitemradio', { name: 'DeepSeek-V4.1-Flash' }).click();
    await page.waitForTimeout(500);
    modelSwitched = (await page.evaluate(() => (window.__SELECT_MODEL_CALLS__ || []).length)) > 0;
  }
}
const modelsCalls = await page.evaluate(() => window.__MODELS_CALLS__ || 0);
console.log('MODEL', JSON.stringify({ pill: modelPillText, switched: modelSwitched, modelsCalls }));

// New remote session: header `+` calls create, then the official hero shows.
const createButton = page.locator('[aria-label="在远端新建会话"]').first();
if (await createButton.count() > 0) {
  await createButton.click().catch(() => {});
  await page.waitForTimeout(1800);
}
const heroState = await page.evaluate(() => ({
  hero: /探索未至之境/.test(document.body.innerText),
  editor: Boolean(document.querySelector('[data-input-scroll] [contenteditable="true"]')),
}));
console.log('HERO', JSON.stringify(heroState));
await page.screenshot({ path: path.join(root, 'research/browser/hero.png'), fullPage: false }).catch(() => {});
await page.getByText('官方渲染验证').first().click().catch(() => {});
await page.waitForTimeout(1500);

// Assistant-actions feedback: thumbs render in the official tail and record through the host.
const likeButton = page.locator('[data-feedback-rating="positive"]').first();
const dislikePresent = await page.locator('[data-feedback-rating="negative"]').count();
let feedbackState = {
  present: (await likeButton.count()) > 0,
  dislike: dislikePresent > 0,
  available: await page.evaluate(() => [...document.querySelectorAll('[data-feedback-dialog]')].map((node) => node.getAttribute('data-feedback-dialog'))),
  dialog: false,
  put: 0,
};
if (feedbackState.present) {
  await likeButton.click().catch(() => {});
  await page.waitForTimeout(600);
  feedbackState.dialog = await page.evaluate(() => /提交反馈/.test(document.body.innerText));
  if (feedbackState.dialog) {
    await page.locator('button', { hasText: '任务结果' }).first().click().catch(() => {});
    await page.locator('textarea[aria-label="反馈详情"]').first().fill('按钮反馈：渲染对齐官方').catch(() => {});
    await page.locator('button', { hasText: '提交' }).first().click().catch(() => {});
    await page.waitForTimeout(900);
  }
  feedbackState.put = await page.evaluate(() => (window.__FEEDBACK_PUT__ || []).length);
  feedbackState.putHasNote = await page.evaluate(() => (window.__FEEDBACK_PUT__ || []).some((body) => String(body).includes('渲染对齐官方')));
  feedbackState.active = await page.locator('[data-feedback-active="1"]').count();
  feedbackState.attrs = await page.evaluate(() => [...document.querySelectorAll('[data-feedback-rating]')].map((node) => ({ rating: node.getAttribute('data-feedback-rating'), active: node.getAttribute('data-feedback-active') })).slice(0, 4));
}
console.log('FEEDBACK', JSON.stringify(feedbackState));

// Sidebar search: the official search pill filters workspace sessions live.
const searchButton = page.locator('button[aria-label="搜索会话"]').first();
let searchState = { opened: false, filtered: null, empty: false };
if (await searchButton.count() > 0) {
  await searchButton.click().catch(() => {});
  await page.waitForTimeout(300);
  const searchInput = page.locator('input[placeholder="搜索会话…"]').first();
  searchState.opened = (await searchInput.count()) > 0;
  if (searchState.opened) {
    await searchInput.fill('官方');
    await page.waitForTimeout(400);
    searchState.filtered = await page.evaluate(() => document.querySelectorAll('[role="treeitem"]').length);
    await searchInput.fill('zzz-no-such-session');
    await page.waitForTimeout(400);
    searchState.empty = await page.evaluate(() => /无匹配会话/.test(document.body.innerText));
    await searchInput.press('Escape');
    await page.waitForTimeout(300);
  }
}
console.log('SEARCH', JSON.stringify(searchState));

// Workspace and session rows render upstream components; remote grouping and
// progressive disclosure remain panel adapters.
const sidebar = await page.evaluate(() => ({
  treeItems: document.querySelectorAll('[role="treeitem"]').length,
  overflow: (() => {
    const button = [...document.querySelectorAll('button')].find((node) => /^展开其余 \d+ 个会话$/.test(node.textContent || ''));
    return button ? button.textContent : null;
  })(),
  officialTimes: /\d+分钟|\d+小时|\d+天/.test(document.body.innerText),
  archivedHidden: !/更多历史会话 B/.test(document.body.innerText),
  inlineIcons: [...document.querySelectorAll('svg[data-icon*="folder-"]')].map((node) => ({
    id: node.getAttribute('data-icon'),
    children: node.childNodes.length,
    width: Math.round(node.getBoundingClientRect().width),
  })),
  relativeWithSuffix: /\d+(分钟|小时|天)前/.test(document.body.innerText),
}));
console.log('SIDEBAR', JSON.stringify(sidebar));

// Remote-session settings dialog: reachable from the panel header, saves over RPC.
const settingsButton = page.locator('button', { hasText: '设置' }).first();
let settingsState = { opened: false, fields: 0, saved: 0, relayUrl: null };
if (await settingsButton.count() > 0) {
  await settingsButton.click().catch(() => {});
  await page.waitForTimeout(500);
  settingsState.opened = (await page.locator('[aria-label="远程会话设置"]').count()) > 0;
  if (settingsState.opened) {
    settingsState.fields = await page.locator('[aria-label="远程会话设置"] input').count();
    const relayInput = page.locator('[aria-label="远程会话设置"] input').first();
    await relayInput.fill('http://10.0.0.5:3098').catch(() => {});
    await page.locator('button', { hasText: '保存并重连' }).first().click().catch(() => {});
    await page.waitForTimeout(700);
    settingsState.saved = await page.evaluate(() => (window.__SETTINGS_SAVE__ || []).length);
    settingsState.relayUrl = await page.evaluate(() => {
      const body = (window.__SETTINGS_SAVE__ || [])[0];
      return body ? body.relayUrl : null;
    });
    settingsState.closed = (await page.locator('[aria-label="远程会话设置"]').count()) === 0;
  }
}
console.log('SETTINGS', JSON.stringify(settingsState));

// Official Settings page: the plugin contributes its own section (below 侧边卡片).
const settingsSection = { registered: false, mounted: false, fields: 0, saved: 0, relayUrl: null };
settingsSection.registered = await page.evaluate(() => (window.__REGISTRATION_NAMES__ || []).includes('settings.section'));
if (settingsSection.registered) {
  settingsSection.mounted = await page.evaluate(() => window.__MOUNT_SETTINGS_SECTION__() === true);
  await page.waitForTimeout(600);
  const host = page.locator('[data-settings-section-host]');
  if (await host.count() > 0) {
    settingsSection.fields = await host.locator('input').count();
    await host.locator('input[aria-label="Relay 地址"]').fill('http://10.0.0.8:3098').catch(() => {});
    await host.locator('button', { hasText: '保存并重连' }).click().catch(() => {});
    await page.waitForTimeout(700);
    settingsSection.saved = await page.evaluate(() => (window.__SETTINGS_SAVE__ || []).length);
    settingsSection.relayUrl = await page.evaluate(() => {
      const bodies = window.__SETTINGS_SAVE__ || [];
      return bodies.length > 0 ? bodies[bodies.length - 1].relayUrl : null;
    });
    await page.evaluate(() => window.__UNMOUNT_SETTINGS_SECTION__());
  }
}
console.log('SETTINGS-SECTION', JSON.stringify(settingsSection));

// Official turn rail at the transcript's right edge: one mark per turn, click jumps.
const turnRail = await page.evaluate(() => {
  const rail = document.querySelector('[data-vendor-turn-rail]');
  if (!rail) return { present: false };
  const marks = [...rail.querySelectorAll('button')];
  return { present: true, marks: marks.length, current: rail.querySelector('[aria-current="true"]') !== null };
});
if (turnRail.present && turnRail.marks >= 2) {
  await page.evaluate(() => {
    const rail = document.querySelector('[data-vendor-turn-rail]');
    const marks = [...rail.querySelectorAll('button')];
    marks[0].click();
  });
  await page.waitForTimeout(600);
}
console.log('TURNRAIL', JSON.stringify(turnRail));

// Settled log beats a stale host running flag: no running status on a completed turn.
const runningState = await page.evaluate(() => ({
  runningRow: /深度求索中/.test(document.body.innerText),
  runningStatus: Boolean(document.querySelector('[data-chat-flow-kind="running-status"]')),
}));
console.log('RUNNING', JSON.stringify(runningState));

// Official goal dock above the composer, with host-backed pause.
const goalDock = page.locator('[data-goal-bar]').first();
const goalState = { present: (await goalDock.count()) > 0, text: null, actions: 0 };
if (goalState.present) {
  goalState.text = (await goalDock.innerText()).replace(/\s+/g, ' ').slice(0, 120);
  const goalButtons = await page.evaluate(() => [...document.querySelectorAll('[data-goal-bar] button')].map((node) => node.getAttribute('aria-label')));
  console.log('GOAL-BUTTONS', JSON.stringify(goalButtons));
  const clearButton = page.locator('button[aria-label="清除目标"]').first();
  if (await clearButton.count() > 0) {
    await clearButton.click().catch(() => {});
    await page.waitForTimeout(600);
    goalState.actions = await page.evaluate(() => (window.__GOAL_ACTIONS__ || []).length);
    goalState.bodies = await page.evaluate(() => (window.__GOAL_ACTIONS__ || []).map((body) => String(body).slice(0, 200)));
  }
}
console.log('GOAL', JSON.stringify(goalState));

// Official visibility: system prompts and plain Context rows stay out of the transcript.
const hiddenRows = await page.evaluate(() => ({
  systemPrompt: /Time sampled while preparing turn 1/.test(document.body.innerText),
  context: /model changed: hidden context row/.test(document.body.innerText),
  hindsight: /hindsight_knowledge_refresh/.test(document.body.innerText),
}));
console.log('VISIBILITY', JSON.stringify(hiddenRows));

// History paging: the official “load earlier” control appears only while older events exist.
const loadOlder = page.getByRole('button', { name: '加载更早' });
const historyState = { initial: await loadOlder.count() };
if (historyState.initial > 0) {
  await page.screenshot({ path: path.join(root, 'research/browser/load-older.png'), fullPage: false }).catch(() => {});
  await loadOlder.first().click().catch(() => {});
  await page.waitForTimeout(1600);
  historyState.after = await loadOlder.count();
  historyState.limits = await page.evaluate(() => window.__EVENT_LIMITS__ || []);
}
console.log('HISTORY', JSON.stringify(historyState));

// Composer permission chip: current preset from the event log, switch through the host.
const permissionChip = page.locator('[aria-label^="访问模式，当前："]').first();
const permissionState = { present: (await permissionChip.count()) > 0 };
if (permissionState.present) {
  permissionState.label = await permissionChip.innerText();
  await permissionChip.click();
  await page.getByRole('menuitem', { name: '工作区内修改', exact: true }).click();
  await page.waitForTimeout(400);
  permissionState.set = await page.evaluate(() => (window.__PERMISSION_SET__ || []).length);
  permissionState.after = await permissionChip.innerText();
}
console.log('PERMISSION', JSON.stringify(permissionState));

const imageState = await page.evaluate(() => ({
  imgCount: document.querySelectorAll('img[src^="data:image"]').length,
  attachmentCalls: (window.__ATTACHMENT_CALLS__ || []).length,
}));
console.log('IMAGES', JSON.stringify(imageState));
console.log('COMPOSER', JSON.stringify({ editor: editorCount > 0, sendCalls }));

// Official turn-tail branch action must call the remote fork endpoint.
const forkButton = page.locator('button[aria-label]').filter({ has: page.locator('svg') }).filter({ hasNot: page.locator('[data-icon]') });
const labels = await page.evaluate(() => [...document.querySelectorAll('button[aria-label]')].map((node) => node.getAttribute('aria-label')));
const branchLabel = labels.find((label) => label && /分支|branch/i.test(label));
let forkCalls = 0;
if (branchLabel) {
  await page.locator(`button[aria-label="${branchLabel}"]`).first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(700);
  forkCalls = await page.evaluate(() => (window.__FORK_CALLS__ || []).length);
}
console.log('BRANCH', JSON.stringify({ label: branchLabel || null, forkCalls }));

const state = await page.evaluate(() => ({
  ready: window.__HARNESS_READY__ === true,
  official: Boolean(document.querySelector('[data-remote-official]')),
  text: document.body.innerText.slice(0, 4000),
  flowItems: document.querySelectorAll('[data-chat-flow-kind]').length,
  turnProcess: document.querySelectorAll('[data-chat-flow-kind="turn-process"]').length,
  toolCall: document.querySelectorAll('[data-chat-flow-kind="tool-call"]').length,
  officialError: /官方.*失败：/.test(document.body.innerText),
  composerEditor: Boolean(document.querySelector('[data-input-scroll] [contenteditable="true"]')),
}));
console.log('HARNESS', JSON.stringify({ ready: state.ready, official: state.official, flowItems: state.flowItems, turnProcess: state.turnProcess, toolCall: state.toolCall, officialError: state.officialError, composerEditor: state.composerEditor, sendCalls }));
console.log('CONSOLE ERRORS:', consoleErrors.slice(0, 6));
console.log('--- body text ---');
console.log(state.text.slice(0, 2500));

await page.screenshot({ path: path.join(root, 'research/browser/panel.png'), fullPage: false });
console.log('screenshot ->', path.join(root, 'research/browser/panel.png'));
await browser.close();
fs.writeFileSync(path.join(root, 'research/browser/last-run.json'), JSON.stringify({ state, consoleErrors }, null, 2));
assert.ok(state.official && state.flowItems > 0, 'official flow missing');
assert.ok(state.composerEditor, 'official composer missing');
assert.equal(state.officialError, false, 'official renderer reported an error');
assert.deepEqual(consoleErrors.filter(error => !error.startsWith('Each child in a list should have a unique')), []);
