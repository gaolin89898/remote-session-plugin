import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_CHROMIUM
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe') });

try {
  for (const scenario of ['flow-load', 'missing-export', 'flow-render', 'assembler-load', 'events-load']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(scenario => {
      window.__FAIL_OFFICIAL__ = true;
      let fetchImpl;
      Object.defineProperty(window, 'fetch', {
        configurable: true,
        set(value) { fetchImpl = value; },
        get() {
          return async (input, init) => {
            const method = String(input?.url || input).split('/').pop().split('?')[0];
            if (window.__FAIL_OFFICIAL__ && (
              scenario === 'flow-load' && method === 'vendor-flow'
              || scenario === 'assembler-load' && method === 'vendor-assembler'
              || scenario === 'events-load' && method === 'events'
            )) return { ok: false, status: 503, json: async () => ({ error: 'fixture unavailable' }) };
            const response = await fetchImpl(input, init);
            if (method === 'vendor-flow' && scenario === 'flow-render') {
              const source = await response.text();
              return { ...response, text: async () => source + `
                var OriginalFlow = module.exports.VendorChatFlow;
                module.exports = Object.assign({}, module.exports, { VendorChatFlow: function FailingFlow(props) {
                  if (window.__FAIL_OFFICIAL__) throw new Error('fixture render failure');
                  return OriginalFlow(props);
                } });` };
            }
            if (method === 'vendor-flow' && scenario === 'missing-export' && window.__FAIL_OFFICIAL__) {
              const source = await response.text();
              return { ...response, text: async () => source + '\nmodule.exports = Object.assign({}, module.exports, { VendorComposer: undefined });' };
            }
            return response;
          };
        },
      });
    }, scenario);
    await page.goto(pathToFileURL(path.join(root, 'research/browser/out/index.html')).href);
    await page.waitForFunction(() => window.__HARNESS_READY__);
    const coldFailure = scenario === 'flow-load' || scenario === 'missing-export';
    if (!coldFailure) await page.getByText('官方渲染验证', { exact: true }).first().click();
    await page.getByText(/官方.*失败：/).first().waitFor().catch(error => {
      throw new Error(scenario + ': ' + error.message);
    });
    assert.equal(await page.locator('[data-chat-flow-kind]').count(), 0);
    assert.equal(await page.getByText('你好，帮我看看这个仓库', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(root, 'research/browser/out', scenario + '.png') });
    await page.evaluate(() => { window.__FAIL_OFFICIAL__ = false; });
    await page.getByRole('button', { name: coldFailure || scenario === 'flow-render' ? '重试' : '刷新对话', exact: true }).first().click();
    if (coldFailure) await page.getByText('官方渲染验证', { exact: true }).first().click();
    await page.locator('[data-remote-official] [data-chat-flow-kind]').first().waitFor({ state: 'attached' });
    await page.getByText(/这是官方渲染的回复/).first().waitFor();
    await page.locator('[data-composer-card]').waitFor();
    await page.waitForFunction(() => !/官方.*失败：/.test(document.body.innerText));
    assert.deepEqual(errors, []);
    console.log('PASS official error / no legacy content / retry:', scenario);
    await page.close();
  }
} finally {
  await browser.close();
}
