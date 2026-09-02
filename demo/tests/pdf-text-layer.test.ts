import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { shouldBuildTextLayer, textLayerScale } from '../lib/pdf-text-layer.ts';
import type { PdfTextItem } from '../lib/pdf-text.ts';

const pageSource = await readFile(
  new URL('../app/page.tsx', import.meta.url),
  'utf8',
);
const styles = await readFile(
  new URL('../app/globals.css', import.meta.url),
  'utf8',
);
const pdfjsSource = await readFile(
  new URL('../lib/pdfjs.ts', import.meta.url),
  'utf8',
);

function itemsOf(...texts: string[]): PdfTextItem[] {
  return texts.map((str, index) => ({
    str,
    x: index * 100,
    y: index * 20,
    width: 90,
    height: 12,
  }));
}

void test('pages with real extractable text build a text layer', () => {
  assert.equal(
    shouldBuildTextLayer(itemsOf('This page carries a rendered sentence.')),
    true,
  );
  assert.equal(shouldBuildTextLayer(itemsOf('x'.repeat(24))), true);
});

void test('scanned or near-empty pages stay canvas-only', () => {
  assert.equal(shouldBuildTextLayer([]), false);
  assert.equal(shouldBuildTextLayer(itemsOf('x'.repeat(23))), false);
  assert.equal(shouldBuildTextLayer(itemsOf('   ', '', '9')), false);
});

void test('text layer scale maps page units onto the rendered box', () => {
  assert.equal(textLayerScale(612, 612), 1);
  assert.equal(textLayerScale(918, 612), 1.5);
  assert.equal(textLayerScale(957, 612), 957 / 612);
});

void test('degenerate dimensions fall back to a unit scale', () => {
  assert.equal(textLayerScale(0, 612), 1);
  assert.equal(textLayerScale(612, 0), 1);
  assert.equal(textLayerScale(-10, 612), 1);
});

// No React component test framework is installed; follow the repo convention
// (see reader-layout.test.ts) of asserting the wiring in the page source.
void test('PdfPageCanvas overlays a hidden text layer on the canvas', () => {
  assert.match(pageSource, /className="pdf-text-layer"/);
  assert.match(
    pageSource,
    /ref=\{textLayerRef\}\s*className="pdf-text-layer"\s*aria-hidden="true"/,
  );
  // The overlay must sit above the canvas in paint order.
  assert.ok(
    pageSource.indexOf('<canvas') <
      pageSource.indexOf('className="pdf-text-layer"'),
    'text layer container must come after the canvas',
  );
  assert.match(pageSource, /container\.replaceChildren\(\)/);
});

void test('PdfPageCanvas renders TextLayer through the pdf.js module class', () => {
  assert.match(pdfjsSource, /TextLayer: typeof TextLayer/);
  assert.match(pageSource, /type TextLayer,?\s*\} from '@\/lib\/pdfjs'/);
  assert.match(pageSource, /new pdfjs\.TextLayer\(\{/);
  assert.match(pageSource, /textContentSource: content,/);
  assert.match(pageSource, /viewport: pdfPage\.getViewport\(\{ scale \}\)/);
});

void test('only pages with extractable text get a text layer', () => {
  assert.match(pageSource, /shouldBuildTextLayer\(items\)/);
  assert.match(pageSource, /if \(!shouldBuildTextLayer\(items\)\) return;/);
  assert.match(pageSource, /itemsFromPdfJs\(\s*content\.items as Array<\{/);
});

void test('text layer geometry is rebuilt with the canvas from one scale', () => {
  assert.match(
    pageSource,
    /const scale = textLayerScale\(width, base\.width\)/,
  );
  assert.match(pageSource, /getViewport\(\{ scale: scale \* dpr \}\)/);
  assert.match(pageSource, /--total-scale-factor', String\(scale\)/);
  // Same effect inputs as the canvas render task.
  assert.match(pageSource, /\}, \[pdfDoc, pageNumber, width, height\]\);/);
  assert.match(pageSource, /activeTextLayer\?\.cancel\(\)/);
});

void test('styles lay the text layer over the page without hiding the selection', () => {
  assert.match(styles, /\.pdf-text-layer\s*\{[\s\S]*?position:\s*absolute/);
  assert.match(styles, /\.pdf-text-layer\s*\{[\s\S]*?inset:\s*0/);
  assert.match(styles, /\.pdf-text-layer\s*\{[\s\S]*?transform-origin:\s*0 0/);
  assert.match(
    styles,
    /\.pdf-text-layer :is\(span, br\)\s*\{[\s\S]*?color:\s*transparent/,
  );
  assert.match(styles, /\.pdf-text-layer ::selection\s*\{[\s\S]*?background:/);
});
