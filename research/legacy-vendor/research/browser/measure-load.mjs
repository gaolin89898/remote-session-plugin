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
await page.goto(pageFile, { waitUntil: 'load' });
await page.waitForFunction(() => window.__HARNESS_READY__ === true, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2000);
const started = Date.now();
await page.getByText('官方渲染验证').first().click().catch(() => {});
await page.waitForSelector('[data-remote-official]', { timeout: 15000 }).catch(() => {});
console.log(JSON.stringify({ firstOfficialPaintMs: Date.now() - started }));
await browser.close();
