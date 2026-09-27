import assert from 'node:assert/strict';
import test from 'node:test';

import { intermediateOutputFitsBudget } from '../lib/knowledge/intermediate-budget.ts';

void test('accepts content at or below the normal 10 KB target', () => {
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 10_000, fullBytes: 23_999 }), true);
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 8_000, fullBytes: 24_000 }), true);
});

void test('always rejects output whose restored full form exceeds the payload ceiling', () => {
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 8_000, fullBytes: 24_001 }), false);
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 12_000, inputBytes: 40_000, fullBytes: 24_001 }), false);
});

void test('accepts above-target content when the next full result strictly shrinks', () => {
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 12_000, inputBytes: 20_000, fullBytes: 16_000 }), true);
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 12_000, inputBytes: 30_000, fullBytes: 24_000 }), true);
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 16_100, inputBytes: 23_682, fullBytes: 19_683 }), true);
});

void test('uses the exact strict-shrink boundary and rejects nonshrinking or unknown input', () => {
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 10_001, inputBytes: 20_001, fullBytes: 20_000 }), true);
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 10_001, inputBytes: 20_001, fullBytes: 20_001 }), false);
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 10_001, fullBytes: 12_000 }), false);
  assert.equal(intermediateOutputFitsBudget({ contentBytes: 10_001, inputBytes: 20_000, fullBytes: 20_000 }), false);
});

void test('rejects negative and non-finite byte measurements', () => {
  const valid = { contentBytes: 9_000, fullBytes: 9_000 };
  for (const measurement of [
    { ...valid, contentBytes: -1 },
    { ...valid, fullBytes: -1 },
    { ...valid, inputBytes: -1 },
    { ...valid, contentBytes: Number.NaN },
    { ...valid, fullBytes: Number.POSITIVE_INFINITY },
    { contentBytes: 10_001, inputBytes: Number.NaN, fullBytes: 12_000 },
  ]) {
    assert.equal(intermediateOutputFitsBudget(measurement), false);
  }
});
