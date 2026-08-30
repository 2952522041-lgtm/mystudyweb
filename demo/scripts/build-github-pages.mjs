/**
 * Post-processes a vinext static export for GitHub Pages project sites.
 *
 * vinext's `basePath` option is currently incompatible with `output: 'export'`,
 * so the export is built at the domain root and every text asset that can
 * contain a root-absolute `/_next/` URL is rewritten afterwards.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REWRITE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.rsc',
  '.txt',
  '.webmanifest',
  '.xml',
]);

/** @param {Record<string, string | undefined>} environment */
export function resolveRepositoryName(environment = process.env) {
  const explicit = environment.PAGES_REPO_NAME?.trim();
  const fromGitHub = environment.GITHUB_REPOSITORY?.split('/').at(-1)?.trim();
  const repositoryName = explicit || fromGitHub || 'mystudyweb';
  if (!/^[A-Za-z0-9._-]+$/.test(repositoryName)) {
    throw new Error(`Invalid GitHub Pages repository name: ${repositoryName}`);
  }
  return repositoryName;
}

export function isRewriteTarget(file) {
  return (
    path.basename(file) === '_headers' ||
    REWRITE_EXTENSIONS.has(path.extname(file).toLowerCase())
  );
}

export function rewriteAssetPaths(source, repositoryName) {
  return source.replace(
    /(^|[^A-Za-z0-9._-])\/_next\//g,
    `$1/${repositoryName}/_next/`,
  );
}

export async function rewriteGitHubPagesOutput(clientDir, repositoryName) {
  await writeFile(path.join(clientDir, '.nojekyll'), '');

  const entries = await readdir(clientDir, { recursive: true });
  let changed = 0;
  for (const entry of entries) {
    if (!isRewriteTarget(entry)) continue;
    const file = path.join(clientDir, entry);
    const source = await readFile(file, 'utf8');
    const rewritten = rewriteAssetPaths(source, repositoryName);
    if (rewritten === source) continue;
    await writeFile(file, rewritten);
    changed += 1;
  }
  return changed;
}

async function main() {
  const clientDir = path.resolve(import.meta.dirname, '../dist/client');
  const repositoryName = resolveRepositoryName();
  const changed = await rewriteGitHubPagesOutput(clientDir, repositoryName);
  console.log(
    `build:pages rewrote ${changed} text asset(s) under dist/client for /${repositoryName}/`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
