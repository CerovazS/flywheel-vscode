/**
 * esbuild config for the extension host bundle.
 *
 * Output: dist/extension.cjs (CommonJS, Node 20, external 'vscode').
 * The webview is built separately by Vite (vite.config.ts).
 */

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.cjs',
  external: ['vscode', 'better-sqlite3', 'sqlite-vec'],
  sourcemap: true,
  logLevel: 'info',
  minify: false,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('esbuild: watching extension host…');
} else {
  await esbuild.build(options);
}
