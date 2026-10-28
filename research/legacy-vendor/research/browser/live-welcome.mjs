import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = process.cwd();
const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + path.join(root, 'dist/server-known-hosts')];
const portProbe = http.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const tunnel = spawn('ssh', [...sshArgs, '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `127.0.0.1:${port}:127.0.0.1:3080`, '118.196.78.91'], { windowsHide: true, stdio: 'ignore' });
let browser;
try {
  const logs = execFileSync('ssh', [...sshArgs, '118.196.78.91', 'tail -n 160 /root/dsh-cloud.log'], { encoding: 'utf8', windowsHide: true });
  const token = [...logs.matchAll(/https?:\/\/[^\s\x1b]+[?&]token=([^\s\x1b&]+)/g)].at(-1)?.[1];
  for (let i = 0; i < 20; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_CHROMIUM || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe') });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
  await page.getByRole('button', { name: '远程会话', exact: true }).waitFor({ timeout: 60000 });
  console.log('local notice count:', await page.getByText('预览版说明', { exact: true }).count());
  await page.getByRole('button', { name: '远程会话', exact: true }).click();
  await page.getByRole('menuitem', { name: '家里', exact: true }).click();
  await page.waitForFunction(() => window.__DSH_REMOTE_SESSION__?.peerId === 'home', null, { timeout: 60000 });
  await page.locator('[data-row-key^="workspace:"]').first().waitFor({ timeout: 60000 });
  await new Promise(resolve => setTimeout(resolve, 2000));
  await page.screenshot({ path: path.join(root, 'research/browser/out/live-welcome.png') });
  console.log('remote notice count:', await page.getByText('预览版说明', { exact: true }).count());
  console.log('remote save error count:', await page.getByText('暂时无法保存确认状态，请重试。', { exact: true }).count());
  assert.equal(await page.getByText('预览版说明', { exact: true }).count(), 0);
  await page.reload();
  await page.locator('[data-row-key^="workspace:"]').first().waitFor({ timeout: 60000 });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await page.getByText('预览版说明', { exact: true }).count(), 0);
  console.log('PASS home acknowledgement retained after full page reload');
  console.log('browser failures:', failures);
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  tunnel.kill();
}
