import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectPreservedSections,
  replacePreservedSections,
  type PreservedPoint,
  type PreservedSection,
} from '../lib/knowledge/preserved-sections.ts';

/** Minimal valid section factory used across the tests. */
function section(overrides: Partial<PreservedSection> = {}): PreservedSection {
  return {
    title: 'Title',
    summary: 'Summary',
    pageStart: 1,
    ...overrides,
  };
}

function sparseArray<T>(length: number): T[] {
  const values: T[] = [];
  values.length = length;
  return values;
}

// ---------------------------------------------------------------------------
// collectPreservedSections: ordering
// ---------------------------------------------------------------------------

void test('collect keeps caller chunk order even when pages are out of order', () => {
  const chunks = [
    { sections: [section({ title: 'Page Five', pageStart: 5 })] },
    { sections: [section({ title: 'Page One', pageStart: 1 })] },
    { sections: [section({ title: 'Page Three', pageStart: 3 })] },
  ];

  const collected: PreservedSection[] = collectPreservedSections(chunks);

  assert.deepEqual(
    collected.map((item) => item.title),
    ['Page Five', 'Page One', 'Page Three'],
  );
});

void test('collect keeps per-chunk section order', () => {
  const collected = collectPreservedSections([
    {
      sections: [
        section({ title: 'First', pageStart: 1 }),
        section({ title: 'Second', pageStart: 2 }),
      ],
    },
    {
      sections: [
        section({ title: 'Third', pageStart: 3 }),
        section({ title: 'Fourth', pageStart: 4 }),
      ],
    },
  ]);

  assert.deepEqual(
    collected.map((item) => item.title),
    ['First', 'Second', 'Third', 'Fourth'],
  );
});

void test('collect never deduplicates identical titles', () => {
  const collected = collectPreservedSections([
    {
      sections: [
        section({ title: 'Overview', pageStart: 1 }),
        section({ title: 'Overview', pageStart: 9 }),
        section({ title: 'Overview', pageStart: 1 }),
      ],
    },
  ]);

  assert.equal(collected.length, 3);
  assert.deepEqual(
    collected.map((item) => item.pageStart),
    [1, 9, 1],
  );
});

void test('collect retains same-title sections on different pages', () => {
  const collected = collectPreservedSections([
    {
      sections: [
        section({ title: 'Intro', pageStart: 1, pageEnd: 2 }),
        section({ title: 'Intro', pageStart: 5, pageEnd: 6 }),
      ],
    },
  ]);

  assert.equal(collected.length, 2);
  assert.deepEqual(
    collected.map((item) => [item.title, item.pageStart, item.pageEnd]),
    [
      ['Intro', 1, 2],
      ['Intro', 5, 6],
    ],
  );
});

// ---------------------------------------------------------------------------
// collectPreservedSections: lossless copying
// ---------------------------------------------------------------------------

void test('collect preserves Unicode, formulas, tables and nested extensions exactly', () => {
  const original = {
    title: ' 公式与表格 ',
    summary: '日本語 — naïve café 😀\n第二行',
    pageStart: 3,
    pageEnd: 10,
    formula: '\\frac{a}{b} = \\sum_{i=0}^{n} x_i',
    table: '| 列 | 值 |\n| --- | --- |\n| α | 1 |\n| β | 2 |',
    custom: {
      nested: { list: [1, 'два', { deep: null }], date: new Date('2020-01-02T03:04:05.000Z') },
    },
  };

  const [collected] = collectPreservedSections([{ sections: [original] }]);

  assert.deepEqual(collected, original);
  // No whitespace/text normalization.
  assert.equal(collected.title, ' 公式与表格 ');
  assert.equal(collected.summary, original.summary);
  assert.equal(collected.formula, original.formula);
  assert.equal(collected.table, original.table);
  assert.deepEqual(collected.custom, original.custom);
});

void test('collect preserves optional extension fields on points', () => {
  const original = section({
    title: 'Points',
    pageStart: 2,
    points: [
      {
        text: '  Markdown **bold**  ',
        pageStart: 2,
        pageEnd: 3,
        source: 'chunk-7',
        latex: '$e^{i\\pi}+1=0$',
      },
      { text: '第二点', pageStart: 4 },
    ],
  });

  const [collected] = collectPreservedSections([{ sections: [original] }]);

  assert.deepEqual(collected.points, original.points);
  assert.equal(collected.points?.[0].text, '  Markdown **bold**  ');
  assert.equal(collected.points?.[0].latex, '$e^{i\\pi}+1=0$');
});

void test('collected sections share no mutable nested references with chunks', () => {
  const chunk = {
    sections: [
      section({
        title: 'Shared?',
        pageStart: 1,
        points: [{ text: 'point', pageStart: 1, meta: { tags: ['a'] } }],
        custom: { list: [1, 2, 3] },
      }),
    ],
  };

  const collected = collectPreservedSections([chunk]);
  const point = collected[0].points?.[0] as PreservedPoint & {
    meta: { tags: string[] };
  };
  const custom = collected[0].custom as { list: number[] };

  point.meta.tags.push('b');
  custom.list.push(4);
  collected[0].title = 'mutated';

  const originalPoint = (chunk.sections[0].points as Array<Record<string, unknown>>)[0];
  assert.deepEqual((originalPoint.meta as { tags: string[] }).tags, ['a']);
  assert.deepEqual((chunk.sections[0].custom as { list: number[] }).list, [1, 2, 3]);
  assert.equal(chunk.sections[0].title, 'Shared?');
});

// ---------------------------------------------------------------------------
// replacePreservedSections: shape and identity
// ---------------------------------------------------------------------------

void test('replace swaps in a fresh deep clone and preserves other fields by identity', () => {
  const keep = { nested: { value: 1 } };
  const raw: Record<string, unknown> = {
    id: 'digest-1',
    sections: [section({ title: 'model rewrite', pageStart: 99 })],
    keep,
  };
  const source: PreservedSection[] = [
    section({
      title: 'Original',
      pageStart: 1,
      points: [{ text: 'p', pageStart: 1, meta: { k: 1 } }],
    }),
  ];

  const output: { sections: PreservedSection[] } & typeof raw =
    replacePreservedSections(raw, source);

  assert.equal(output, raw, 'raw object identity is preserved');
  assert.equal(output.keep, keep, 'other fields keep identity');
  assert.deepEqual(output.sections, source);
  assert.notEqual(output.sections, source, 'sections array is cloned');
  assert.notEqual(output.sections[0], source[0], 'section objects are cloned');

  // Mutating the output must not leak back into the source sections.
  assert.ok(output.sections[0].points);
  assert.ok(source[0].points);
  (output.sections[0].points[0].meta as { k: number }).k = 42;
  assert.equal((source[0].points[0].meta as { k: number }).k, 1);
});

void test('replace discards malformed existing model sections', () => {
  const raw: Record<string, unknown> = { sections: 'not-an-array' };
  replacePreservedSections(raw, [section({ title: 'Restored' })]);

  assert.deepEqual(raw.sections, [section({ title: 'Restored' })]);
});

void test('replace is idempotent and restores originals after model changes', () => {
  const original = collectPreservedSections([
    {
      sections: [
        section({ title: 'A', pageStart: 1 }),
        section({ title: 'B', pageStart: 2 }),
      ],
    },
  ]);
  const raw: Record<string, unknown> = { sections: [] };

  replacePreservedSections(raw, original);
  assert.deepEqual(
    (raw.sections as PreservedSection[]).map((item) => item.title),
    ['A', 'B'],
  );

  // Simulate the model rewriting sections between calls.
  raw.sections = [section({ title: 'model', pageStart: 50 })];
  replacePreservedSections(raw, original);

  assert.equal((raw.sections as PreservedSection[]).length, 2);
  assert.deepEqual(
    (raw.sections as PreservedSection[]).map((item) => item.title),
    ['A', 'B'],
  );

  // A repeat call with the same source does not append or duplicate.
  replacePreservedSections(raw, original);
  assert.equal((raw.sections as PreservedSection[]).length, 2);
});

// ---------------------------------------------------------------------------
// pageEnd shape handling
// ---------------------------------------------------------------------------

void test('section pageEnd absent, undefined and null are accepted and keep their shape', () => {
  const absent = section({ title: 'absent', pageStart: 4 });
  const undef = { ...section({ title: 'undef', pageStart: 4 }), pageEnd: undefined };
  const nul = { ...section({ title: 'null', pageStart: 4 }), pageEnd: null };

  const collected = collectPreservedSections([{ sections: [absent, undef, nul] }]);

  assert.equal(Object.prototype.hasOwnProperty.call(collected[0], 'pageEnd'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(collected[1], 'pageEnd'), true);
  assert.equal(collected[1].pageEnd, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(collected[2], 'pageEnd'), true);
  assert.equal(collected[2].pageEnd, null);
});

void test('point pageEnd absent, undefined and null are accepted and keep their shape', () => {
  const source = section({
    title: 'points',
    pageStart: 4,
    points: [
      { text: 'absent', pageStart: 4 },
      { text: 'undefined', pageStart: 4, pageEnd: undefined },
      { text: 'null', pageStart: 4, pageEnd: null },
    ],
  });

  const [collected] = collectPreservedSections([{ sections: [source] }]);
  const points = collected.points as PreservedPoint[];

  assert.equal(Object.prototype.hasOwnProperty.call(points[0], 'pageEnd'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(points[1], 'pageEnd'), true);
  assert.equal(points[1].pageEnd, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(points[2], 'pageEnd'), true);
  assert.equal(points[2].pageEnd, null);
});

void test('replace preserves absent/undefined/null pageEnd shape', () => {
  const source = [
    section({ title: 'absent', pageStart: 2 }),
    { ...section({ title: 'undef', pageStart: 2 }), pageEnd: undefined },
    { ...section({ title: 'null', pageStart: 2 }), pageEnd: null },
  ];
  const raw: Record<string, unknown> = {};

  const output = replacePreservedSections(raw, source);

  assert.equal(Object.prototype.hasOwnProperty.call(output.sections[0], 'pageEnd'), false);
  assert.equal(output.sections[1].pageEnd, undefined);
  assert.equal(output.sections[2].pageEnd, null);
});

void test('empty points arrays and points outside the section envelope are valid', () => {
  const collected = collectPreservedSections([
    {
      sections: [
        section({ title: 'empty points', pageStart: 1, pageEnd: 1, points: [] }),
        section({
          title: 'expanded upstream',
          pageStart: 1,
          pageEnd: 1,
          points: [
            { text: 'later', pageStart: 8, pageEnd: 12 },
            { text: 'earlier', pageStart: 1 },
          ],
        }),
      ],
    },
  ]);

  assert.deepEqual(collected[0].points, []);
  assert.deepEqual(collected[1].points, [
    { text: 'later', pageStart: 8, pageEnd: 12 },
    { text: 'earlier', pageStart: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// Invalid input: collect
// ---------------------------------------------------------------------------

void test('collect rejects non-array, empty, and non-object chunks', () => {
  assert.throws(() => collectPreservedSections(undefined as never), TypeError);
  assert.throws(() => collectPreservedSections(null as never), TypeError);
  assert.throws(() => collectPreservedSections({} as never), TypeError);
  assert.throws(() => collectPreservedSections([]), TypeError);
  assert.throws(() => collectPreservedSections([null]), TypeError);
  assert.throws(() => collectPreservedSections([[section()]]), TypeError);
  assert.throws(() => collectPreservedSections(['text']), TypeError);
});

void test('collect rejects missing, non-array and empty chunk sections', () => {
  assert.throws(() => collectPreservedSections([{}]), /sections/);
  assert.throws(() => collectPreservedSections([{ sections: 'nope' }]), /sections/);
  assert.throws(() => collectPreservedSections([{ sections: [] }]), /nonempty/);
  assert.throws(
    () => collectPreservedSections([{ sections: [section()] }, { sections: [] }]),
    /chunks\[1\]\.sections/,
  );
});

void test('collect rejects malformed sections with location labels', () => {
  assert.throws(
    () => collectPreservedSections([{ sections: [42] }]),
    /chunks\[0\]\.sections\[0\]/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ title: '' })] }]),
    /title/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ title: '   ' })] }]),
    /title/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ summary: '\t\n' })] }]),
    /summary/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ title: 7 as never })] }]),
    /title/,
  );
});

void test('collect rejects malformed points', () => {
  assert.throws(
    () =>
      collectPreservedSections([
        { sections: [section({ points: 'nope' as never })] },
      ]),
    /points/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ points: [null as never] })] }]),
    /points\[0\]/,
  );
  assert.throws(
    () =>
      collectPreservedSections([
        { sections: [section({ points: [{ text: ' ', pageStart: 1 }] })] },
      ]),
    /points\[0\]\.text/,
  );
  assert.throws(
    () =>
      collectPreservedSections([
        { sections: [section({ points: [{ text: 'x', pageStart: 0 }] })] },
      ]),
    /points\[0\]\.pageStart/,
  );
});

// ---------------------------------------------------------------------------
// Invalid input: page ranges
// ---------------------------------------------------------------------------

void test('collect rejects bad section page ranges', () => {
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ pageStart: 0 })] }]),
    /pageStart/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ pageStart: -3 })] }]),
    /pageStart/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ pageStart: 1.5 })] }]),
    /pageStart/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ pageStart: NaN })] }]),
    /pageStart/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ pageStart: 5, pageEnd: 4 })] }]),
    /pageEnd/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ pageStart: 5, pageEnd: 0 })] }]),
    /pageEnd/,
  );
  assert.throws(
    () => collectPreservedSections([{ sections: [section({ pageStart: 5, pageEnd: 2.5 })] }]),
    /pageEnd/,
  );
  assert.throws(
    () =>
      collectPreservedSections([
        { sections: [section({ pageStart: 5, pageEnd: '6' as never })] },
      ]),
    /pageEnd/,
  );
  assert.throws(
    () =>
      collectPreservedSections([
        { sections: [section({ pageStart: 5, pageEnd: false as never })] },
      ]),
    /pageEnd/,
  );
});

void test('collect rejects bad point page ranges', () => {
  assert.throws(
    () =>
      collectPreservedSections([
        {
          sections: [
            section({ points: [{ text: 'x', pageStart: 4, pageEnd: 3 }] }),
          ],
        },
      ]),
    /points\[0\]\.pageEnd/,
  );
  assert.throws(
    () =>
      collectPreservedSections([
        {
          sections: [
            section({ points: [{ text: 'x', pageStart: 4, pageEnd: '4' as never }] }),
          ],
        },
      ]),
    /points\[0\]\.pageEnd/,
  );
});

// ---------------------------------------------------------------------------
// Invalid input: replace, and failure atomicity
// ---------------------------------------------------------------------------

void test('replace rejects bad raw, bad sections and bad section entries', () => {
  const good = [section()];

  assert.throws(() => replacePreservedSections(null as never, good), TypeError);
  assert.throws(() => replacePreservedSections([] as never, good), TypeError);
  assert.throws(() => replacePreservedSections('x' as never, good), TypeError);
  assert.throws(() => replacePreservedSections({}, []), /nonempty/);
  assert.throws(
    () => replacePreservedSections({}, 'nope' as never),
    /sections/,
  );
  assert.throws(
    () => replacePreservedSections({}, [section({ title: '' })]),
    /sections\[0\]\.title/,
  );
  assert.throws(
    () =>
      replacePreservedSections({}, [
        section({ title: 'ok' }),
        section({ pageStart: 0 }),
      ]),
    /sections\[1\]\.pageStart/,
  );
});

void test('failed replacement leaves the previous output untouched', () => {
  const kept = [section({ title: 'before', summary: 'kept', pageStart: 1 })];
  const raw: Record<string, unknown> = { sections: kept };

  assert.throws(
    () =>
      replacePreservedSections(raw, [
        section({ title: 'would replace', pageStart: 2 }),
        section({ title: '   ', pageStart: 3 }),
      ]),
    TypeError,
  );

  assert.equal(raw.sections, kept, 'sections reference is unchanged');
  assert.deepEqual(raw.sections, [
    section({ title: 'before', summary: 'kept', pageStart: 1 }),
  ]);
});

void test('failed replacement from bad raw or bad points leaves output untouched', () => {
  const kept = [section({ title: 'before', pageStart: 1 })];
  const raw: Record<string, unknown> = { sections: kept };

  assert.throws(() => replacePreservedSections(raw, []), TypeError);
  assert.throws(
    () =>
      replacePreservedSections(raw, [
        section({ points: [{ text: '', pageStart: 1 }] }),
      ]),
    TypeError,
  );
  assert.equal(raw.sections, kept);
});

// ---------------------------------------------------------------------------
// Sparse array holes are visited as undefined and rejected, never skipped
// ---------------------------------------------------------------------------

void test('collect rejects sparse chunks instead of returning an empty array', () => {
  assert.throws(
    () => collectPreservedSections(sparseArray<unknown>(1)),
    /chunks\[0\]/,
  );

  const sparseChunks: unknown[] = [];
  sparseChunks.length = 2;
  sparseChunks[1] = { sections: [section({ title: 'only', pageStart: 1 })] };
  assert.throws(() => collectPreservedSections(sparseChunks), /chunks\[0\]/);
});

void test('collect rejects sparse chunk sections and points with location labels', () => {
  assert.throws(
    () =>
      collectPreservedSections([
        { sections: sparseArray<PreservedSection>(1) },
      ]),
    /chunks\[0\]\.sections\[0\]/,
  );

  const sparseSections: PreservedSection[] = [
    section({ title: 'first', pageStart: 1 }),
  ];
  sparseSections.length = 2; // hole at index 1
  assert.throws(
    () => collectPreservedSections([{ sections: sparseSections }]),
    /chunks\[0\]\.sections\[1\]/,
  );

  assert.throws(
    () =>
      collectPreservedSections([
        { sections: [section({ points: sparseArray<PreservedPoint>(1) })] },
      ]),
    /chunks\[0\]\.sections\[0\]\.points\[0\]/,
  );

  const sparsePoints: PreservedPoint[] = [{ text: 'first', pageStart: 1 }];
  sparsePoints.length = 2; // hole at index 1
  assert.throws(
    () =>
      collectPreservedSections([
        { sections: [section({ points: sparsePoints })] },
      ]),
    /chunks\[0\]\.sections\[0\]\.points\[1\]/,
  );
});

void test('replace rejects sparse sections and leaves previous output untouched', () => {
  const kept = [section({ title: 'before', summary: 'kept', pageStart: 1 })];
  const raw: Record<string, unknown> = { sections: kept };

  assert.throws(
    () => replacePreservedSections(raw, sparseArray<PreservedSection>(1)),
    /sections\[0\]/,
  );
  assert.equal(raw.sections, kept, 'sections reference is unchanged');

  const mixed: PreservedSection[] = [section({ title: 'first', pageStart: 1 })];
  mixed.length = 2; // hole at index 1, after a valid section
  assert.throws(
    () => replacePreservedSections(raw, mixed),
    /sections\[1\]/,
  );
  assert.equal(raw.sections, kept, 'still unchanged after a later-hole failure');
  assert.deepEqual(raw.sections, [
    section({ title: 'before', summary: 'kept', pageStart: 1 }),
  ]);
});

void test('clone failures leave the previous output and supplied sections untouched', () => {
  const kept = [section({ title: 'before' })];
  const raw: Record<string, unknown> = { sections: kept };
  const uncloneable = section({ extension: () => 'not cloneable' });
  const supplied = [section({ title: 'valid first' }), uncloneable];

  assert.throws(() => replacePreservedSections(raw, supplied), { name: 'DataCloneError' });
  assert.equal(raw.sections, kept);
  assert.equal(supplied[1], uncloneable);
  assert.equal(typeof supplied[1].extension, 'function');
});
