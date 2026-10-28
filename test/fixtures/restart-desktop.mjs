import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const host = fileURLToPath(new URL('./restart-host.mjs', import.meta.url));
const child = spawn(process.execPath, [host, process.argv[2]], {
  env: { ...process.env, DSH_TEST_DESKTOP_MAIN: '1' }, windowsHide: true, stdio: 'ignore',
});
child.on('exit', code => process.exit(code || 0));
