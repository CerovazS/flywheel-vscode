import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Two modes:
 * - `vite build`  → emits the production webview bundle (entry: build.html).
 * - `vite` (dev)  → serves the standalone preview (entry: index.html → preview.tsx).
 *
 * Same component code, different entrypoints. The preview lets us iterate on
 * rendering without launching the VS Code Extension Development Host.
 */
export default defineConfig(({ command }) => ({
  plugins: [react()],
  root: resolve(__dirname, 'src/webview'),
  base: './',
  server: {
    port: 5174,
    open: false,
  },
  build: {
    outDir: resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input:
        command === 'build'
          ? resolve(__dirname, 'src/webview/build.html')
          : resolve(__dirname, 'src/webview/index.html'),
      output: {
        entryFileNames: 'webview.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        // CSS gets a stable filename so the host's manually-emitted HTML
        // (see `getWebviewHtml`) can link to it without reading a manifest.
        // Other assets (KaTeX fonts, images) keep the hash for cache busting.
        assetFileNames: (info) => {
          const n = info.name ?? '';
          if (n.endsWith('.css')) return 'assets/styles.css';
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
}));
