/**
 * Bake the vendored official bundles into the client half.
 *
 * The DSH plugin loader serves `lib/client.js` even when the host half in the
 * running app predates the `/remote-session/api/vendor-*` routes, so a fetched
 * 404 used to drop the panel into the hand-drawn fallback. The baked copies let
 * the client evaluate the official flow/assembler even against an old host;
 * fetching still wins when the host serves the routes.
 *
 * Run after editing lib/client.js or rebuilding lib/vendor/*.cjs, then deploy
 * the produced dist files (they are byte-identical to what ssh_upload sends).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marker = 'var BAKED_VENDOR = null; // bake-marker';
const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
if (!source.includes(marker)) throw new Error('client.js: bake marker missing');

const read = (name) => fs.readFileSync(path.join(root, 'lib/vendor', name), 'utf8');
const baked = {
  flow: read('flow.cjs'),
  assembler: read('assembler.cjs'),
  chat: read('ui-chat.cjs'),
};
const serialized = `var BAKED_VENDOR = ${JSON.stringify(baked)};`;
const output = source.replace(marker, () => serialized);

const targets = [
  path.join(root, 'dist/dsh-remote-session/lib/client.js'),
  path.join(root, 'dist/dsh-remote-session-company/lib/client.js'),
  path.join(os.homedir(), '.dsh/profiles/desktop/node_modules/dsh-remote-session/lib/client.js'),
];
for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output);
  // The host's vendor routes take precedence over the inline fallback. Keep
  // their files in step so an installed host cannot serve stale UI styles.
  const vendorDir = path.join(path.dirname(target), 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'flow.cjs'), baked.flow);
  fs.writeFileSync(path.join(vendorDir, 'assembler.cjs'), baked.assembler);
  fs.writeFileSync(path.join(vendorDir, 'ui-chat.cjs'), baked.chat);
  console.log('baked ->', target, (output.length / 1024 / 1024).toFixed(2) + 'MB');
}
