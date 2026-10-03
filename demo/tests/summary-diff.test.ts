import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareSummaryParagraphs,
  splitSummaryParagraphs,
} from '../lib/summary-diff.ts';

void test('normalizes line endings and splits blank paragraphs', () => {
  assert.deepEqual(splitSummaryParagraphs(' A\r\nline\r\n \r\nB '), [
    'A\nline',
    'B',
  ]);
});
void test('reports a replacement between shared paragraphs', () => {
  assert.deepEqual(compareSummaryParagraphs('A\n\nold\n\nZ', 'A\n\nnew\n\nZ'), {
    segments: [
      { kind: 'equal', text: 'A' },
      { kind: 'removed', text: 'old' },
      { kind: 'added', text: 'new' },
      { kind: 'equal', text: 'Z' },
    ],
    added: 1,
    removed: 1,
    unchanged: 2,
    coarse: false,
  });
});
void test('empty summaries have no changes', () => {
  assert.deepEqual(compareSummaryParagraphs('', ' \n\n '), {
    segments: [],
    added: 0,
    removed: 0,
    unchanged: 0,
    coarse: false,
  });
});

void test('normalizes lone CR and collapses runs of blank lines', () => {
  assert.deepEqual(splitSummaryParagraphs('A\rB\n\n \n\t\nC\n\n'), [
    'A\nB',
    'C',
  ]);
});

void test('omits empty paragraphs and keeps interior breaks and spaces', () => {
  assert.deepEqual(splitSummaryParagraphs('\n\n  \n'), []);
  assert.deepEqual(splitSummaryParagraphs('  a  b\n  c  '), ['a  b\n  c']);
});

void test('blank lines inside a fenced code block do not split', () => {
  assert.deepEqual(splitSummaryParagraphs('```\na\n\nb\n```'), [
    '```\na\n\nb\n```',
  ]);
});

void test('a fence without surrounding blank lines stays in the paragraph', () => {
  assert.deepEqual(splitSummaryParagraphs('text\n```\ncode\n```\nafter'), [
    'text\n```\ncode\n```\nafter',
  ]);
});

void test('closing fence needs the same character and at least the opening length', () => {
  assert.deepEqual(splitSummaryParagraphs('```\nx\n~~~~\ny\n```'), [
    '```\nx\n~~~~\ny\n```',
  ]);
  assert.deepEqual(splitSummaryParagraphs('```\nx\n``\n```'), [
    '```\nx\n``\n```',
  ]);
});

void test('a backtick info string containing a backtick does not open a fence', () => {
  assert.deepEqual(splitSummaryParagraphs('```a`b\n\nx'), ['```a`b', 'x']);
});

void test('a tilde fence may carry backticks in its info string', () => {
  assert.deepEqual(splitSummaryParagraphs('~~~`x\n\ny'), ['~~~`x\n\ny']);
});

void test('an unclosed fence is preserved to EOF without splitting', () => {
  assert.deepEqual(splitSummaryParagraphs('```\na\n\nb'), ['```\na\n\nb']);
});

void test('display math ignores blank lines and preserves an unclosed block', () => {
  assert.deepEqual(splitSummaryParagraphs('a\n$$\n\nb\n$$\nc'), [
    'a\n$$\n\nb\n$$\nc',
  ]);
  assert.deepEqual(splitSummaryParagraphs('$$\na\n\nb'), ['$$\na\n\nb']);
});

void test('dollar signs inside code do not toggle math', () => {
  assert.deepEqual(splitSummaryParagraphs('```\n$$\n\n$$\n```\n\nx'), [
    '```\n$$\n\n$$\n```',
    'x',
  ]);
});

void test('code fences inside math do not toggle code state', () => {
  assert.deepEqual(splitSummaryParagraphs('$$\n```\n$$\n\nx'), [
    '$$\n```\n$$',
    'x',
  ]);
});

void test('LCS tie on equal alternatives removes from before first', () => {
  assert.deepEqual(compareSummaryParagraphs('P\n\nQ', 'Q\n\nP'), {
    segments: [
      { kind: 'removed', text: 'P' },
      { kind: 'equal', text: 'Q' },
      { kind: 'added', text: 'P' },
    ],
    added: 1,
    removed: 1,
    unchanged: 1,
    coarse: false,
  });
});

void test('counts paragraphs and keeps stable source order', () => {
  const diff = compareSummaryParagraphs('A\n\nB\n\nC', 'A\n\nX\n\nC\n\nD');
  assert.deepEqual(diff.segments, [
    { kind: 'equal', text: 'A' },
    { kind: 'removed', text: 'B' },
    { kind: 'added', text: 'X' },
    { kind: 'equal', text: 'C' },
    { kind: 'added', text: 'D' },
  ]);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.equal(diff.unchanged, 2);
  assert.equal(diff.coarse, false);
});

void test('large identical summaries stay all equal and non-coarse', () => {
  const paragraphs = Array.from(
    { length: 1000 },
    (_value, index) => `line ${index}`,
  );
  const text = paragraphs.join('\n\n');
  const diff = compareSummaryParagraphs(text, text);
  assert.equal(diff.coarse, false);
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
  assert.equal(diff.unchanged, 1000);
  assert.equal(diff.segments.length, 1000);
  assert.ok(diff.segments.every((segment) => segment.kind === 'equal'));
});

void test('equal prefix and suffix are stripped before the middle diff', () => {
  const before = [
    'P',
    ...Array.from({ length: 5 }, (_v, i) => `b${i}`),
    'S',
  ].join('\n\n');
  const after = [
    'P',
    ...Array.from({ length: 5 }, (_v, i) => `a${i}`),
    'S',
  ].join('\n\n');
  const diff = compareSummaryParagraphs(before, after);
  assert.equal(diff.unchanged, 2);
  assert.equal(diff.removed, 5);
  assert.equal(diff.added, 5);
  assert.equal(diff.coarse, false);
  assert.equal(diff.segments[0].kind, 'equal');
  assert.equal(diff.segments[0].text, 'P');
  assert.equal(diff.segments[diff.segments.length - 1].kind, 'equal');
  assert.equal(diff.segments[diff.segments.length - 1].text, 'S');
});

void test('middle cell product at the limit uses LCS, above it goes coarse', () => {
  const unique = (prefix: string, count: number) =>
    Array.from({ length: count }, (_v, i) => `${prefix}${i}`).join('\n\n');

  const atLimit = compareSummaryParagraphs(unique('b', 200), unique('a', 200));
  assert.equal(atLimit.coarse, false);
  assert.equal(atLimit.removed, 200);
  assert.equal(atLimit.added, 200);
  assert.equal(atLimit.unchanged, 0);

  const aboveLimit = compareSummaryParagraphs(
    unique('b', 201),
    unique('a', 201),
  );
  assert.equal(aboveLimit.coarse, true);
  assert.equal(aboveLimit.removed, 201);
  assert.equal(aboveLimit.added, 201);
  assert.equal(aboveLimit.unchanged, 0);
  assert.ok(
    aboveLimit.segments
      .slice(0, 201)
      .every((segment) => segment.kind === 'removed'),
  );
  assert.ok(
    aboveLimit.segments.slice(201).every((segment) => segment.kind === 'added'),
  );
});

void test('coarse fallback preserves shared prefix and suffix without discarding content', () => {
  const middleBefore = Array.from({ length: 201 }, (_v, i) => `before ${i}`);
  const middleAfter = Array.from({ length: 201 }, (_v, i) => `after ${i}`);
  const before = ['head', ...middleBefore, 'tail'].join('\n\n');
  const after = ['head', ...middleAfter, 'tail'].join('\n\n');
  const diff = compareSummaryParagraphs(before, after);
  assert.equal(diff.coarse, true);
  assert.equal(diff.unchanged, 2);
  assert.equal(diff.removed, 201);
  assert.equal(diff.added, 201);
  assert.equal(diff.segments[0].text, 'head');
  assert.equal(diff.segments[diff.segments.length - 1].text, 'tail');

  const rebuildBefore = diff.segments
    .filter((segment) => segment.kind !== 'added')
    .map((segment) => segment.text);
  const rebuildAfter = diff.segments
    .filter((segment) => segment.kind !== 'removed')
    .map((segment) => segment.text);
  assert.deepEqual(rebuildBefore, splitSummaryParagraphs(before));
  assert.deepEqual(rebuildAfter, splitSummaryParagraphs(after));
});

void test('segments rebuild both sides for a mixed diff', () => {
  const before = 'one\n\ntwo\n\nthree\n\nfour\n\nfive';
  const after = 'zero\n\none\n\nthree\n\nfour\n\nFIVE';
  const diff = compareSummaryParagraphs(before, after);
  const rebuildBefore = diff.segments
    .filter((segment) => segment.kind !== 'added')
    .map((segment) => segment.text);
  const rebuildAfter = diff.segments
    .filter((segment) => segment.kind !== 'removed')
    .map((segment) => segment.text);
  assert.deepEqual(rebuildBefore, splitSummaryParagraphs(before));
  assert.deepEqual(rebuildAfter, splitSummaryParagraphs(after));
  assert.equal(diff.coarse, false);
});

void test('paragraphs split around fences and math participate in the diff', () => {
  const diff = compareSummaryParagraphs(
    'intro\n\n```\ncode\n```',
    'intro\n\n$$\nmath\n$$',
  );
  assert.deepEqual(diff.segments, [
    { kind: 'equal', text: 'intro' },
    { kind: 'removed', text: '```\ncode\n```' },
    { kind: 'added', text: '$$\nmath\n$$' },
  ]);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.unchanged, 1);
  assert.equal(diff.coarse, false);
});
