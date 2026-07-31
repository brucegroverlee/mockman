/**
 * Extension build.
 *
 * Two bundlers, because MV3 imposes two incompatible output formats:
 *
 *  - The **service worker** and the **DevTools pages** are ES modules, and the
 *    pages need HTML entry handling and JSX. That is Vite's job.
 *  - The **content scripts** cannot be ES modules. Chrome loads them as classic
 *    scripts, so each must be a single self-contained IIFE with no imports. That
 *    is esbuild's job, which does it in one line per entry.
 *
 * Trying to force both out of a single Rollup output config does not work:
 * Rollup refuses `format: 'iife'` with more than one input.
 *
 * Run with `--watch` to rebuild on change.
 */

import { build as esbuild, context as esbuildContext } from 'esbuild';
import { build as viteBuild } from 'vite';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');
const watch = process.argv.includes('--watch');

/** Content scripts: classic-script IIFEs, one file each, no shared chunks. */
const contentScriptOptions = {
  entryPoints: {
    'injected/intercept': resolve(here, 'src/injected/intercept.ts'),
    'content/relay': resolve(here, 'src/content/relay.ts'),
  },
  outdir: outDir,
  bundle: true,
  format: 'iife',
  target: 'chrome111',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
};

async function copyManifest() {
  await mkdir(outDir, { recursive: true });
  await copyFile(resolve(here, 'manifest.json'), resolve(outDir, 'manifest.json'));
}

async function main() {
  // We clean here rather than letting Vite do it: `emptyOutDir` is false in
  // vite.config.ts precisely so that Vite cannot delete the content scripts
  // esbuild just emitted.
  await rm(outDir, { recursive: true, force: true });
  await copyManifest();

  if (watch) {
    const ctx = await esbuildContext(contentScriptOptions);
    await ctx.watch();
    // Vite's watcher takes over and never resolves.
    await viteBuild({ build: { watch: {} } });
    return;
  }

  await esbuild(contentScriptOptions);
  await viteBuild();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
