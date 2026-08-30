/**
 * Post-processes a `vinext build` static export (output: 'export') for
 * publication on GitHub Pages project sites, which serve the repository
 * under a sub-path (e.g. /<user>.github.io/<repo>/).
 *
 * vinext's `basePath` option is incompatible with `output: 'export'`
 * (prerendered HTML then references chunk names that were never emitted),
 * so the export is built at the root and this script rewrites the
 * root-absolute `/_next/` references to `/<repo>/_next/` afterwards.
 *
 * Run AFTER `pnpm build`; see the `build:pages` npm script.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repoName = 'mystudyweb';
const clientDir = path.resolve(import.meta.dirname, '../dist/client');

// GitHub Pages runs Jekyll by default, which drops `_next/` directories.
await writeFile(path.join(clientDir, '.nojekyll'), '');

async function rewriteHtml(file) {
  const source = await readFile(file, 'utf8');
  const rewritten = source.replaceAll('/_next/', `/${repoName}/_next/`);
  if (rewritten !== source) await writeFile(file, rewritten);
  return rewritten !== source;
}

const entries = await readdir(clientDir, { recursive: true });
let changed = 0;
for (const entry of entries) {
  if (entry.endsWith('.html')) {
    if (await rewriteHtml(path.join(clientDir, entry))) changed += 1;
  }
}
console.log(`build:pages rewrote ${changed} HTML file(s) under dist/client`);
