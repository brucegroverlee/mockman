import { defineConfig } from 'tsup';

/**
 * Bundles to a single ESM file so MCP client configs can point at one absolute
 * path (`node .../dist/index.js`) with no dependency resolution to go wrong. That
 * matters more than usual on Windows, where clients spawn without a shell and
 * cannot execute `.cmd` shims.
 *
 * `@network-mock/shared` is consumed as TypeScript source and gets inlined here.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Keep real dependencies external; only the workspace package is inlined.
  noExternal: [/^@network-mock\//],
  banner: { js: '#!/usr/bin/env node' },
});
