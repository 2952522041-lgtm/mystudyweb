import assert from 'node:assert/strict';
import test from 'node:test';

import type { SourceReference } from '../lib/course-storage/types.ts';
import { groundSourceRanges } from '../lib/knowledge/ground-source-ranges.ts';

function source(documentId: string, fileName: string, pageStart: number, pageEnd = pageStart): SourceReference {
  return { documentId, fileName, pageStart, pageEnd, type: 'pdf' };
}

void test('splits a broad source at every known disjoint range without changing provenance', () => {
  const raw = {
    concepts: [{
      text: '原始事实不能被改写。',
      sources: [source('known', 'notes.pdf', 1, 38)],
    }],
    provenance: [source('known', 'notes.pdf', 1, 38)],
  };
  const before = structuredClone(raw);
  const result = groundSourceRanges(raw, [
    source('known', 'notes.pdf', 1, 17),
    source('known', 'notes.pdf', 19, 25),
    source('known', 'notes.pdf', 27, 38),
  ]);

  const grounded = result.raw as typeof raw;
  assert.deepEqual(grounded.concepts[0]?.sources, [
    source('known', 'notes.pdf', 1, 17),
    source('known', 'notes.pdf', 19, 25),
    source('known', 'notes.pdf', 27, 38),
  ]);
  assert.deepEqual(grounded.concepts[0]?.text, raw.concepts[0]?.text);
  assert.deepEqual(grounded.provenance, raw.provenance);
  assert.equal(result.splitCount, 1);
  assert.deepEqual(raw, before);
});

void test('merges overlapping allowed ranges and grounds nested source arrays', () => {
  const raw = {
    sections: [{
      sources: [source('known', 'notes.pdf', 16, 25)],
      children: [{ sources: [source('known', 'notes.pdf', 1, 30)] }],
    }],
  };
  const result = groundSourceRanges(raw, [
    source('known', 'notes.pdf', 1, 17),
    source('known', 'notes.pdf', 16, 17),
    source('known', 'notes.pdf', 19, 22),
    source('known', 'notes.pdf', 21, 25),
    source('known', 'notes.pdf', 26, 26),
    source('known', 'notes.pdf', 27, 38),
  ]);

  const grounded = result.raw as typeof raw;
  assert.deepEqual(grounded.sections[0]?.sources, [
    source('known', 'notes.pdf', 16, 17),
    source('known', 'notes.pdf', 19, 25),
  ]);
  assert.deepEqual(grounded.sections[0]?.children[0]?.sources, [
    source('known', 'notes.pdf', 1, 17),
    source('known', 'notes.pdf', 19, 30),
  ]);
  assert.equal(result.splitCount, 2);
});

void test('leaves unknown documents, unsupported ranges, and unsupported endpoints unchanged', () => {
  const raw = {
    concepts: [{
      sources: [
        source('known', 'notes.pdf', 18, 25),
        source('known', 'notes.pdf', 16, 26),
        source('known', 'notes.pdf', 40, 45),
        source('known', 'wrong.pdf', 1, 25),
        source('unknown', 'notes.pdf', 1, 38),
      ],
    }],
  };
  const before = structuredClone(raw);
  const result = groundSourceRanges(raw, [
    source('known', 'notes.pdf', 1, 17),
    source('known', 'notes.pdf', 19, 25),
  ]);

  assert.deepEqual(result.raw, raw);
  assert.equal(result.splitCount, 0);
  assert.deepEqual(raw, before);
});

void test('uses a unique allowed filename for missing model metadata and leaves provenance untouched', () => {
  const raw = {
    concepts: [{
      sources: [
        source('known', 'notes.pdf', 4, 6),
        { documentId: 'known', pageStart: 1, pageEnd: 20, type: 'pdf' },
      ],
    }],
    provenance: [source('known', 'notes.pdf', 1, 20)],
    text: ['sources', { pageStart: 1, pageEnd: 20 }],
  };
  const before = structuredClone(raw);
  const result = groundSourceRanges(raw, [
    source('known', 'notes.pdf', 1, 10),
    source('known', 'notes.pdf', 12, 20),
  ]);

  const grounded = result.raw as typeof raw;
  assert.deepEqual(grounded.concepts[0]?.sources, [
    source('known', 'notes.pdf', 4, 6),
    { documentId: 'known', pageStart: 1, pageEnd: 10, type: 'pdf' },
    { documentId: 'known', pageStart: 12, pageEnd: 20, type: 'pdf' },
  ]);
  assert.deepEqual(grounded.provenance, raw.provenance);
  assert.deepEqual(grounded.text, raw.text);
  assert.equal(result.splitCount, 1);
  assert.deepEqual(raw, before);
  assert.notStrictEqual(result.raw, raw);

  const ambiguous = { concepts: [{ sources: [{ documentId: 'known', pageStart: 1, pageEnd: 20, type: 'pdf' }] }] };
  const ambiguousResult = groundSourceRanges(ambiguous, [
    source('known', 'notes.pdf', 1, 10),
    source('known', 'other.pdf', 12, 20),
  ]);
  assert.deepEqual(ambiguousResult.raw, ambiguous);
  assert.equal(ambiguousResult.splitCount, 0);
});
