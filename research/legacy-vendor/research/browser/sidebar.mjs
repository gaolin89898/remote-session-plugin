import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'research/browser/out');
const browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_CHROMIUM
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe') });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.__COPIED_SESSION_ID__ = text; },
    } });
  });
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  const project = page.locator('[data-row-key^="workspace:"]').first();
  const rows = page.locator('[data-row-key^="session:"]');
  const row = id => page.locator(`[data-row-key="session:${id}"]`);
  await project.waitFor();
  assert.equal(await rows.count(), 5);
  assert.equal(await row('session-f').count(), 0, 'archived session must stay hidden');
  assert.equal(await project.getAttribute('aria-expanded'), 'true');
  await project.click();
  assert.equal(await rows.count(), 0);
  await project.click();
  await page.getByRole('button', { name: '展开其余 1 个会话', exact: true }).click();
  assert.equal(await rows.count(), 6);
  await page.getByRole('button', { name: '收起', exact: true }).click();
  assert.equal(await rows.count(), 5);

  for (const [id, key] of [['session-official', null], ['session-a', 'Enter'], ['session-b', 'Space']]) {
    if (key) {
      await row(id).focus();
      await row(id).press(key);
    } else await row(id).click();
    await page.waitForFunction(id => document.querySelector(`[data-row-key="session:${id}"]`)
      ?.getAttribute('aria-selected') === 'true', id);
  }

  // Upstream hover card exposes the full title and directory, while its title
  // marquee reveals text clipped in the resting row.
  await row('session-c').hover();
  await page.getByText('C:/work/demo', { exact: true }).waitFor();
  assert.ok(await page.getByText('现在 ai 短剧的剧情都是从哪里来的，以及如何整理素材和分镜', { exact: true }).count() >= 2);
  const title = row('session-c').locator(':scope > span').nth(1);
  assert.ok(await title.evaluate(node => node.scrollWidth > node.clientWidth && node.scrollLeft > 0));
  await page.mouse.move(1000, 20);
  assert.equal(await title.evaluate(node => node.scrollLeft), 0);

  const menu = row('session-a').getByRole('button');
  await row('session-a').hover();
  await menu.click();
  assert.equal(await page.getByRole('menuitem').count(), 2, 'only supported actions should be offered');
  await page.getByRole('menuitem', { name: '复制 Session ID', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__COPIED_SESSION_ID__), 'session-a');
  assert.equal(await row('session-b').getAttribute('aria-selected'), 'true', 'menu action opened its row');

  await row('session-a').hover();
  await menu.click();
  await page.getByRole('menuitem', { name: '分叉会话', exact: true }).click();
  await page.waitForFunction(() => window.__FORK_CALLS__?.length === 1);
  assert.deepEqual(await page.evaluate(() => JSON.parse(window.__FORK_CALLS__[0])), {
    peerId: 'home', sessionId: 'session-a',
  });

  // Fail one real sidebar action and check the panel reports the remote error.
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (input, init) => String(input).endsWith('/fork')
      ? Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false, error: 'sidebar-fork-failed' }) })
      : original(input, init);
  });
  await row('session-a').hover();
  await menu.click();
  await page.getByRole('menuitem', { name: '分叉会话', exact: true }).click();
  await page.getByText(/分支失败/).first().waitFor();

  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByText(/分支失败/).first().waitFor({ state: 'hidden' });
  await row('session-official').click();
  await page.locator('[data-composer-card]').waitFor();
  await page.mouse.move(1000, 20);
  await page.screenshot({ path: path.join(out, 'sidebar-official-desktop.png') });
  await page.evaluate(() => {
    document.querySelector('#root > div > div').style.display = 'none';
    document.body.setAttribute('data-ds-dark-theme', '');
  });
  await page.setViewportSize({ width: 640, height: 900 });
  await page.screenshot({ path: path.join(out, 'sidebar-official-narrow-dark.png') });
  const bounds = await rows.evaluateAll(nodes => nodes.map(node => {
    const { x, width, height } = node.getBoundingClientRect();
    return { x, width, height, right: x + width };
  }));
  assert.ok(bounds.every(rect => rect.x >= 0 && rect.right <= 640 && rect.height === 32));

  await project.hover();
  await project.getByRole('button', { name: '在“demo”中新建会话', exact: true }).click();
  await page.waitForFunction(() => window.__CREATE_CALLS__?.length === 1);
  assert.deepEqual(await page.evaluate(() => JSON.parse(window.__CREATE_CALLS__[0])), {
    peerId: 'home', cwd: 'C:/work/demo',
  });
  assert.equal(await project.getAttribute('aria-expanded'), 'true', 'create action toggled its workspace');

  // Keep offline rows available for cached history, removing remote mutations.
  await page.evaluate(async () => {
    const state = await (await fetch('/remote-session/api/state')).json();
    state.peers[0].online = false;
    const original = window.fetch;
    window.fetch = (input, init) => /\/(state|refresh)$/.test(String(input))
      ? Promise.resolve({ ok: true, json: async () => ({ ...state }) }) : original(input, init);
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByText(/离线 ·/).first().waitFor();
  assert.equal(await rows.count(), 5);
  assert.equal(await project.getByRole('button').count(), 0);
  await row('session-a').hover();
  await menu.click();
  assert.equal(await page.getByRole('menuitem', { name: '分叉会话', exact: true }).count(), 0);
  await page.getByRole('menuitem', { name: '复制 Session ID', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS upstream sidebar rows / disclosure / keyboard / hover / menus / remote errors / offline / responsive layout');
} finally {
  await browser.close();
}
