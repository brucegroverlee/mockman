import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const src = resolve(import.meta.dirname, 'src');

/**
 * Builds the ES-module half of the extension: the service worker plus the two
 * DevTools HTML pages. The content scripts are built separately by esbuild —
 * see build.mjs for why.
 *
 * `root` is set to `src` so that `devtools/panel.html` lands at
 * `dist/devtools/panel.html` rather than `dist/src/devtools/panel.html`.
 */
export default defineConfig({
  root: src,
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    // Must stay false: build.mjs cleans the directory itself, and Vite emptying
    // it here would delete the already-emitted content scripts.
    emptyOutDir: false,
    target: 'chrome111',
    sourcemap: true,
    rollupOptions: {
      input: {
        devtools: resolve(src, 'devtools/devtools.html'),
        panel: resolve(src, 'devtools/panel.html'),
        background: resolve(src, 'background/index.ts'),
      },
      output: {
        // The manifest names background/index.js explicitly, so that one entry
        // needs a stable, unhashed path. Everything else can be hashed.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background/index.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
