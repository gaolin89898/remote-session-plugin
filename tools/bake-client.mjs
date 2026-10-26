/** Build and synchronize native machine switching; preserve device settings. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
await import('./build-machine-client.mjs');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const targets = [
  path.join(root, 'dist/dsh-remote-session'),
  path.join(root, 'dist/dsh-remote-session-company'),
  path.join(os.homedir(), '.dsh/profiles/desktop/node_modules/dsh-remote-session'),
];
for (const target of targets) {
  for (const relative of manifest.files) {
    const destination = path.join(target, relative);
    if (relative === 'cordis.patch.yml' && fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  console.log('synced native plugin ->', target);
}
