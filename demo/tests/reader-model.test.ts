import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampPage,
  fillColumnPageWidth,
  getTranslation,
  nextPageToPrefetch,
  stepZoom,
  translationCopy,
} from '../lib/reader-model.ts';

void test('page navigation stays within the document bounds', () => {
  assert.equal(clampPage(0), 1);
  assert.equal(clampPage(4.4), 4);
  assert.equal(clampPage(99), 12);
});

void test('zoom changes one supported step at a time and stops at limits', () => {
  assert.equal(stepZoom(95, 1), 110);
  assert.equal(stepZoom(95, -1), 85);
  assert.equal(stepZoom(150, 1), 150);
  assert.equal(stepZoom(75, -1), 75);
});

void test('PDF pages fill the reading column and respect zoom', () => {
  assert.equal(fillColumnPageWidth(900), 876);
  assert.equal(fillColumnPageWidth(360), 336);
  assert.equal(fillColumnPageWidth(900, 110), 1014);
});

void test('only the next in-range page is selected for translation prefetch', () => {
  assert.equal(nextPageToPrefetch(3, 10), 4);
  assert.equal(nextPageToPrefetch(10, 10), null);
});

void test('uncached demo pages still return a useful translation state', () => {
  const translation = getTranslation(11);
  assert.match(translation.title, /11/);
  assert.equal(translation.paragraphs.length, 2);
});

void test('copy text preserves title, paragraphs, and quote', () => {
  const text = translationCopy(getTranslation(4));
  assert.match(text, /学习是一个持续发生的过程/);
  assert.match(text, /理解在专注、对照与重读中逐渐生长/);
});
