import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pageSource = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

void test('reader exposes a scrollable thumbnail for every PDF page', () => {
  assert.match(pageSource, /className="thumbnail-sidebar"/);
  assert.match(pageSource, /pageNumbers\.map/);
  assert.match(styles, /\.thumbnail-scroll[\s\S]*overflow-y-auto/);
});

void test('reader canvas keeps every page in a continuous full-width column', () => {
  assert.match(pageSource, /className="document-pages"/);
  assert.match(pageSource, /className=\{`pdf-page /);
  assert.match(styles, /\.document-stage[\s\S]*overflow-auto/);
  assert.match(styles, /\.document-pages[\s\S]*min-w-full/);
});

void test('API key input captures its value before updating the settings state', () => {
  assert.match(pageSource, /const updateDraftApiKey = \(apiKey: string\) =>/);
  assert.match(pageSource, /onChange=\{\(event\) => updateDraftApiKey\(event\.target\.value\)\}/);
  assert.doesNotMatch(
    pageSource,
    /setDraftSettings\(\(previous\) => updateReaderApiKey\(previous, event\.target\.value\)\)/,
  );
});
