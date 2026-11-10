import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: './',
  server: { port: 4173, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true },
});
