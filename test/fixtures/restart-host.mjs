import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { RestartController } from '../../lib/restart.js';

const stateFile = process.argv[2];
let old = {};
try { old = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first launch */ }
const controller = new RestartController({ get: key => key === 'appExit' ? () => {
  controller.dispose();
  server.closeAllConnections();
  server.close(() => { process.exitCode = 0; });
} : undefined }, 'web');
// This isolated fixture owns its complete process, including in test containers.
const desktop = process.env.DSH_TEST_DESKTOP_MAIN === '1';
const identity = () => ({ pid: process.pid, port: server.address().port, ...desktop ? { mainPid: process.ppid } : {} });
controller.plan = () => ({ kind: desktop ? 'desktop' : 'process', platform: process.platform, pid: process.pid,
  mainPid: process.ppid, mainExecPath: process.execPath, execPath: process.execPath,
  args: desktop ? [fileURLToPath(new URL('./restart-desktop.mjs', import.meta.url)), stateFile] : process.argv.slice(1),
  cwd: process.cwd(), env: process.env });
const server = http.createServer(async (req, res) => {
  if (req.url === '/restart' && req.method === 'POST') {
    const job = await controller.prepare();
    res.once('finish', () => controller.commit(job));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ...controller.status(), ...identity() }));
});
server.listen(old.port || 0, '127.0.0.1', () => {
  fs.writeFileSync(stateFile, JSON.stringify(identity()));
});
