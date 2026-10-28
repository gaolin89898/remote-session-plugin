import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
fs.mkdirSync(path.join(root, 'research/browser/out'), { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-machines-'));
const desktop = process.env.DSH_DESKTOP || path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness');
const executable = path.join(desktop, 'DeepSeek Harness.exe');
const cli = path.join(desktop, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const children = [];
const hostHomes = [];
const hostLogs = new Map();
const streams = new Map();
const peers = new Map();
const token = randomUUID();
const restartOnly = process.env.DSH_NATIVE_RESTART_ONLY === '1';
const fixtureName = 'dsh-sync-fixture';
const fixtureDir = path.join(scratch, 'registry/package');
fs.mkdirSync(fixtureDir, { recursive: true });
const fixtureFiles = {
  'package.json': JSON.stringify({ name: fixtureName, version: '1.0.0', type: 'module', main: 'index.js',
    exports: { '.': './index.js', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
    dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  'index.js': 'import fs from "node:fs"; import path from "node:path"; export const name = "sync-fixture"; export function apply() { fs.writeFileSync(path.join(process.env.DSH_HOME, "native-test.pid"), String(process.pid)); fs.writeFileSync(path.join(process.env.DSH_HOME, "native-startup.json"), JSON.stringify({ pid: process.pid, argv: process.argv, execArgv: process.execArgv, cwd: process.cwd(), nodeMode: process.env.ELECTRON_RUN_AS_NODE })); }\nexport const fixtureNonce = ' + JSON.stringify(randomUUID()) + ';\n',
  'cordis.patch.yml': '- insert:\n    - id: sync-fixture\n      name: dsh-sync-fixture\n',
};
for (const [name, value] of Object.entries(fixtureFiles)) fs.writeFileSync(path.join(fixtureDir, name), value);
const fixtureArchive = path.join(scratch, 'registry/plugin.tgz');
assert.equal(spawnSync('tar', ['-czf', fixtureArchive, '-C', path.dirname(fixtureDir), 'package'], { windowsHide: true }).status, 0);
const fixtureTarball = fs.readFileSync(fixtureArchive);
const relay = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/registry/' + fixtureName) {
    const manifest = JSON.parse(fixtureFiles['package.json']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: fixtureName, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { ...manifest,
      dist: { tarball: relayUrl + '/registry/plugin.tgz', integrity: 'sha512-' + createHash('sha512').update(fixtureTarball).digest('base64') } } } }));
    return;
  }
  if (url.pathname === '/registry/plugin.tgz') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); setTimeout(() => res.end(fixtureTarball), 1500); return; }
  if (url.pathname === '/v1/stream') {
    assert.equal(url.searchParams.has('token'), false, 'relay URLs must not contain credentials');
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(403); res.end(); return; }
    const id = url.searchParams.get('id');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    streams.set(id, res);
    res.write('event: ready\ndata: ' + JSON.stringify({ peers: [...peers.values()] }) + '\n\n');
    for (const [other, target] of streams) if (other !== id) target.write('event: peer\ndata: ' + JSON.stringify({ type: 'online', instance: peers.get(id) }) + '\n\n');
    req.on('close', () => { if (streams.get(id) === res) streams.delete(id); });
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const reply = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (body.token !== token) return reply({ ok: false }, 403);
  if (url.pathname === '/v1/register') peers.set(body.id, { id: body.id, name: body.name, online: true, sessions: body.sessions, meta: body.meta });
  if (url.pathname === '/v1/index' && peers.has(body.id)) peers.get(body.id).sessions = body.sessions;
  if (url.pathname === '/v1/publish') {
    const target = streams.get(body.to);
    if (!target) return reply({ ok: false, error: 'offline' }, 409);
    target.write('event: message\ndata: ' + JSON.stringify(body) + '\n\n');
  }
  reply({ ok: true, peers: [...peers.values()] });
});
await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
const relayUrl = 'http://127.0.0.1:' + relay.address().port;
let browser;
let page;

function runCli(home, args) {
  const result = spawnSync(executable, ['--expose-internals', cli, ...args], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  if (result.status !== 0) throw new Error('Fixture CLI failed: ' + (result.stderr || result.stdout).slice(-3500));
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function dismissPreview() {
  const notice = page.getByText('预览版说明', { exact: true });
  if (await notice.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await notice.waitFor({ state: 'hidden' });
  }
}

async function checkEnvironment(peerId, environment, mode = 'Web 端', state = '已连接') {
  const indicator = page.locator('[data-remote-environment="' + peerId + '"]');
  const label = [environment, mode, state].filter(Boolean).join(' · ');
  await page.getByRole('status', { name: label, exact: true }).waitFor();
  const bounds = await indicator.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.y + bounds.height <= page.viewportSize().height);
  assert.ok(await indicator.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'environment must fit sidebar');
  assert.ok((await indicator.innerText()).includes(mode));
  assert.equal(await indicator.locator('.dsh-remote-environment-mode').count(), mode ? 1 : 0);
  if (peerId === 'local') {
    assert.equal(await page.locator('[data-remote-machine-current]').count(), 0, 'local host must not show a machine badge on the entry');
  } else if (await indicator.evaluate(element => !element.classList.contains('dsh-remote-environment-compact'))) {
    const badge = page.getByRole('button', { name: '远程会话', exact: true }).locator('[data-remote-machine-current="' + peerId + '"]');
    await badge.waitFor();
    assert.equal(await badge.getAttribute('title'), label);
    assert.ok((await badge.innerText()).includes(environment.split(' · ').at(-1)));
    assert.ok((await badge.innerText()).includes(mode));
    assert.equal(await badge.locator('.dsh-remote-machine-current-mode').count(), mode ? 1 : 0);
    assert.ok(await badge.evaluate(element => {
      const badgeBox = element.getBoundingClientRect();
      const button = element.closest('button');
      const buttonBox = button.getBoundingClientRect();
      const titleBox = element.previousElementSibling.getBoundingClientRect();
      return badgeBox.right <= buttonBox.right && badgeBox.left >= titleBox.right && button.scrollWidth <= button.clientWidth + 1;
    }), 'machine badge must fit beside the official entry label');
  }
  return indicator;
}

function installSettingsFixture(home, id, plugin, label) {
  const version = id === 'home' ? '1.0.0' : '2.0.0';
  const httpPrefix = plugin === 'dsh-settings-fixture' ? 'dsh-market/' : plugin + '/';
  const source = path.join(scratch, 'fixture-packages', id, plugin);
  const installed = source;
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(home, plugin + '.json'), JSON.stringify({ value: id + '-initial' }));
  fs.writeFileSync(path.join(home, plugin + '-http.json'), JSON.stringify({ value: id + '-http-initial', installed: [id + '-only-plugin'] }));
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({
    name: plugin, version, type: 'module', main: 'index.js',
    exports: { '.': './index.js', './client': './client.js', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', immediately: true } },
  }));
  fs.writeFileSync(path.join(installed, 'cordis.patch.yml'), '- insert:\n    - id: ' + plugin + '\n      name: ' + plugin + '\n');
  fs.writeFileSync(path.join(installed, 'index.js'), `
    import fs from 'node:fs'; import path from 'node:path';
    export const name = ${JSON.stringify(plugin)};
    export const inject = ['connection', 'webServer'];
    export function apply(ctx) {
      const file = path.join(process.env.DSH_HOME, name + '.json');
      ctx.connection.fetch.register({ path: '/api/' + name, methods: ['GET', 'POST'], requestBody: 'buffered',
        async fetch(request) {
          if (request.method === 'POST') fs.writeFileSync(file, JSON.stringify(await request.json()));
          return Response.json(JSON.parse(fs.readFileSync(file, 'utf8')));
        }
      });
      const httpFile = path.join(process.env.DSH_HOME, name + '-http.json');
      ctx.webServer.register({ kind: 'prefix', path: '/' + ${JSON.stringify(httpPrefix.slice(0, -1))}, async handler(req, res) {
        const rejection = ctx.connection.requestRejection(req);
        if (rejection || (req.method === 'POST' && req.headers.origin !== ctx.webServer.getOrigin())) {
          res.writeHead(403); res.end('forbidden'); return;
        }
        const state = JSON.parse(fs.readFileSync(httpFile, 'utf8'));
        if (req.method === 'POST') {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          state.value = JSON.parse(Buffer.concat(chunks)).value;
          fs.writeFileSync(httpFile, JSON.stringify(state));
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state));
      } });
    }
  `);
  fs.writeFileSync(path.join(installed, 'client.js'), `
    window.__ModuleLoader__.load({ id: ${JSON.stringify(plugin)}, factory: require => {
      const React = require('react');
      const name = ${JSON.stringify(plugin)};
      function Settings() {
        const [value, setValue] = React.useState('');
        const [saved, setSaved] = React.useState(false);
        const [httpValue, setHttpValue] = React.useState('');
        const [installed, setInstalled] = React.useState([]);
        const [httpSaved, setHttpSaved] = React.useState(false);
        React.useEffect(() => { fetch('api/' + name).then(r => r.json()).then(r => setValue(r.value)); }, []);
        React.useEffect(() => { fetch(${JSON.stringify(httpPrefix)} + 'installed').then(r => r.json()).then(r => { setHttpValue(r.value); setInstalled(r.installed); }); }, []);
        return React.createElement('section', { 'aria-label': name },
          React.createElement('p', null, 'Client ' + ${JSON.stringify(version)}),
          React.createElement('input', { 'aria-label': name + ' value', value, onChange: e => { setValue(e.target.value); setSaved(false); } }),
          React.createElement('button', { onClick: async () => {
            await fetch('api/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });
            setSaved(true);
          } }, 'Save fixture'), saved && React.createElement('output', null, 'Saved fixture'),
          React.createElement('p', null, 'Installed: ' + installed.join(', ')),
          React.createElement('input', { 'aria-label': name + ' HTTP value', value: httpValue, onChange: e => { setHttpValue(e.target.value); setHttpSaved(false); } }),
          React.createElement('button', { onClick: async () => {
            const response = await fetch(${JSON.stringify(httpPrefix)} + 'settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: httpValue }) });
            if (!response.ok) throw new Error('HTTP fixture save failed: ' + response.status);
            setHttpSaved(true);
          } }, 'Save HTTP fixture'), httpSaved && React.createElement('output', null, 'Saved HTTP fixture'));
      }
      return { name, inject: ['slots'], apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: name, order: 95, label: () => ${JSON.stringify(label)} }, Settings));
      } };
    } });
  `);
  runCli(home, ['plugin', '--profile', 'native-fixture', 'add', 'file:' + source]);
}

async function boot(id) {
  const home = path.join(scratch, id);
  hostHomes.push(home);
  fs.mkdirSync(home, { recursive: true });
  console.log('prepare isolated native host:', id);
  runCli(home, ['--profile', 'native-fixture', '--from-default-profile', 'web', '--dump-default-config']);
  runCli(home, ['plugin', '--profile', 'native-fixture', 'add', 'file:' + root]);
  installSettingsFixture(home, id, 'dsh-settings-fixture', '配置测试');
  if (id === 'company') installSettingsFixture(home, id, 'dsh-remote-ui-fixture', '远端独有插件');
  if (id === 'home' || restartOnly) {
    const manifestPath = path.join(home, 'profiles/native-fixture/package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (id === 'home') manifest.dsh.profile.bundles.push('@deepseek-ai/dsh-experimental-cot-translation-bundle');
    manifest.dsh.profile.bundles.push(fixtureName);
    manifest.dependencies[fixtureName] = '1.0.0';
    const installed = path.join(home, 'profiles/native-fixture/node_modules', fixtureName);
    fs.mkdirSync(installed, { recursive: true });
    for (const [name, value] of Object.entries(fixtureFiles)) fs.writeFileSync(path.join(installed, name), value);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  const overlay = path.join(home, 'native-test.yml');
  fs.writeFileSync(overlay, '- id: remote-session\n  config:\n' + Object.entries({
    relayUrl, token, instanceId: id, instanceName: id === 'home' ? '本机测试' : '远端测试', indexMs: 1000,
  }).map(([key, value]) => '    ' + key + ': ' + JSON.stringify(value)).join('\n')
    + '\n- id: workspace-controller\n  config:\n    documentsDirectory: ' + JSON.stringify(home)
    + '\n- id: plugin-manager\n  config:\n    registry: ' + JSON.stringify(relayUrl + '/registry') + '\n    fallbackRegistries: []\n');
  const port = await unusedPort();
  const proc = spawn(executable, ['--expose-internals', cli, '--profile', 'native-fixture', '--patch', overlay, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: home, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }, windowsHide: true,
  });
  children.push(proc);
  let logs = '';
  hostLogs.set(id, () => logs);
  proc.stdout.on('data', data => { logs += data; });
  proc.stderr.on('data', data => { logs += data; });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error('Native fixture host exited: ' + logs.replace(/([?&]token=)[^\s]+/g, '$1<redacted>').slice(-6000));
    const urls = logs.match(/https?:\/\/127\.0\.0\.1:\d+[^\s\u001b]*/g) || [];
    const authenticated = urls.find(url => url.includes('token='));
    if (authenticated && logs.includes('relay connected as ' + id)) return { home, port, url: authenticated, logs: () => logs };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Native fixture host did not become ready: ' + logs.replace(/([?&]token=)[^\s]+/g, '$1<redacted>').slice(-6000));
}

async function run() {
  const local = await boot('home');
  const remote = await boot('company');
  browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_CHROMIUM
    || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe') });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const welcome = page.getByRole('dialog').filter({ hasText: '开始使用' });
  await page.addLocatorHandler(welcome, async () => {
    await welcome.getByRole('button', { name: '关闭', exact: true }).click();
  });
  const errors = [];
  page.on('pageerror', error => { errors.push(String(error)); console.error(error.stack); });
  await page.goto(local.url);
  if (restartOnly) {
    await page.getByRole('button', { name: '远程会话', exact: true }).waitFor({ timeout: 60000 });
    const call = action => page.evaluate(async action => {
      const response = await fetch('remote-session/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ peerId: 'company' }) });
      return response.json();
    }, action);
    const started = await call('restart');
    console.log('Restart accepted:', started);
    assert.equal(started.ok, true);
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const current = await call('restart/status');
      console.log('Restart status:', current);
      if (current.ok && current.bootId !== started.bootId) { console.log('PASS focused real DSH restart'); return; }
      if (current.state === 'failed') throw new Error(current.error);
    }
    throw new Error('Focused restart timed out');
  }
  assert.ok(await page.evaluate(() => window.__DSH_BOOT__.entries.some(entry => entry.id === '@deepseek-ai/dsh-experimental-client-ui-cot-translation')),
    'local desktop composition must exercise the optional translation plugin');
  await page.getByRole('button', { name: '远程会话', exact: true }).waitFor({ timeout: 60000 });
  // Set the shell marker after Web boot so the fixture keeps its Web carrier.
  await page.evaluate(() => { window.dshDesktopBoot = { ready() {} }; });
  await dismissPreview();
  await checkEnvironment('local', '本机 · 本机测试');
  const footerLayout = await page.locator('[data-remote-environment="local"]').evaluate(indicator => {
    const actions = indicator.closest('div:has(> div > .dsh-remote-environment)');
    if (!actions) throw new Error('sidebar footer action row was not found');
    const widget = document.createElement('div');
    widget.dataset.footerLayoutFixture = 'true';
    widget.style.cssText = 'box-sizing:border-box;flex:none;width:100%;height:180px';
    actions.appendChild(widget);
    const statusBox = indicator.getBoundingClientRect();
    const widgetBox = widget.getBoundingClientRect();
    const result = { direction: getComputedStyle(actions).flexDirection,
      separateRows: widgetBox.top >= statusBox.bottom, status: { top: statusBox.top, bottom: statusBox.bottom },
      widget: { top: widgetBox.top, bottom: widgetBox.bottom }, statusWidth: statusBox.width, widgetWidth: widgetBox.width };
    widget.remove();
    return result;
  });
  assert.equal(footerLayout.direction, 'column', JSON.stringify(footerLayout));
  assert.ok(footerLayout.separateRows && footerLayout.widgetWidth > 0 && footerLayout.statusWidth > 0,
    JSON.stringify(footerLayout));
  console.log('PASS sidebar footer machine status and full-width widgets use separate rows');
  await page.screenshot({ path: path.join(root, 'research/browser/out/environment-local.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  const compact = page.locator('[data-remote-environment="local"].dsh-remote-environment-compact');
  await compact.waitFor();
  assert.equal(await page.locator('[data-remote-machine-current]').count(), 0);
  assert.equal(await compact.getAttribute('title'), '本机 · 本机测试 · Web 端 · 已连接');
  assert.ok((await compact.innerText()).includes('Web 端'));
  await page.screenshot({ path: path.join(root, 'research/browser/out/environment-collapsed.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.getByRole('button', { name: '远程会话', exact: true }).click();
  await page.getByRole('menuitem', { name: '远端测试', exact: true }).waitFor();
  const restartButton = page.getByRole('button', { name: '重启 远端测试', exact: true });
  assert.equal(await restartButton.isEnabled(), true);
  assert.match(await restartButton.getAttribute('title'), /Windows.*Web 端/);
  await restartButton.click();
  const restartDialog = page.getByRole('dialog', { name: '重启 远端测试 上的 DSH？', exact: true });
  await restartDialog.waitFor();
  assert.equal(await page.evaluate(() => window.__DSH_REMOTE_SESSION__.peerId), 'local', 'restart must not switch machines');
  await restartDialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(errors, [], 'cancelling restart must not activate the original sidebar panel');
  await page.getByRole('button', { name: '远程会话', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'research/browser/out/native-machine-menu.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 640, height: 900 });
  const menu = page.getByRole('menu');
  await menu.waitFor();
  assert.ok(await menu.locator('[data-machine-id="company"]').evaluate(row => {
    const buttons = [...row.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    const bounds = row.getBoundingClientRect();
    return buttons[0].right <= buttons[1].left && buttons[1].right <= bounds.right;
  }), 'switching and restart buttons must be separate and fit the menu');
  const rect = await menu.boundingBox();
  assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 640 && rect.y + rect.height <= 900);
  await page.screenshot({ path: path.join(root, 'research/browser/out/native-machine-menu-narrow-dark.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem', { name: '远端测试', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '远程会话', exact: true }).press('Enter');
  await page.getByRole('menuitem', { name: '远端测试', exact: true }).click();
  await page.waitForFunction(() => window.__DSH_REMOTE_SESSION__?.peerId === 'company', null, { timeout: 60000 });
  await page.getByRole('button', { name: '远程会话', exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__DSH_BOOT__.entries.some(entry => entry.id === '@deepseek-ai/dsh-experimental-client-ui-cot-translation')), false);
  await page.evaluate(() => { window.dshDesktopBoot = { ready() {} }; });
  await dismissPreview();
  await checkEnvironment('company', '远程 · 远端测试');
  await page.keyboard.press('Control+Alt+,');
  const remoteSettings = page.getByRole('dialog', { name: '设置', exact: true });
  await remoteSettings.getByRole('button', { name: '配置测试', exact: true }).click();
  const sharedSettings = remoteSettings.getByRole('region', { name: 'dsh-settings-fixture', exact: true });
  await sharedSettings.getByText('Client 2.0.0', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="dsh-settings-fixture value"]')?.value === 'company-initial');
  await sharedSettings.getByLabel('dsh-settings-fixture value', { exact: true }).fill('remote-updated');
  await sharedSettings.getByRole('button', { name: 'Save fixture', exact: true }).click();
  await sharedSettings.getByText('Saved fixture', { exact: true }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(remote.home, 'dsh-settings-fixture.json'), 'utf8')).value, 'remote-updated');
  assert.equal(JSON.parse(fs.readFileSync(path.join(local.home, 'dsh-settings-fixture.json'), 'utf8')).value, 'home-initial');
  await sharedSettings.getByText('Installed: company-only-plugin', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="dsh-settings-fixture HTTP value"]')?.value === 'company-http-initial');
  await sharedSettings.getByLabel('dsh-settings-fixture HTTP value', { exact: true }).fill('remote-http-updated');
  await sharedSettings.getByRole('button', { name: 'Save HTTP fixture', exact: true }).click();
  await sharedSettings.getByText('Saved HTTP fixture', { exact: true }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(remote.home, 'dsh-settings-fixture-http.json'), 'utf8')).value, 'remote-http-updated');
  assert.equal(JSON.parse(fs.readFileSync(path.join(local.home, 'dsh-settings-fixture-http.json'), 'utf8')).value, 'home-http-initial');
  await remoteSettings.getByRole('button', { name: '远端独有插件', exact: true }).click();
  await remoteSettings.getByRole('region', { name: 'dsh-remote-ui-fixture', exact: true }).getByText('Client 2.0.0', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'research/browser/out/remote-plugin-settings.png') });
  await page.keyboard.press('Escape');
  await remoteSettings.waitFor({ state: 'hidden' });
  console.log('PASS target-only plugin UI / target client version / native API and authenticated plugin HTTP reads and persistence / local settings unchanged');
  assert.equal(await page.evaluate(() => typeof window.dshDesktopBoot.ready), 'function');
  await page.screenshot({ path: path.join(root, 'research/browser/out/environment-desktop-to-web.png'), animations: 'disabled' });
  let targetRuntime = 'desktop';
  await page.route('**/remote-session/api/state', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.peers = data.peers.map(peer => peer.id === 'company' ? { ...peer, runtime: targetRuntime, restart: targetRuntime ? peer.restart : null } : peer);
    await route.fulfill({ response, json: data });
  });
  await checkEnvironment('company', '远程 · 远端测试', '客户端');
  targetRuntime = null;
  await checkEnvironment('company', '远程 · 远端测试', '');
  await page.getByRole('button', { name: '远程会话', exact: true }).click();
  assert.equal(await restartButton.isEnabled(), false);
  assert.match(await restartButton.getAttribute('title'), /更新目标机器/);
  await page.keyboard.press('Escape');
  await page.unroute('**/remote-session/api/state');
  await checkEnvironment('company', '远程 · 远端测试');
  await page.setViewportSize({ width: 640, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).waitFor();
  await page.locator('[data-remote-environment="company"].dsh-remote-environment-compact').waitFor();
  await checkEnvironment('company', '远程 · 远端测试');
  await page.screenshot({ path: path.join(root, 'research/browser/out/environment-remote-narrow-dark.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.route('**/remote-session/api/state', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.peers = data.peers.map(peer => ({ ...peer, online: false }));
    await route.fulfill({ response, json: data });
  });
  await checkEnvironment('company', '远程 · 远端测试', 'Web 端', '离线');
  await page.getByRole('button', { name: '远程会话', exact: true }).click();
  assert.equal(await restartButton.isEnabled(), false);
  assert.match(await restartButton.getAttribute('title'), /离线/);
  await page.keyboard.press('Escape');
  await page.unroute('**/remote-session/api/state');
  await checkEnvironment('company', '远程 · 远端测试');
  await page.locator('[data-row-key^="workspace:"]').first().waitFor({ timeout: 60000 });
  assert.equal(await page.locator('[data-remote-official]').count(), 0, 'plugin conversation should not be mounted');
  assert.equal(await page.getByText('主机 ·', { exact: false }).count(), 0, 'plugin workspace should not be mounted');
  await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 30000 });
  await page.screenshot({ path: path.join(root, 'research/browser/out/native-remote-workspace.png') });
  console.log('PASS actual DSH native workspace and conversation mounted over relay');

  // Mutate a fixture Workspace through the native typed HTTP channel, then
  // observe the official sidebar updating through its native follow stream.
  const result = await page.evaluate(async remotePath => {
    const response = await window.__DSH_TRANSPORT__.fetch('api/workspace/create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/create', payload: { args: { request: { path: remotePath } } } }),
    });
    return response.json();
  }, remote.home);
  assert.equal(result.result.ok, true, JSON.stringify(result));
  await page.getByText('company', { exact: true }).first().waitFor({ timeout: 30000 });
  console.log('PASS native Workspace mutation and live sidebar update target the remote host');

  const session = await page.evaluate(async workspaceId => {
    const call = async (method, request) => {
      const response = await fetch('api/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }),
      });
      const data = await response.json();
      if (!data.result.ok) throw new Error(JSON.stringify(data));
      return data.result.value;
    };
    const value = await call('session/create', { workspaceId });
    await call('session/rename', { sessionId: value.sessionId, title: '远端原生会话测试' });
    const upload = await window.__DSH_FILE_UPLOAD__.fetch('api/session/uploadFileBinary?' + new URLSearchParams({ sessionId: value.sessionId, name: 'fixture.txt' }), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob(['native remote upload']),
    });
    const receipt = await upload.json();
    if (!receipt.ok) throw new Error(JSON.stringify(receipt));
    return value;
  }, result.result.value.workspace.workspaceId);
  // Native lists hide unselected blank sessions. Open the workspace using its
  // own New Session command, which selects the native provisional row.
  const workspaceRow = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'company' }).first();
  await workspaceRow.waitFor();
  await workspaceRow.hover();
  await workspaceRow.getByRole('button').last().click();
  await page.getByText('company', { exact: true }).nth(1).waitFor({ timeout: 30000 });
  await page.locator('[contenteditable="true"]').first().waitFor();
  await page.screenshot({ path: path.join(root, 'research/browser/out/native-remote-workspace.png') });
  console.log('PASS native session creation, rename, workspace conversation opening and binary upload target the remote host');

  await page.getByRole('button', { name: '远程会话', exact: true }).click();
  await page.getByRole('menuitem', { name: /本机 · 本机测试/ }).click();
  await page.waitForFunction(() => window.__DSH_REMOTE_SESSION__?.peerId === 'local', null, { timeout: 60000 });
  await page.getByRole('button', { name: '远程会话', exact: true }).waitFor({ timeout: 60000 });
  assert.ok(await page.evaluate(() => window.__DSH_BOOT__.entries.some(entry => entry.id === '@deepseek-ai/dsh-experimental-client-ui-cot-translation')));
  await dismissPreview();
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: '关闭', exact: true }).click();
  await page.keyboard.press('Control+Alt+,');
  const localSettings = page.getByRole('dialog', { name: '设置', exact: true });
  await localSettings.getByRole('button', { name: '配置测试', exact: true }).click();
  await localSettings.getByText('Client 1.0.0', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="dsh-settings-fixture value"]')?.value === 'home-initial');
  await localSettings.getByText('Installed: home-only-plugin', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="dsh-settings-fixture HTTP value"]')?.value === 'home-http-initial');
  assert.equal(await localSettings.getByRole('button', { name: '远端独有插件', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await localSettings.waitFor({ state: 'hidden' });
  console.log('PASS switch back restores local plugin version and settings, and removes target-only plugin UI');
  await page.evaluate(() => { window.dshDesktopBoot = { ready() {} }; });
  await dismissPreview();
  await checkEnvironment('local', '本机 · 本机测试');
  await page.route('**/remote-session/api/state', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.self.runtime = 'desktop';
    await route.fulfill({ response, json: data });
  });
  await checkEnvironment('local', '本机 · 本机测试', '客户端');
  await page.unroute('**/remote-session/api/state');
  await checkEnvironment('local', '本机 · 本机测试');
  console.log('PASS persistent environment / host switching / target runtime despite desktop bridge / collapsed sidebar / offline state');
  await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 30000 });
  assert.equal(await page.getByText('company', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => !!window.__DSH_TRANSPORT__?.openStream), false);
  await page.screenshot({ path: path.join(root, 'research/browser/out/native-local-workspace.png') });
  assert.deepEqual(errors, []);
  console.log('PASS switch back to local / original native carrier / no browser errors');

  let settingsFailure = { status: 401, contentType: 'text/plain', body: '' };
  await page.route('**/remote-session/api/settings', route => route.fulfill(settingsFailure));
  await page.keyboard.press('Control+Alt+,');
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.waitFor();
  await settings.getByRole('button', { name: '远程会话', exact: true }).click();
  const connection = page.locator('[aria-label="远程会话设置"]');
  await connection.getByText(/未通过认证/).waitFor();
  assert.equal(await connection.getByLabel('实例 ID', { exact: true }).isEnabled(), false);
  assert.equal(await connection.getByRole('button', { name: '保存并重连', exact: true }).isEnabled(), false);
  settingsFailure = { status: 200, contentType: 'application/json', body: '' };
  await connection.getByRole('button', { name: '重新读取配置', exact: true }).click();
  await connection.getByText(/接口返回空响应/).waitFor();
  settingsFailure = { status: 200, contentType: 'text/html', body: '<html><body>login</body></html>' };
  await connection.getByRole('button', { name: '重新读取配置', exact: true }).click();
  await connection.getByText(/接口返回了登录页/).waitFor();
  assert.equal(await connection.getByRole('button', { name: '保存并重连', exact: true }).isEnabled(), false);
  await page.screenshot({ path: path.join(root, 'research/browser/out/settings-read-failure.png') });
  await page.unroute('**/remote-session/api/settings');
  await connection.getByRole('button', { name: '重新读取配置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="实例 ID"]')?.value === 'home');
  assert.equal(await connection.getByLabel('实例名称', { exact: true }).inputValue(), '本机测试');
  assert.equal(await connection.getByRole('button', { name: '保存并重连', exact: true }).isEnabled(), true);
  console.log('PASS settings authentication / empty and HTML response errors / disabled save before successful read / retry recovery');
  const syncPanel = page.getByRole('region', { name: '插件同步', exact: true });
  await syncPanel.getByLabel('同步目标机器').selectOption('company');
  await syncPanel.getByRole('button', { name: '比较插件', exact: true }).click();
  const translationBundle = '@deepseek-ai/dsh-experimental-cot-translation-bundle';
  const translationRow = syncPanel.locator('[data-plugin-sync-name]').filter({ has: page.getByLabel(translationBundle, { exact: true }) });
  await translationRow.waitFor();
  await syncPanel.getByLabel('全选可同步插件', { exact: true }).uncheck();
  await translationRow.getByRole('checkbox').check();
  const installRow = syncPanel.locator('[data-plugin-sync-name="dsh-sync-fixture"]');
  await installRow.getByRole('checkbox').check();
  await page.screenshot({ path: path.join(root, 'research/browser/out/plugin-sync-preview.png') });
  await syncPanel.getByRole('button', { name: /同步到远端测试/ }).click();
  await syncPanel.getByRole('button', { name: '取消同步', exact: true }).waitFor();
  await settings.getByRole('button', { name: '通用设置', exact: true }).click();
  await settings.getByRole('button', { name: '远程会话', exact: true }).click();
  await syncPanel.locator('.dsh-sync-job-info').filter({ hasText: /插件同步完成|部分插件同步失败|同步已取消/ }).waitFor({ timeout: 120000 });
  assert.ok(await syncPanel.getByText('插件同步完成', { exact: true }).isVisible(), await syncPanel.innerText());
  assert.ok((await translationRow.innerText()).includes('已完成'));
  assert.ok((await installRow.innerText()).includes('已完成'));
  assert.ok((await installRow.innerText()).includes('目标 1.0.0 · 启用'));
  const remoteManifest = JSON.parse(fs.readFileSync(path.join(remote.home, 'profiles/native-fixture/package.json'), 'utf8'));
  assert.equal(remoteManifest.dependencies[fixtureName], '1.0.0');
  assert.ok(remoteManifest.dsh.profile.bundles.includes(fixtureName));
  const refreshed = await page.evaluate(async () => {
    const response = await fetch('remote-session/api/native', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'company', clientId: crypto.randomUUID(), operation: 'probe' }) });
    return response.json();
  });
  assert.ok(refreshed.result.clientEntries.includes('@deepseek-ai/dsh-experimental-client-ui-cot-translation'));
  await page.screenshot({ path: path.join(root, 'research/browser/out/plugin-sync-complete.png') });
  await page.setViewportSize({ width: 640, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.ok(await syncPanel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'plugin sync must fit narrow settings');
  await page.screenshot({ path: path.join(root, 'research/browser/out/plugin-sync-narrow-dark.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '远程会话', exact: true }).click();
  await page.getByRole('menuitem', { name: '远端测试', exact: true }).click();
  await page.getByRole('button', { name: '远程会话', exact: true }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => window.__DSH_REMOTE_SESSION__?.peerId === 'company' && window.__DSH_BOOT__.entries.some(entry => entry.id === '@deepseek-ai/dsh-experimental-client-ui-cot-translation'));
  assert.deepEqual(errors, []);
  console.log('PASS Settings plugin comparison / selected native bundle activation / remote composition after sync / narrow layout');
  const beforeRestartPid = fs.readFileSync(path.join(remote.home, 'native-test.pid'), 'utf8');
  await page.getByRole('button', { name: '远程会话', exact: true }).click();
  await page.getByRole('button', { name: '重启 远端测试', exact: true }).click();
  const restarted = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame(), timeout: 90000 });
  await restartDialog.getByRole('button', { name: '重启', exact: true }).click();
  await restarted;
  await page.getByRole('button', { name: '远程会话', exact: true }).waitFor({ timeout: 60000 });
  await dismissPreview();
  await checkEnvironment('company', '远程 · 远端测试');
  assert.notEqual(fs.readFileSync(path.join(remote.home, 'native-test.pid'), 'utf8'), beforeRestartPid);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, 'research/browser/out/native-after-restart.png'), animations: 'disabled' });
  console.log('PASS remote restart confirmation / original Web startup arguments / new process / automatic reconnection');
}
try {
  await run();
} catch (error) {
  console.error((await page?.getByRole('region', { name: '插件同步', exact: true }).innerText().catch(() => '')) || '');
  for (const [id, logs] of hostLogs) console.error(id + ': ' + logs().replaceAll(token, '<redacted>').replace(/([?&]token=)[^\s]+/g, '$1<redacted>').slice(-6000));
  await page?.screenshot({ path: path.join(root, 'research/browser/out/native-failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const child of children) {
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
  for (const home of hostHomes) {
    try {
      const pid = Number(fs.readFileSync(path.join(home, 'native-test.pid'), 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* fixture was not installed */ }
  }
  for (const stream of streams.values()) stream.end();
  relay.closeAllConnections();
  await new Promise(resolve => relay.close(resolve));
}
