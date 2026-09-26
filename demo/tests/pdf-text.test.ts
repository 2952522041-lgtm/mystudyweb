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

function item(
  str: string,
  x: number,
  y: number,
  width = str.length * 5,
  height = 10,
) {
  return { str, x, y, width, height };
}

void test('pages with little or no text are detected as non-extractable', () => {
  assert.equal(pageHasText([]), false);
  assert.equal(pageHasText([item('img', 0, 0)]), false);
  assert.equal(
    pageHasText([item('The quick brown fox jumps over the lazy dog.', 0, 0)]),
    true,
  );
});

void test('items on the same baseline merge into one line ordered left to right', () => {
  const lines = groupLines([item('world', 50, 100), item('Hello', 0, 100)]);
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
  const line = (text: string, y: number, x = 0, width = 200) =>
    item(text, x, y, width);
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

void test('normalizePage rejoins explicitly soft-hyphenated words across line breaks', () => {
  const page = normalizePage([
    item('The reader continues the transla\u00ad', 0, 0, 200),
    item('tion without interruption.', 0, 14, 200),
  ]);
  assert.equal(
    page.paragraphs[0],
    'The reader continues the translation without interruption.',
  );
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

void test('dense journal columns with a narrow gutter are not interleaved', () => {
  const items = [
    item('214', 51, 10, 14),
    item('Journal Name (2023) 47:211–228', 390, 10, 154),
    item('left line one.', 51, 80, 238),
    item('right line one.', 306, 80, 238),
    item('left line two.', 51, 94, 238),
    item('right line two.', 306, 94, 238),
    item('left line three.', 51, 108, 238),
    item('right line three.', 306, 108, 238),
    item('123', 292, 760, 14),
  ];

  const columns = splitIntoColumns(items);
  assert.equal(columns.length, 2);
  const page = normalizePage(items);
  assert.equal(
    page.text,
    'left line one. left line two. left line three.\n\nright line one. right line two. right line three.',
  );
  assert.doesNotMatch(page.text, /214|Journal Name|123/);
});

void test('full-width title blocks stay before two-column body text', () => {
  const items = [
    item('A full-width paper title', 51, 30, 493),
    item('Abstract line spanning both columns.', 51, 50, 493),
    item('left body one.', 51, 100, 238),
    item('right body one.', 306, 100, 238),
    item('left body two.', 51, 114, 238),
    item('right body two.', 306, 114, 238),
    item('left body three.', 51, 128, 238),
    item('right body three.', 306, 128, 238),
  ];

  const page = normalizePage(items);
  assert.ok(
    page.text.indexOf('A full-width paper title') <
      page.text.indexOf('left body one.'),
  );
  assert.ok(
    page.text.indexOf('left body three.') <
      page.text.indexOf('right body one.'),
  );
});

void test('single-column pages are not split by splitIntoColumns', () => {
  const items = [
    item('full width line one', 0, 0, 160),
    item('full width line two', 0, 14, 160),
  ];
  assert.equal(splitIntoColumns(items).length, 1);
});

void test('sha256Hex produces a stable hex digest for strings and buffers', async () => {
  const fromString = await sha256Hex('hello');
  assert.equal(
    fromString,
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  const fromBuffer = await sha256Hex(new TextEncoder().encode('hello').buffer);
  assert.equal(fromBuffer, fromString);
});

void test('itemsFromPdfJs flips PDF coordinates to top-origin and drops blanks', () => {
  const items = itemsFromPdfJs(
    [
      {
        str: 'second',
        transform: [10, 0, 0, 10, 0, 700],
        width: 40,
        height: 10,
      },
      {
        str: 'first',
        transform: [10, 0, 0, 10, 0, 712],
        width: 30,
        height: 10,
      },
      { str: '   ', transform: [10, 0, 0, 10, 0, 690], width: 10, height: 10 },
    ],
    792,
  );
  assert.equal(items.length, 2);
  assert.ok(
    items[0].y < items[1].y,
    'text near the page top should have a smaller y',
  );
  assert.equal(items[0].str, 'first');
});

void test('normalizePage folds Office equation characters into plain text', () => {
  // PowerPoint/Office equation exports extract as Mathematical Italic
  // codepoints; translation models drop or corrupt those, so the page
  // pipeline must hand out plain equivalents.
  const page = normalizePage([
    item('Rotate by \u{1D711} about z.', 0, 0, 200),
    item('R = Rotz(\u{1D711})Roty(\u{1D703})Rotz(\u{1D713})', 0, 14, 200),
    item(
      'c\u{1D711}c\u{1D703}c\u{1D713} \u2212 s\u{1D711}s\u{1D713}',
      0,
      42,
      200,
    ),
    item('中文说明，全角标号不受影响！', 0, 56, 200),
  ]);
  assert.deepEqual(page.paragraphs, [
    'Rotate by φ about z. R = Rotz(φ)Roty(θ)Rotz(ψ)',
    'cφcθcψ − sφsψ 中文说明，全角标号不受影响！',
  ]);
  assert.equal(page.text, page.paragraphs.join('\n\n'));
});

void test('extraction preserves scientific characters, units and visible line-end dashes', () => {
  const text = 'x^2 H_2O α β γ θ μ Ω ≈ ≤ ≥ ± × ÷ → ∑ ∫ ∂ m/s² N·m ℃ - – —';
  assert.equal(normalizePage([item(text, 0, 0, 500)]).text, text);
  for (const dash of ['-', '–', '—']) {
    assert.ok(normalizePage([item(`x${dash}`, 0, 0, 100), item('y', 0, 14, 100)]).text.includes(dash));
  }
});

void test('edge digits attached to a formula and numeral-only pages are not page furniture', () => {
  const page = normalizePage([item('x', 0, 5, 5), item('2', 5, 0, 3, 6), item('Body text below.', 0, 50, 200)]);
  assert.match(page.text, /x2/);
  assert.equal(normalizePage([item('123', 0, 0)]).text, '123');
});
