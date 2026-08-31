import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isRewriteTarget,
  resolveRepositoryName,
  rewriteAssetPaths,
  rewriteGitHubPagesOutput,
} from '../scripts/build-github-pages.mjs';

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

void test('Pages build copies the PDF worker before creating the static export', () => {
  assert.match(
    packageJson.scripts.prepages,
    /^node scripts\/copy-pdf-worker\.mjs && /,
  );
  assert.match(packageJson.scripts.prepages, /VINEXT_EXPORT=1 vinext build$/);
});

void test('GitHub Pages repository name comes from CI and rejects unsafe values', () => {
  assert.equal(
    resolveRepositoryName({ GITHUB_REPOSITORY: 'example/learning-reader' }),
    'learning-reader',
  );
  assert.equal(
    resolveRepositoryName({
      GITHUB_REPOSITORY: 'example/ignored',
      PAGES_REPO_NAME: 'preview-site',
    }),
    'preview-site',
  );
  assert.throws(
    () => resolveRepositoryName({ PAGES_REPO_NAME: '../escape' }),
    /Invalid GitHub Pages repository name/,
  );
});

void test('root Next asset paths are rewritten without duplicating existing prefixes', () => {
  const source =
    'url(/_next/font.woff2) /_next/app.js /mystudyweb/_next/already.js';
  assert.equal(
    rewriteAssetPaths(source, 'mystudyweb'),
    'url(/mystudyweb/_next/font.woff2) /mystudyweb/_next/app.js /mystudyweb/_next/already.js',
  );
  assert.equal(isRewriteTarget('index.rsc'), true);
  assert.equal(isRewriteTarget('static/app.css'), true);
  assert.equal(isRewriteTarget('_headers'), true);
  assert.equal(isRewriteTarget('og.png'), false);
});

void test('Pages output rewrites HTML, CSS and RSC while preserving binary assets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pages-output-'));
  try {
    await mkdir(path.join(directory, '_next', 'static'), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(directory, 'index.html'),
        '<script src="/_next/app.js">',
      ),
      writeFile(path.join(directory, 'index.rsc'), ':HL["/_next/app.css"]'),
      writeFile(
        path.join(directory, '_next', 'static', 'app.css'),
        '@font-face{src:url(/_next/font.woff2)}',
      ),
      writeFile(
        path.join(directory, '_headers'),
        '/_next/static/*\n  cache: yes',
      ),
      writeFile(path.join(directory, 'og.png'), new Uint8Array([0, 1, 2, 3])),
    ]);

    const changed = await rewriteGitHubPagesOutput(directory, 'mystudyweb');

    assert.equal(changed, 4);
    for (const file of [
      'index.html',
      'index.rsc',
      '_next/static/app.css',
      '_headers',
    ]) {
      const content = await readFile(path.join(directory, file), 'utf8');
      assert.match(content, /\/mystudyweb\/_next\//);
      assert.doesNotMatch(content, /(^|[^\w])\/_next\//);
    }
    assert.deepEqual(
      await readFile(path.join(directory, 'og.png')),
      Buffer.from([0, 1, 2, 3]),
    );
    assert.equal(await readFile(path.join(directory, '.nojekyll'), 'utf8'), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
