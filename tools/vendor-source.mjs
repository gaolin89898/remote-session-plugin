import fs from 'node:fs';
import https from 'node:https';

/**
 * Vendor the official client sources this plugin needs to render the same
 * conversation tree (MIT licensed). Run from the plugin root:
 *   node tools/vendor-source.mjs
 */
const BRANCH = 'master';
const REPO = 'deepseek-ai/deepseek-harness';
const OUT = 'vendor/upstream';

const DIRS = [
  'packages/client/ui-primitives/src',
  'packages/client/ui-chat/src/client',
  'packages/client/ui-conversation/src/client',
];

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'dsh-remote-session-vendor' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          resolve(get(res.headers.location));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => (res.statusCode === 200 ? resolve(data) : reject(new Error(String(res.statusCode)))));
      })
      .on('error', reject);
  });
}

async function listTree(path) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`;
  const json = JSON.parse(await get(url));
  if (!Array.isArray(json)) throw new Error(`not a directory: ${path}`);
  return json;
}

async function walk(path) {
  for (const entry of await listTree(path)) {
    if (entry.type === 'dir') {
      await walk(entry.path);
      continue;
    }
    if (!/\.(ts|tsx|css|json)$/u.test(entry.name)) continue;
    const local = `${OUT}/${entry.path.replace(/^packages\/client\//u, '')}`;
    fs.mkdirSync(local.slice(0, local.lastIndexOf('/')), { recursive: true });
    const raw = await get(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${entry.path}`);
    fs.writeFileSync(local, raw);
    console.log(`ok ${entry.path}`);
  }
}

fs.mkdirSync(OUT, { recursive: true });
for (const dir of DIRS) {
  console.log(`--- ${dir}`);
  await walk(dir);
}
console.log('vendor sources downloaded');
