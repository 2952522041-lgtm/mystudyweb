import assert from 'node:assert/strict';
import test from 'node:test';
import { alignParagraphs, mapTextItemsToParagraphs } from '../lib/paragraph-alignment.ts';
import { normalizePage, type PdfTextItem } from '../lib/pdf-text.ts';

void test('equal bilingual paragraph counts align by index without mutating input', () => {
  const source = Object.freeze(['First paragraph.', 'Second paragraph.']);
  const target = Object.freeze(['第一段。', '第二段。']);
  assert.deepEqual(alignParagraphs(source, target), {
    sourceToTarget: [[0], [1]], targetToSource: [[0], [1]], mode: 'index',
  });
});
void test('split translations group contiguous targets by relative length', () => {
  const result = alignParagraphs(['a'.repeat(80), 'b'.repeat(20)], ['甲'.repeat(40), '乙'.repeat(40), '丙'.repeat(20)]);
  assert.deepEqual(result.sourceToTarget, [[0, 1], [2]]);
  assert.deepEqual(result.targetToSource, [[0], [0], [1]]);
  assert.equal(result.mode, 'estimated');
});
void test('merged translations group contiguous sources by relative length', () => {
  const result = alignParagraphs(['a'.repeat(20), 'b'.repeat(30), 'c'.repeat(50)], ['甲'.repeat(50), '乙'.repeat(50)]);
  assert.deepEqual(result.targetToSource, [[0, 1], [2]]);
  assert.deepEqual(result.sourceToTarget, [[0], [0], [1]]);
});
void test('one merged model paragraph links every nonempty source', () => {
  assert.deepEqual(alignParagraphs(['a', 'b', 'c'], ['1. 甲乙丙']).targetToSource, [[0, 1, 2]]);
});
void test('empty and whitespace paragraphs retain original indices without links', () => {
  assert.deepEqual(alignParagraphs(['', 'First', ' ', 'Second'], ['甲', '', '乙']).sourceToTarget, [[], [0], [], [2]]);
  assert.deepEqual(alignParagraphs([''], ['甲']), { sourceToTarget: [[]], targetToSource: [[]], mode: 'unavailable' });
  assert.equal(alignParagraphs(['a'], []).mode, 'unavailable');
  assert.equal(alignParagraphs([], []).mode, 'unavailable');
});
void test('model numbering affects neither indices nor displayed strings', () => {
  const target = ['1. 甲甲', '2) 乙乙', '（3） 丙'];
  const before = [...target];
  assert.deepEqual(alignParagraphs(['aaaa', 'b'], target).sourceToTarget, [[0, 1], [2]]);
  assert.deepEqual(target, before);
  assert.deepEqual(alignParagraphs(['a'], ['1.', '2. 甲']).targetToSource, [[], [0]]);
});
void test('reordered output is kept positional rather than claiming semantic recovery', () => {
  assert.deepEqual(alignParagraphs(['alpha', 'beta'], ['beta', 'alpha']).sourceToTarget, [[0], [1]]);
});
void test('shared tokens guide ambiguous unequal-count grouping', () => {
  const result = alignParagraphs(['alpha', 'beta', 'gamma'], ['alpha beta', 'gamma']);
  assert.deepEqual(result.targetToSource, [[0, 1], [2]]);
});
void test('pathological output is bounded, ordered, covered and reciprocal', () => {
  for (const [source, target] of [[3, 250], [250, 3], [8, 13], [13, 8]]) {
    const result = alignParagraphs(Array.from({ length: source }, (_, i) => `source ${i}`), Array.from({ length: target }, (_, i) => `译文 ${i}`));
    result.sourceToTarget.forEach((group, s) => {
      assert.ok(group.length);
      group.forEach((t) => assert.ok(result.targetToSource[t].includes(s)));
    });
    result.targetToSource.forEach((group) => assert.ok(group.length));
    assert.deepEqual(result.sourceToTarget.flat(), result.sourceToTarget.flat().sort((a, b) => a - b));
  }
});

function item(str: string, x: number, y: number, width = 200): PdfTextItem {
  return { str, x, y, width, height: 12 };
}
void test('raw item order maps back to reading-order paragraphs, skipping furniture and blanks', () => {
  const items = [item('Second paragraph.', 0, 120), item('First paragraph', 0, 20), item('continues here.', 0, 36), item('7', 0, 780), item(' ', 0, 0)];
  const { paragraphs } = normalizePage(items);
  assert.equal(paragraphs.length, 2);
  assert.deepEqual(mapTextItemsToParagraphs(paragraphs, items), [[1], [0], [0], [], []]);
});
void test('two-column mapping follows existing column order rather than interleaving spans', () => {
  const items = [item('Left one', 0, 30, 80), item('Right one', 110, 30, 80), item('left two.', 0, 46, 80), item('right two.', 110, 46, 80)];
  const { paragraphs } = normalizePage(items);
  assert.equal(paragraphs.length, 2);
  assert.deepEqual(mapTextItemsToParagraphs(paragraphs, items), [[0], [1], [0], [1]]);
});
void test('item mapping handles hyphenation, ligatures, math and repeated paragraph strings', () => {
  const items = [item('The transla-', 0, 20), item('tion of 𝜑 and ﬁ.', 0, 36), item('Again.', 0, 120), item('Again.', 0, 220)];
  assert.deepEqual(mapTextItemsToParagraphs(['The translation of φ and fi.', 'Again.', 'Again.'], items), [[0], [0], [1], [2]]);
});
void test('unmatched source text never invents a paragraph location', () => {
  assert.deepEqual(mapTextItemsToParagraphs(['Known paragraph.'], [item('Unrelated text', 0, 20)]), [[]]);
});
void test('a span overlapping two normalized paragraphs links both', () => {
  assert.deepEqual(mapTextItemsToParagraphs(['First.', 'Second.'], [item('First. Second.', 0, 20)]), [[0, 1]]);
});
