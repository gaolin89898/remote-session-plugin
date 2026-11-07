#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, createGatewayServer } from './server.mjs';

const args = process.argv.slice(2), action = args[0] || 'help';
const index = args.indexOf('--config');
const file = path.resolve(index >= 0 && args[index + 1] ? args[index + 1] : path.join(homedir(), '.dsh-agent-gateway', 'config.json'));
try {
  if (index >= 0 && !args[index + 1]) throw Object.assign(new Error('--config requires a path.'), { code: 'INVALID_ARGUMENT' });
  if (action === 'init') {
    try { await access(file); throw Object.assign(new Error('Configuration already exists.'), { code: 'EEXIST' }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tokenFile = path.join(path.dirname(file), 'gateway.token');
    await writeFile(tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    await writeFile(file, JSON.stringify({ id: hostname(), name: hostname(), host: '127.0.0.1', port: 3490, tokenFile: 'gateway.token', stateFile: 'sessions.json', workspaces: [{ id: 'project', name: 'Project', path: process.cwd() }], agents: { codex: { kind: 'codex', command: 'codex' }, opencode: { kind: 'opencode', command: 'opencode' }, dsh: { kind: 'dsh', enabled: false, url: 'http://127.0.0.1:3080', tokenEnv: 'DSH_WEB_TOKEN' } } }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`Created ${file}\nToken stored privately at ${tokenFile}\nReview the configured workspaces, then run: node gateway/cli.mjs serve --config "${file}"`);
  } else if (action === 'serve') {
    const { config, token } = await loadConfig(file), service = await createGatewayServer(config, token);
    await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(config.port, config.host, resolve); });
    console.log(`Agent gateway listening on ${config.host}:${service.server.address().port}`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await service.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else console.log('node gateway/cli.mjs init|serve [--config <private-config.json>]');
} catch (error) { console.error(error.code ? `${error.code}: ${error.message}` : 'Gateway startup failed. Check the configuration and file permissions.'); process.exitCode = 1; }
