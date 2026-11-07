import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const check = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { status: 400 }); };
export function validateHost(input, previous) {
  check(input && typeof input === 'object', '请输入机器配置');
  const host = { id: previous?.id || randomUUID(), name: String(input.name || '').trim().slice(0, 80), mode: input.mode === 'ssh' ? 'ssh' : 'direct', token: input.token || previous?.token };
  check(host.name && typeof host.token === 'string' && host.token.length >= 32 && !/[\r\n]/.test(host.token), '请填写机器名称和至少 32 位的网关令牌');
  if (host.mode === 'direct') {
    const url = new URL(input.url);
    check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', '请填写 HTTP(S) 网关地址，不包含路径或凭据');
    host.url = url.origin;
  } else {
    check(typeof input.target === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,250}$/.test(input.target), '请输入 SSH 配置别名或 user@host');
    host.target = input.target;
    host.sshPort = Number(input.sshPort || 22); host.gatewayPort = Number(input.gatewayPort || 3490);
    for (const port of [host.sshPort, host.gatewayPort]) check(Number.isInteger(port) && port > 0 && port < 65536, '端口无效');
  }
  return host;
}
export async function gatewayCall(base, token, method, params = {}, signal) {
  const response = await fetch(base + '/v1/call', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ method, params }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000) });
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('网关响应过大'); chunks.push(chunk); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!response.ok || body.ok !== true) throw Object.assign(new Error(body.error?.message || '网关请求失败'), { status: response.status >= 400 ? response.status : 502 });
  return body.result;
}
async function tunnel(host) {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn('ssh', ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-p', String(host.sshPort), '-L', `127.0.0.1:${port}:127.0.0.1:${host.gatewayPort}`, '--', host.target], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.resume(); let failed = false; child.on('error', () => { failed = true; }); child.on('exit', () => { failed = true; });
  const close = () => child.kill();
  try {
    const base = 'http://127.0.0.1:' + port;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (failed) throw new Error('SSH 连接失败，请先使用系统 ssh 确认主机指纹、密钥和 SSH 配置');
      try { await gatewayCall(base, host.token, 'node.describe', {}, AbortSignal.timeout(1000)); return { base, close, child }; }
      catch (error) { if (error.status) throw error; }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('SSH 网关连接超时，请确认远程网关已启动');
  } catch (error) { close(); throw error; }
}

export class Workbench {
  constructor(home) { this.file = path.join(home, 'agent-workbench-hosts.json'); this.links = new Map(); this.generations = new Map(); this.queue = Promise.resolve(); this.closed = false; }
  async hosts() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async route(action, body, signal) {
    check(!this.closed, '工作台已关闭');
    if (action === 'hosts') return { hosts: (await this.hosts()).map(({ token, ...host }) => ({ ...host, connected: this.links.has(host.id) })) };
    if (action === 'save' || action === 'remove') {
      const task = this.queue.catch(() => {}).then(async () => {
        const hosts = await this.hosts(), previous = hosts.find(item => item.id === body.id);
        if (action === 'remove') { check(previous, '机器不存在'); this.disconnect(body.id); hosts.splice(hosts.indexOf(previous), 1); }
        else {
          const host = validateHost(body, previous); this.disconnect(host.id);
          if (previous) hosts.splice(hosts.indexOf(previous), 1, host); else hosts.push(host);
        }
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        await writeFile(this.file + '.tmp', JSON.stringify(hosts), { mode: 0o600 }); await rename(this.file + '.tmp', this.file);
      });
      this.queue = task; await task; return this.route('hosts', {});
    }
    if (action === 'disconnect') { this.disconnect(body.id); return {}; }
    const host = (await this.hosts()).find(item => item.id === body.id); check(host, '请选择已保存的机器');
    if (action === 'connect') {
      this.disconnect(host.id);
      const generation = this.generations.get(host.id);
      const link = host.mode === 'ssh' ? await tunnel(host) : { base: host.url, close() {} };
      try { const node = await gatewayCall(link.base, host.token, 'node.describe', {}, signal); check(!this.closed && this.generations.get(host.id) === generation, '连接已取消'); this.links.set(host.id, link); link.child?.once('exit', () => { if (this.links.get(host.id) === link) this.links.delete(host.id); }); return { node }; }
      catch (error) { link.close(); throw error; }
    }
    check(action === 'call', '未知工作台操作');
    const link = this.links.get(host.id); check(link, '请先连接机器');
    return { result: await gatewayCall(link.base, host.token, body.method, body.params, signal) };
  }
  disconnect(id) { this.generations.set(id, (this.generations.get(id) || 0) + 1); this.links.get(id)?.close(); this.links.delete(id); }
  dispose() { this.closed = true; for (const id of this.generations.keys()) this.disconnect(id); }
}
