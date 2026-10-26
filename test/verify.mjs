#!/usr/bin/env node
/**
 * verify.mjs — end-to-end check of the two test instances of dsh-remote-session.
 *
 * For each instance (A on 3111, B on 3112) it:
 *   1. finds the instance token URL in test/logs/<profile>.log
 *      (printed as `dsh web: http://127.0.0.1:PORT/?token=...`);
 *   2. exchanges ?token= for the dsh-auth cookie (dynamic cookie name);
 *   3. fetches `/` and checks the shell HTML contains window.__DSH_BOOT__;
 *   4. finds the /plugins/??… combo URL that carries `<plugin>/client.js`
 *      (i.e. the plugin really is in the client boot graph) and downloads that
 *      combo, asserting it is served and registers the module id;
 *   5. calls the plugin host route (default POST /remote-session/api/state)
 *      with the cookie + Origin headers and prints the JSON it answers;
 *   6. counts the session directories under each DSH_HOME.
 *
 * Options:
 *   --spawn                 start both instances (own DSH_HOME) if not running,
 *                           and stop them afterwards unless --keep
 *   --keep                  keep instances started by --spawn
 *   --plugin <name>         client module id / host plugin name (dsh-remote-session)
 *   --state-path <path>     host route to probe (/remote-session/api/state)
 *   --state-method <verb>   POST | GET | ... (POST)
 *   --state-body <json>     request body ({"action":"state"})
 *   --a-profile/--b-profile, --a-home/--b-home, --a-port/--b-port
 *   --logs <dir>            default <test>/logs
 *   --timeout <ms>          boot wait for --spawn (90000)
 *   --min-sessions <n>      expected copied sessions per HOME (2)
 *   --cli <path>            dsh CLI bin.js (else $DSH_CLI, else npx cache probe)
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const arg = parseArgs(process.argv.slice(2));

const PLUGIN = arg.plugin ?? 'dsh-remote-session';
const STATE_PATH = arg['state-path'] ?? '/remote-session/api/state';
const STATE_METHOD = (arg['state-method'] ?? 'POST').toUpperCase();
const STATE_BODY = arg['state-body'] ?? '{"action":"state"}';
const LOGS = arg.logs ? resolve(arg.logs) : join(HERE, 'logs');
const TIMEOUT = Number(arg.timeout ?? 90000);
const MIN_SESSIONS = Number(arg['min-sessions'] ?? 2);
const SPAWN = arg.spawn === true;
const KEEP = arg.keep === true;

const instances = [
  {
    side: 'A',
    profile: arg['a-profile'] ?? 'remote-a',
    home: arg['a-home'] ?? join(HOME, '.dsh-remote-a'),
    port: Number(arg['a-port'] ?? 3111),
  },
  {
    side: 'B',
    profile: arg['b-profile'] ?? 'remote-b',
    home: arg['b-home'] ?? join(HOME, '.dsh-remote-b'),
    port: Number(arg['b-port'] ?? 3112),
  },
];

// ---------------------------------------------------------------- helpers
const results = [];
function check(inst, name, ok, detail = '') {
  results.push({ side: inst?.side ?? '-', name, ok, detail });
  const tag = ok ? '[PASS]' : '[FAIL]';
  console.log(`${tag} ${inst ? inst.side + ' ' : ''}${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
function info(msg) { console.log(`[info] ${msg}`); }
function warn(msg) { console.log(`[warn] ${msg}`); }

function findCli() {
  if (arg.cli && existsSync(arg.cli)) return resolve(arg.cli);
  if (process.env.DSH_CLI && existsSync(process.env.DSH_CLI)) return resolve(process.env.DSH_CLI);
  const candidates = [];
  const npxRoot = join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'npm-cache', '_npx');
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      const p = join(npxRoot, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (existsSync(p)) candidates.push(p);
    }
  }
  const globalNpm = join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (existsSync(globalNpm)) candidates.push(globalNpm);
  if (candidates.length === 0) throw new Error('dsh CLI not found; pass --cli <...\\@deepseek-ai\\dsh\\lib\\bin.js>');
  candidates.sort();
  return candidates[candidates.length - 1];
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (v) => { socket.destroy(); done(v); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(500);
  }
  return false;
}

function lastTokenFromLog(logPath) {
  if (!existsSync(logPath)) return undefined;
  const text = readFileSync(logPath, 'utf8');
  const matches = [...text.matchAll(/dsh web: (https?:\/\/[^\s]+)/g)];
  if (matches.length === 0) return undefined;
  const raw = matches[matches.length - 1][1];
  const url = new URL(raw);
  return { url: `${url.protocol}//${url.host}/`, token: url.searchParams.get('token') ?? '', raw, logPath };
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
async function openShell(baseUrl, token) {
  const jar = new Map();
  let url = new URL('?', baseUrl);
  if (token) url.searchParams.set('token', token);
  let res;
  for (let hop = 0; hop < 6; hop++) {
    res = await fetch(url, { redirect: 'manual', headers: { cookie: cookieHeader(jar) } });
    for (const setCookie of res.headers.getSetCookie?.() ?? []) {
      const pair = setCookie.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) { url = new URL(location, url); continue; }
    break;
  }
  const html = res.status === 200 ? await res.text() : '';
  return { jar, res, html, baseUrl };
}
function extractCombo(html, plugin) {
  const raw = [...html.matchAll(/plugins\/\?\?[^"'\s<>\\]+/g)].map((m) => m[0].replaceAll('&amp;', '&'));
  return raw.find((u) => u.includes(`${plugin}/client.js`));
}
async function probeState(inst, shell) {
  const headers = {
    cookie: cookieHeader(shell.jar),
    origin: shell.baseUrl.replace(/\/$/, ''),
    referer: shell.baseUrl,
    'content-type': 'application/json',
  };
  const init = { method: STATE_METHOD, headers, redirect: 'manual' };
  if (STATE_METHOD !== 'GET' && STATE_METHOD !== 'HEAD') init.body = STATE_BODY;
  const res = await fetch(new URL(STATE_PATH.replace(/^\//, ''), shell.baseUrl), init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  const looksJson = /application\/json/.test(res.headers.get('content-type') ?? '');
  const routeExists = res.status !== 404 && res.status < 500 && (looksJson || json !== undefined);
  return { res, json, text, routeExists };
}
function countSessions(home) {
  const root = join(home, 'sessions');
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const slug of readdirSync(root, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    n += readdirSync(join(root, slug.name), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('session-')).length;
  }
  return n;
}

async function startInstance(inst, cli) {
  if (await portOpen(inst.port)) return { spawned: false };
  if (!SPAWN) throw new Error(`port ${inst.port} is closed — start test\\run-${inst.side.toLowerCase()}.cmd or pass --spawn`);
  if (!existsSync(inst.home)) throw new Error(`DSH_HOME ${inst.home} does not exist — run test\\setup.ps1 first`);
  mkdirSync(LOGS, { recursive: true });
  const logPath = join(LOGS, `${inst.profile}.log`);
  const out = createWriteStream(logPath);
  info(`${inst.side}: spawning node ${cli} --profile ${inst.profile} --port ${inst.port} (DSH_HOME=${inst.home})`);
  const child = spawn(process.execPath, [cli, '--profile', inst.profile, '--port', String(inst.port), '--host', '127.0.0.1', '--no-open'], {
    env: { ...process.env, DSH_HOME: inst.home },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.on('exit', (code) => { if (code !== 0 && code !== null) warn(`${inst.side}: instance exited with ${code} (see ${logPath})`); });
  const up = await waitPort(inst.port, TIMEOUT);
  if (!up) throw new Error(`instance ${inst.side} did not open port ${inst.port} within ${TIMEOUT}ms (see ${logPath})`);
  return { spawned: true, child, out, logPath };
}

async function verifyInstance(inst, cli) {
  console.log(`\n=== instance ${inst.side} : profile ${inst.profile} · port ${inst.port} ===`);
  const start = await startInstance(inst, cli);
  inst.spawned = start.spawned;
  inst.child = start.child;
  inst.logPath = start.logPath ?? join(LOGS, `${inst.profile}.log`);
  try {
    check(inst, `port ${inst.port} listening`, true);
    const sessions = countSessions(inst.home);
    check(inst, `copied sessions in ${inst.home}`, sessions >= MIN_SESSIONS, `${sessions} session dir(s), expected >= ${MIN_SESSIONS}`);

    const tokenInfo = lastTokenFromLog(inst.logPath);
    if (!tokenInfo) {
      check(inst, 'token URL found in log', false, `no "dsh web: http://..." line in ${inst.logPath} — restart the instance`);
      return;
    }
    check(inst, 'token URL found in log', true, tokenInfo.raw.replace(/token=.*/, 'token=***'));

    const shell = await openShell(tokenInfo.url, tokenInfo.token);
    check(inst, 'GET / (shell HTML)', shell.res.status === 200 && shell.html.length > 1000, `status ${shell.res.status}, ${shell.html.length} bytes, cookies ${shell.jar.size}`);
    if (shell.res.status !== 200) { info(shell.html.slice(0, 300)); return; }
    const bootGlobal = shell.html.includes('__DSH_BOOT__');
    check(inst, 'window.__DSH_BOOT__ injected', bootGlobal);

    const combo = extractCombo(shell.html, PLUGIN);
    if (!check(inst, `boot graph carries ${PLUGIN}/client.js`, Boolean(combo), combo ?? 'not found in HTML')) {
      warn('boot graph rows are the client half of every enabled plugin; check the profile bundle list and boot log.');
      return;
    }
    info(`combo: ${combo.slice(0, 160)}${combo.length > 160 ? '…' : ''}`);
    const comboUrl = new URL(combo, shell.baseUrl);
    const comboRes = await fetch(comboUrl, { headers: { cookie: cookieHeader(shell.jar) } });
    const comboBody = await comboRes.text();
    const registers = new RegExp(`id\\s*:\\s*["']${PLUGIN}["']`).test(comboBody);
    check(inst, 'plugin client bundle served', comboRes.status === 200 && comboBody.includes('__ModuleLoader__') && registers,
      `status ${comboRes.status}, ${comboBody.length} bytes, registers id: ${registers}`);

    const state = await probeState(inst, shell);
    const keys = state.json && typeof state.json === 'object' ? Object.keys(state.json).slice(0, 8).join(',') : '';
    check(inst, `${STATE_METHOD} ${STATE_PATH}`, state.routeExists,
      `status ${state.res.status}${keys ? `, keys: ${keys}` : ''}${state.json?.instanceId ? `, instanceId: ${state.json.instanceId}` : ''}`);
    if (!state.routeExists) info(`body: ${state.text.slice(0, 400).replace(/\s+/g, ' ')}`);
    else if (state.text) info(`state body: ${state.text.slice(0, 300).replace(/\s+/g, ' ')}`);
  } catch (error) {
    check(inst, 'instance verification', false, error.message);
  } finally {
    if (inst.spawned && !KEEP) await stopInstance(inst);
  }
}

async function stopInstance(inst) {
  const child = inst.child;
  if (!child || child.exitCode !== null) return;
  info(`${inst.side}: stopping spawned instance (pid ${child.pid})`);
  child.kill('SIGTERM');
  for (let i = 0; i < 10; i++) {
    if (!(await portOpen(inst.port))) break;
    await sleep(300);
  }
  if (await portOpen(inst.port)) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await sleep(500);
  }
}

// ---------------------------------------------------------------- main
console.log(`verify ${PLUGIN} on ${instances.map((i) => `:${i.port}`).join(' / ')} (method ${STATE_METHOD} ${STATE_PATH})`);
if (SPAWN) info('--spawn: instances will be started with their own DSH_HOME and stopped afterwards unless --keep');
let cli;
try { cli = findCli(); info(`dsh CLI: ${cli}`); } catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
}
for (const inst of instances) await verifyInstance(inst, cli);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
if (failed.length > 0) {
  console.log('failed:');
  for (const f of failed) console.log(`  - ${f.side} ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exitCode = 1;
} else {
  console.log('PASS — both instances serve the shell, advertise the plugin client bundle and answer the host route.');
}
