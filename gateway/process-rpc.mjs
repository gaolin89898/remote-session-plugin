import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { GatewayError } from './core.mjs';

/** Resolve npm Windows launchers to their executable; no shell interpolation. */
export function commandLine(command, args) {
  if (process.platform !== 'win32') return { command, args };
  const candidates = path.isAbsolute(command) ? [command] : (process.env.PATH || '').split(path.delimiter).flatMap(dir => [path.join(dir, command + '.exe'), path.join(dir, command + '.cmd'), path.join(dir, command)]);
  const file = candidates.find(existsSync);
  if (!file || !/\.cmd$/i.test(file)) return { command: file || command, args };
  const script = readFileSync(file, 'utf8');
  const matches = [...script.matchAll(/"%dp0%[\\/]([^"\r\n]+\.(?:js|exe))"/gi)];
  const match = matches.find(item => /\.js$/i.test(item[1])) || matches.find(item => !/^node\.exe$/i.test(item[1]));
  if (!match) throw new GatewayError('INVALID_COMMAND', 'Configure the Agent executable or its JavaScript entry directly.');
  const entry = path.resolve(path.dirname(file), match[1]);
  return /\.js$/i.test(entry) ? { command: process.execPath, args: [entry, ...args] } : { command: entry, args };
}

/** Bounded newline JSON-RPC; application errors never log prompts or secrets. */
export class ProcessRpc extends EventEmitter {
  constructor(config, args) { super(); this.config = config; this.args = args; this.pending = new Map(); this.nextId = 1; this.closed = false; }
  async start() {
    if (this.child) return;
    if (this.closed) throw new GatewayError('AGENT_CLOSED', 'Agent process was closed.', 409);
    const launch = commandLine(this.config.command, this.config.args ?? this.args);
    const child = this.child = spawn(launch.command, launch.args, { cwd: this.config.cwd, env: { ...process.env, ...this.config.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => this.fail());
    child.stderr.resume();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { this.fail(); child.kill(); return; }
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { this.fail(); child.kill(); return; }
        if (message.method) this.emit('message', message);
        else {
          const waiting = this.pending.get(message.id);
          if (!waiting) continue;
          this.pending.delete(message.id); clearTimeout(waiting.timer);
          if (message.error) waiting.reject(new GatewayError('AGENT_RPC_ERROR', String(message.error.message || 'Agent request failed.'), 502));
          else waiting.resolve(message.result);
        }
      }
    });
    child.once('error', () => this.fail());
    child.once('exit', () => this.fail());
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new GatewayError('AGENT_UNAVAILABLE', 'Agent executable could not be started. Check the node configuration.', 503))); });
  }
  send(message) {
    if (this.closed || !this.child || this.child.exitCode !== null || this.child.stdin.destroyed) throw new GatewayError('AGENT_UNAVAILABLE', 'Agent process is not connected.', 503);
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params, timeout = 30000) {
    if (this.pending.size >= 128) return Promise.reject(new GatewayError('AGENT_BUSY', 'Too many pending Agent requests.', 429));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new GatewayError('AGENT_TIMEOUT', 'Agent request timed out; its outcome may be unknown.', 504)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  respond(id, result) { this.send({ jsonrpc: '2.0', id, result }); }
  reject(id) { this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Client capability unavailable.' } }); }
  fail() {
    if (this.failed) return;
    this.failed = true;
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new GatewayError('AGENT_DISCONNECTED', 'Agent process disconnected; no request was replayed.', 503)); }
    this.pending.clear();
    this.emit('unavailable');
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.fail();
    if (!this.child || !this.child.pid || this.child.exitCode !== null) return;
    const exited = new Promise(resolve => this.child.once('exit', resolve));
    this.child.kill();
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 2000); })]);
    clearTimeout(timer);
  }
}
