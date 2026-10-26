import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_CHROMIUM
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe') });
const errors = [];
const count = (page, key) => page.evaluate(key => (window[key] || []).length, key);
const wait = (page, predicate) => page.waitForFunction(predicate, undefined, { timeout: 5000 });

async function open(running = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(pathToFileURL(path.join(root, 'research/browser/out/index.html')).href);
  await wait(page, () => window.__HARNESS_READY__);
  await page.evaluate(running => {
    const fetch = window.fetch;
    window.__TEST_FAILURES__ = {};
    window.__CANCEL_CALLS__ = [];
    window.fetch = async (input, init) => {
      const method = String(input?.url || input).split('/').pop().split('?')[0];
      if (method === 'cancel') window.__CANCEL_CALLS__.push(JSON.parse(init.body));
      const response = await fetch(input, init);
      const failure = window.__TEST_FAILURES__[method];
      if (failure) {
        delete window.__TEST_FAILURES__[method];
        return { ok: true, status: 200, json: async () => method === 'models'
          ? { ok: false, error: failure }
          : { ok: true, result: { ok: false, error: { code: 'fixture/rejected', message: failure } } } };
      }
      if (running && method === 'events') {
        const body = await response.json();
        if (!JSON.parse(init.body).afterSeq) body.events.push(
          { seq: 100, time: Date.now(), type: 'turn/start', data: { turn: 3 }, surfaceOp: 'append' },
          { seq: 101, time: Date.now(), type: 'user/message', data: { content: [{ type: 'text', text: '运行中验证' }], source: { kind: 'user' } }, surfaceOp: 'append' });
        return { ok: true, status: 200, json: async () => ({ ...body, session: { ...body.session, running: true }, cursor: 101 }) };
      }
      return response;
    };
  }, running);
  await page.getByText('官方渲染验证', { exact: true }).first().click();
  await page.locator('[data-composer-card]').waitFor();
  await page.locator('[aria-label^="选择模型，当前"]').waitFor();
  await page.getByRole('button', { name: running ? '停止生成' : '发送消息', exact: true }).waitFor();
  return page;
}

const editorFor = page => page.locator('[data-input-scroll] [contenteditable="true"]').first();
async function clear(page) {
  await editorFor(page).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
}
const modelFor = page => page.locator('[aria-label^="选择模型，当前"]');
const permissionFor = page => page.locator('[aria-label^="访问模式，当前："]');

try {
  const page = await open();
  const editor = editorFor(page);
  assert.equal(await page.locator('[data-composer-card]').count(), 1);
  assert.equal(await page.locator('[data-remote-composer] textarea').count(), 0);
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);

  // Official plus menu, keyboard highlight/pick, command arguments and dismissal.
  const plus = page.getByRole('button', { name: '添加文件或调用指令' });
  await plus.click();
  await page.locator('[data-trigger-menu] [role="option"]').first().waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  assert.match(await editor.innerText(), /feedback/);
  await page.keyboard.type(' hello official composer');
  await page.keyboard.press('Enter');
  await wait(page, () => window.__COMMAND_CALLS__?.length === 1);
  assert.equal(JSON.parse((await page.evaluate(() => window.__COMMAND_CALLS__))[0]).line, '/feedback hello official composer');
  await plus.click();
  await page.locator('[data-trigger-menu]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-trigger-menu]').count(), 0);
  await plus.click();
  await page.locator('[data-trigger-menu]').waitFor();
  await plus.click();
  assert.equal(await page.locator('[data-trigger-menu]').count(), 0);
  console.log('PASS plus / command / keyboard / dismissal');

  await clear(page);
  await page.keyboard.type('@src');
  await page.locator('[data-trigger-menu] [role="option"]').first().waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.match(await editor.innerText(), /app.tsx/);
  await page.keyboard.press('Enter');
  await wait(page, () => window.__SEND_CALLS__?.length === 1);
  assert.match(JSON.parse((await page.evaluate(() => window.__SEND_CALLS__))[0]).text, /@src\/app.tsx/);

  await clear(page);
  await page.keyboard.type('first');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second');
  assert.equal(await count(page, '__SEND_CALLS__'), 1);
  assert.match(await editor.innerText(), /first\nsecond/);
  // The official keymap owns paste and ignores IME candidate-selection Enter.
  await editor.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '\npasted');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  });
  assert.equal(await count(page, '__SEND_CALLS__'), 1);
  await page.evaluate(() => { window.__TEST_FAILURES__.send = 'send rejected'; });
  await page.keyboard.press('Enter');
  await wait(page, () => window.__SEND_CALLS__?.length === 2);
  await page.getByText(/发送失败.*send rejected/).waitFor();
  assert.match(await editor.innerText(), /first\nsecond\npasted/);
  await editor.click();
  await page.keyboard.press('Enter');
  await wait(page, () => window.__SEND_CALLS__?.length === 3);
  await wait(page, () => document.querySelector('[data-input-scroll] [contenteditable]').innerText.trim() === '');
  console.log('PASS mentions / multiline / paste / IME / rejected-send draft');

  // Actual official model root, model/provider search and reasoning-level pane.
  await modelFor(page).click();
  await page.getByRole('menuitem', { name: /^推理等级/ }).click();
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click();
  await wait(page, () => window.__SELECT_MODEL_CALLS__?.length === 1);
  await wait(page, () => document.querySelector('[aria-label^="选择模型，当前"]').textContent.includes('Low'));
  let selection = JSON.parse((await page.evaluate(() => window.__SELECT_MODEL_CALLS__))[0]);
  assert.equal(selection.provider, 'deepseek-account');
  assert.equal(selection.model, 'deepseek-v4-pro');
  assert.equal(selection.reasoningEffort, 'low');
  assert.equal(selection.selection, undefined);
  await modelFor(page).click();
  await page.getByRole('menuitem', { name: /^模型/ }).click();
  const search = page.getByRole('searchbox', { name: '搜索模型…' });
  assert.equal(await page.getByRole('menuitemradio').count(), 5);
  await page.getByText('Custom Provider', { exact: true }).waitFor();
  await search.fill('deepseek');
  assert.equal(await page.getByRole('menuitemradio').count(), 2);
  await search.fill('no-model-match');
  await page.getByText('没有匹配的模型。', { exact: true }).waitFor();
  await search.fill('flash');
  await page.getByRole('menuitemradio', { name: 'DeepSeek-V4.1-Flash' }).click();
  await wait(page, () => window.__SELECT_MODEL_CALLS__?.length === 2);
  await wait(page, () => document.querySelector('[aria-label^="选择模型，当前"]').textContent.includes('Flash'));
  await page.evaluate(() => { window.__TEST_FAILURES__['select-model'] = 'model rejected'; });
  await modelFor(page).click();
  await page.getByRole('menuitem', { name: /^模型/ }).click();
  await page.getByRole('menuitemradio', { name: 'Alpha', exact: true }).click();
  await page.getByText(/切换模型失败.*model rejected/).waitFor();
  assert.match(await modelFor(page).innerText(), /Flash/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__TEST_FAILURES__.models = 'catalog rejected'; });
  await modelFor(page).click();
  await page.getByRole('menuitem', { name: /^模型/ }).click();
  await page.getByText('模型操作失败：catalog rejected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'retry', exact: true }).click();
  await page.getByText('模型操作失败：catalog rejected', { exact: true }).waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  console.log('PASS model / effort / provider search / failed-select / catalog retry');

  await permissionFor(page).click();
  await page.getByRole('menuitem', { name: '工作区内修改', exact: true }).click();
  await wait(page, () => window.__PERMISSION_SET__?.length === 1);
  await wait(page, () => document.querySelector('[aria-label^="访问模式，当前："]').textContent.includes('工作区内修改'));
  await page.evaluate(() => { window.__TEST_FAILURES__['permission-set'] = 'permission rejected'; });
  await permissionFor(page).click();
  await page.getByRole('menuitem', { name: '仅可查看', exact: true }).click();
  await page.getByText('切换权限失败', { exact: true }).waitFor();
  assert.match(await permissionFor(page).innerText(), /工作区内修改/);
  await permissionFor(page).click();
  await page.getByRole('menuitem', { name: '完全权限', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await count(page, '__PERMISSION_SET__'), 2);
  assert.equal(await dialog.getByRole('button', { name: '启用完全权限', exact: true }).isDisabled(), true);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '启用完全权限', exact: true }).click();
  await wait(page, () => window.__PERMISSION_SET__?.length === 3);
  await wait(page, () => document.querySelector('[aria-label^="访问模式，当前："]').textContent.includes('完全权限'));
  assert.equal(JSON.parse((await page.evaluate(() => window.__PERMISSION_SET__))[2]).preset, 'danger-full-access');
  console.log('PASS permission switch / rejected-switch / official risk confirmation');

  await clear(page);
  await page.screenshot({ path: path.join(root, 'research/browser/out/composer-desktop.png') });
  await modelFor(page).click();
  await page.screenshot({ path: path.join(root, 'research/browser/out/composer-model.png') });
  await page.keyboard.press('Escape');
  // Emulate the existing shell hiding its navigation rails on a narrow screen.
  await page.evaluate(() => {
    document.querySelector('#root > div > div').style.display = 'none';
    const rail = document.querySelector('[role="tree"]');
    if (rail) rail.parentElement.style.display = 'none';
  });
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
  await page.screenshot({ path: path.join(root, 'research/browser/out/composer-narrow-dark.png') });
  const bounds = await page.locator('[data-composer-card]').boundingBox();
  assert.ok(bounds.width > 200 && bounds.x >= 0 && bounds.x + bounds.width <= 641, JSON.stringify(bounds));
  console.log('PASS narrow layout; desktop / menu / dark screenshots saved');
  await page.close();

  const busy = await open(true);
  await busy.getByRole('button', { name: '停止生成', exact: true }).click();
  assert.equal(await count(busy, '__CANCEL_CALLS__'), 1);
  await editorFor(busy).click();
  await busy.keyboard.type('steer while running');
  await busy.keyboard.press('Enter');
  await wait(busy, () => window.__SEND_CALLS__?.length === 1);
  await wait(busy, () => document.querySelector('[data-input-scroll] [contenteditable]').innerText.trim() === '');
  await editorFor(busy).click();
  await busy.keyboard.type('queue while running');
  await busy.keyboard.press('Control+Enter');
  await wait(busy, () => window.__SEND_CALLS__?.length === 2);
  const modes = (await busy.evaluate(() => window.__SEND_CALLS__)).map(body => JSON.parse(body).mode);
  assert.deepEqual(modes, ['steer', 'queue']);
  await busy.close();
  assert.deepEqual(errors, []);
  console.log('PASS running Stop / Enter steer / Ctrl+Enter queue; no browser errors');
} finally {
  await browser.close();
}
