import { access } from 'node:fs/promises';
for (const name of ['index.html', 'accounts.js', 'index.css']) {
  await access(new URL('../public/' + name, import.meta.url));
}
