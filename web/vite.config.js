import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  base: '/panel/',
  server: {
    port: 5173,
    strictPort: false,
    proxy: { '/panel/api': 'http://127.0.0.1:7863' },
  },
  build: {
    outDir: fileURLToPath(new URL('../internal/panel/accounts_dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'accounts.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
