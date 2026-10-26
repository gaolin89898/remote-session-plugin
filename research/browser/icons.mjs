import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_CHROMIUM
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe') });

async function assertPainted(page, locator) {
  const png = await locator.screenshot();
  const colors = await page.evaluate(async base64 => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + base64;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0);
    const bytes = context.getImageData(0, 0, img.width, img.height).data;
    const colors = new Set();
    for (let i = 0; i < bytes.length; i += 4) colors.add(Array.from(bytes.slice(i, i + 4)).join(','));
    return colors.size;
  }, png.toString('base64'));
  assert.ok(colors > 2, 'icon screenshot is blank');
}

try {
  for (const hostSprite of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    if (hostSprite) await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        if (!document.body) return;
        observer.disconnect();
        const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        sprite.setAttribute('data-dsh-icon-sprite', '');
        sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
        const symbol = document.createElementNS(sprite.namespaceURI, 'symbol');
        symbol.id = 'dsw-icon-like-outline-regular';
        symbol.setAttribute('viewBox', '0 0 16 16');
        symbol.setAttribute('data-host-artwork', 'preserved');
        const path = document.createElementNS(sprite.namespaceURI, 'path');
        path.setAttribute('d', 'M2 2H14V14H2Z');
        path.setAttribute('fill', 'currentColor');
        symbol.appendChild(path);
        sprite.appendChild(symbol);
        document.body.prepend(sprite);
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    await page.goto(pathToFileURL(path.join(root, 'research/browser/out/index.html')).href);
    await page.getByText('官方渲染验证', { exact: true }).first().click();
    await page.locator('[data-composer-card]').waitFor();
    await page.getByText(/这是官方渲染的回复/).first().waitFor();
    const resources = await page.evaluate(() => {
      const symbols = [...document.querySelectorAll('symbol[id^="dsw-icon-"]')];
      const unresolved = [...document.querySelectorAll('use[href^="#dsw-icon-"]')]
        .map(use => use.getAttribute('href').slice(1)).filter(id => !document.getElementById(id));
      return { count: symbols.length, unique: new Set(symbols.map(symbol => symbol.id)).size,
        unresolved, host: document.getElementById('dsw-icon-like-outline-regular')?.getAttribute('data-host-artwork') };
    });
    assert.ok(resources.count > 100);
    assert.equal(resources.count, resources.unique, 'duplicate symbol ids');
    assert.deepEqual(resources.unresolved, []);
    if (hostSprite) assert.equal(resources.host, 'preserved');
    for (const name of ['在远端新建会话', '刷新对话']) {
      await assertPainted(page, page.getByRole('button', { name, exact: true }).locator('svg'));
    }
    await assertPainted(page, page.locator('svg[data-icon="dsw-icon-link-outline-regular"]').first());
    if (!hostSprite) {
      await page.screenshot({ path: path.join(root, 'research/browser/out/icons-desktop.png') });
      await page.evaluate(() => { document.querySelector('#root > div > div').style.display = 'none'; });
      await page.setViewportSize({ width: 640, height: 900 });
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
      await assertPainted(page, page.getByRole('button', { name: '刷新对话', exact: true }).locator('svg'));
      await page.screenshot({ path: path.join(root, 'research/browser/out/icons-narrow-dark.png') });
    }
    assert.deepEqual(errors, []);
    console.log('PASS official icons / resolved references / painted pixels / host artwork:', hostSprite ? 'partial host sprite' : 'no host sprite');
    await page.close();
  }
} finally {
  await browser.close();
}
