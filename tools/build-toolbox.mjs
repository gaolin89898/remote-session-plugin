import { copyFile, mkdir } from 'node:fs/promises';

// The Go service embeds the same Vue build through toolbox/web; the plugin
// serves the standalone build of that page as its AI toolbox UI.
await mkdir(new URL('../public/', import.meta.url), { recursive: true });
for (const name of ['index.html', 'accounts.js', 'index.css']) {
  await copyFile(new URL('../toolbox/web/dist/' + name, import.meta.url), new URL('../public/' + name, import.meta.url));
}
console.log('copied toolbox page -> public/');
