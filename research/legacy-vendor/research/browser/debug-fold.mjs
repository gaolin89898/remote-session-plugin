import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'research/browser/out');
const pageFile = 'file:///' + path.join(outDir, 'index.html').replaceAll('\\', '/');
const executablePath = process.env.DSH_CHROMIUM
  || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const logs = [];
page.on('console', (m) => { if (String(m.text()).startsWith('[dbg]')) logs.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(pageFile, { waitUntil: 'load' });
await page.waitForFunction(() => window.__HARNESS_READY__ === true, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(3000);
await page.getByText('官方渲染验证').first().click().catch(() => {});
for (let i = 0; i < 4; i += 1) {
  await page.getByText('官方渲染验证').first().click().catch(() => {});
  await page.waitForTimeout(1200);
}
await page.waitForTimeout(5000);
const dbg = await page.evaluate(() => ({
  folds: window.__DBG_FOLD__ || [], loads: window.__DBG_LOAD__ || 0, sel: window.__DBG_SEL__ || null,
  official: window.__HARNESS_STATE__ ? window.__HARNESS_STATE__.official : undefined,
}));
console.log(JSON.stringify(dbg, null, 2));
console.log('logs', logs.slice(0, 12));
console.log('errors', errors.slice(0, 3));
await browser.close();
