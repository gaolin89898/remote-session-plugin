import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createGatewayServer } from '../../gateway/server.mjs';
import { Workbench } from '../../lib/workbench.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const home = await mkdtemp(path.join(os.tmpdir(), 'workbench-browser-'));
const gateway = await createGatewayServer({ id: 'fixture-node', name: 'Fixture', workspaces: [{ id: 'project', name: 'Project', path: home }], agents: { codex: { kind: 'codex', command: process.execPath, args: [path.join(root, 'test/fixtures/agent-process.mjs'), 'codex'], env: { FIXTURE_WORKSPACE: home } } } }, 'browser-fixture-token-'.repeat(3));
const workbench = new Workbench(home);
const bundled = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {AgentWorkbench} from './tools/workbench-client';createRoot(document.getElementById('root')).render(<AgentWorkbench/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
const autoBundled = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {WorkbenchModal} from './tools/workbench-client';const host=new URLSearchParams(location.search).get('host')||undefined;createRoot(document.getElementById('root')).render(<WorkbenchModal close={() => {}} initialHostId={host} />);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<meta charset="utf-8"><div id="root"></div><script src="/client.js"></script>'); return; }
  if (url.pathname === '/client.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundled.outputFiles[0].text); return; }
  if (url.pathname === '/auto.js') { res.setHeader('content-type', 'text/html'); res.end('<meta charset="utf-8"><div id="root"></div><script src="/auto-bundle.js"></script>'); return; }
  if (url.pathname === '/auto-bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(autoBundled.outputFiles[0].text); return; }
  const abort = new AbortController(); res.once('close', () => abort.abort());
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const result = await workbench.route(url.pathname.split('/').at(-1), JSON.parse(raw), abort.signal);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, ...result }));
  } catch (error) { if (!res.destroyed) { res.writeHead(error.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: error.message })); } }
});
let browser;
try {
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_CHROMIUM || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe') });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('button', { name: 'Agent 工作台', exact: true }).click();
  await page.getByRole('button', { name: '添加机器', exact: true }).click();
  await page.getByLabel('机器名称', { exact: true }).fill('Fixture machine');
  await page.getByLabel('网关地址', { exact: true }).fill('http://127.0.0.1:' + gateway.server.address().port);
  await page.getByLabel('网关令牌', { exact: true }).fill('browser-fixture-token-'.repeat(3));
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByLabel('Agent', { exact: true }).waitFor();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('Browser fixture prompt');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('Hello world', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('Second browser prompt');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '拒绝', exact: true }).waitFor();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('textarea').disabled);
  const out = path.join(root, 'research/browser/out'); await mkdir(out, { recursive: true });
  await page.screenshot({ path: path.join(out, 'agent-workbench.png') });
  assert.deepEqual(failures, []);
  await page.getByRole('button', { name: '断开', exact: true }).click();
  await page.getByRole('button', { name: '连接', exact: true }).waitFor();
  const saved = (await workbench.hosts())[0];
  await page.goto('http://127.0.0.1:' + server.address().port + '/auto.js?host=' + saved.id);
  await page.getByLabel('Agent', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('机器', { exact: true }).inputValue(), saved.id);
  assert.deepEqual(failures, []);
  console.log('PASS desktop workbench: saved host → gateway → session → stream → approval → stop → disconnect; menu host opens connected workbench');
} finally {
  await browser?.close(); workbench.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await gateway.close(); await rm(home, { recursive: true, force: true });
}
