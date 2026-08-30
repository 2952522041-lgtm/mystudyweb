import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupLines,
  itemsFromPdfJs,
  normalizePage,
  pageHasText,
  sha256Hex,
  splitIntoColumns,
} from '../lib/pdf-text.ts';

function item(str: string, x: number, y: number, width = str.length * 5, height = 10) {
  return { str, x, y, width, height };
}

void test('pages with little or no text are detected as non-extractable', () => {
  assert.equal(pageHasText([]), false);
  assert.equal(pageHasText([item('img', 0, 0)]), false);
  assert.equal(pageHasText([item('The quick brown fox jumps over the lazy dog.', 0, 0)]), true);
});

void test('items on the same baseline merge into one line ordered left to right', () => {
  const lines = groupLines([
    item('world', 50, 100),
    item('Hello', 0, 100),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Hello world');
});

void test('words with a visual gap get a space, tight fragments do not', () => {
  const lines = groupLines([
    item('Hel', 0, 0, 12),
    item('lo', 13, 0, 8),
    item('world', 60, 0, 20),
  ]);
  assert.equal(lines[0].text, 'Hello world');
});

void test('normalizePage rebuilds paragraphs from gaps and sentence ends', () => {
  const line = (text: string, y: number, x = 0, width = 200) => item(text, x, y, width);
  const page = normalizePage([
    line('Learning is a continuous process that happens in small moments.', 0),
    line('and grows through attention and comparison over time.', 14),
    line('A second paragraph starts here after a visible gap.', 42),
  ]);
  assert.deepEqual(page.paragraphs, [
    'Learning is a continuous process that happens in small moments. and grows through attention and comparison over time.',
    'A second paragraph starts here after a visible gap.',
  ]);
});

void test('normalizePage rejoins hyphenated words across line breaks', () => {
  const page = normalizePage([
    item('The reader continues the transla-', 0, 0, 200),
    item('tion without interruption.', 0, 14, 200),
  ]);
  assert.equal(page.paragraphs[0], 'The reader continues the translation without interruption.');
});

void test('normalizePage keeps CJK text joined without inserted spaces', () => {
  const page = normalizePage([
    item('学习是', 0, 0, 30),
    item('一个过程', 30, 0, 40),
    item('不断建立联系。', 0, 14, 45),
  ]);
  assert.equal(page.paragraphs[0], '学习是一个过程不断建立联系。');
});

void test('two-column pages are read left column first, then right column', () => {
  const items = [
    item('left body text', 0, 0, 60),
    item('right body text', 100, 0, 60),
    item('left body text', 0, 14, 60),
    item('right body text', 100, 14, 60),
  ];
  const columns = splitIntoColumns(items);
  assert.equal(columns.length, 2);
  const page = normalizePage(items);
  assert.ok(page.text.startsWith('left body text'));
});

void test('single-column pages are not split by splitIntoColumns', () => {
  const items = [item('full width line one', 0, 0, 160), item('full width line two', 0, 14, 160)];
  assert.equal(splitIntoColumns(items).length, 1);
});

void test('sha256Hex produces a stable hex digest for strings and buffers', async () => {
  const fromString = await sha256Hex('hello');
  assert.equal(fromString, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  const fromBuffer = await sha256Hex(new TextEncoder().encode('hello').buffer);
  assert.equal(fromBuffer, fromString);
});

void test('itemsFromPdfJs flips PDF coordinates to top-origin and drops blanks', () => {
  const items = itemsFromPdfJs(
    [
      { str: 'second', transform: [10, 0, 0, 10, 0, 700], width: 40, height: 10 },
      { str: 'first', transform: [10, 0, 0, 10, 0, 712], width: 30, height: 10 },
      { str: '   ', transform: [10, 0, 0, 10, 0, 690], width: 10, height: 10 },
    ],
    792,
  );
  assert.equal(items.length, 2);
  assert.ok(items[0].y < items[1].y, 'text near the page top should have a smaller y');
  assert.equal(items[0].str, 'first');
});
