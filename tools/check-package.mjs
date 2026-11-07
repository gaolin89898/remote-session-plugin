import { access } from 'node:fs/promises';

// Packaged plugin files: the client bundle, both server halves, the AI toolbox
// page assets, and the bundle patch are required for the plugin to work.
for (const name of ['lib/client.js', 'lib/index.js', 'lib/toolbox-server.js', 'cordis.patch.yml']) {
  await access(new URL('../' + name, import.meta.url));
}
for (const name of ['index.html', 'accounts.js', 'index.css']) {
  await access(new URL('../public/' + name, import.meta.url));
}
console.log('plugin package files are present');
