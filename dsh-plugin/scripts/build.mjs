import { copyFile, mkdir } from 'node:fs/promises';

await mkdir(new URL('../public/', import.meta.url), { recursive: true });
for (const name of ['index.html', 'accounts.js', 'index.css']) {
  await copyFile(new URL('../../web/dist/' + name, import.meta.url), new URL('../public/' + name, import.meta.url));
}
console.log('独立前端已复制到插件包；未包含 Go 程序、配置或账号数据。');
