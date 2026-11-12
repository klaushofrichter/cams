import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Three entries: index.html is the public landing page, app.html the signed-in
// SPA, 404.html the public 404 page. Express decides which one a request gets (server/routes/pages.ts).
export default defineConfig({
  root: resolve(__dirname),
  plugins: [svelte()],
  build: {
    outDir: resolve(__dirname, '../dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
        notFound: resolve(__dirname, '404.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/auth': 'http://localhost:8080',
    },
  },
});
