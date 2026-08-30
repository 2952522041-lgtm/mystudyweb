import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePdfWorkerSrc } from '../lib/pdfjs.ts';

void test('worker resolves next to the page on a domain root', () => {
  assert.equal(
    resolvePdfWorkerSrc('https://app.example.com/'),
    'https://app.example.com/pdf.worker.min.mjs',
  );
});

void test('worker resolves under a GitHub Pages project sub-path', () => {
  assert.equal(
    resolvePdfWorkerSrc('https://user.github.io/mystudyweb/'),
    'https://user.github.io/mystudyweb/pdf.worker.min.mjs',
  );
});

void test('worker resolution ignores the page path depth', () => {
  assert.equal(
    resolvePdfWorkerSrc('https://user.github.io/mystudyweb/index.html'),
    'https://user.github.io/mystudyweb/pdf.worker.min.mjs',
  );
});
