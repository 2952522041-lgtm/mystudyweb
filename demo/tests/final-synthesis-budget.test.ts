import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reduceWithinBudget,
  utf8Size,
  SYNTHESIS_BUDGET,
} from '../lib/knowledge/hierarchical-synthesis.ts';

interface MarkerRecord {
  marker: string;
  content: string;
}

interface ReduceCall {
  identity: string;
  intermediate: boolean;
  records: unknown[];
}

function records(count: number, contentBytes: number): MarkerRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    marker: `source-${index}`,
    content: 'x'.repeat(contentBytes),
  }));
}

function markers(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as { marker?: unknown; markers?: unknown };
  if (typeof record.marker === 'string') return [record.marker];
  return Array.isArray(record.markers)
    ? record.markers.filter((marker): marker is string => typeof marker === 'string')
    : [];
}

function mockReducer(calls: ReduceCall[]) {
  return async (batch: unknown[], identity: string, intermediate: boolean): Promise<unknown> => {
    calls.push({ identity, intermediate, records: batch });
    const sourceMarkers = batch.flatMap(markers);
    return intermediate ? { markers: sourceMarkers, compact: true } : { markers: sourceMarkers, final: true };
  };
}

void test('sends a 28–35 KB payload directly to the final reducer once', async () => {
  const input = records(2, 14_000);
  const inputBytes = utf8Size(input);
  assert.ok(inputBytes >= 28_000 && inputBytes <= 35_000, `fixture is ${inputBytes} bytes`);
  const calls: ReduceCall[] = [];

  const result = await reduceWithinBudget({
    records: input,
    layer: 'course',
    identity: 'course',
    report() {},
    reduce: mockReducer(calls),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.intermediate, false);
  assert.deepEqual((result as { markers: string[] }).markers, ['source-0', 'source-1']);
});

void test('splits inputs above the final payload into <=24 KB intermediate batches before one final reduce', async () => {
  const input = records(3, 12_500);
  assert.ok(utf8Size(input) > SYNTHESIS_BUDGET.finalPayload);
  const calls: ReduceCall[] = [];

  const result = await reduceWithinBudget({
    records: input,
    layer: 'course',
    identity: 'course',
    report() {},
    reduce: mockReducer(calls),
  });

  const intermediateCalls = calls.filter(call => call.intermediate);
  const finalCalls = calls.filter(call => !call.intermediate);
  assert.ok(intermediateCalls.length >= 2);
  assert.ok(intermediateCalls.every(call => utf8Size(call.records) <= SYNTHESIS_BUDGET.payload));
  assert.equal(finalCalls.length, 1);
  assert.deepEqual((result as { markers: string[] }).markers, ['source-0', 'source-1', 'source-2']);
});

void test('rejects an indivisible record above the 24 KB batch ceiling even inside a larger input', async () => {
  const input = [
    { marker: 'oversized-source', content: 'x'.repeat(25_000) },
    { marker: 'other-source', content: 'y'.repeat(12_000) },
  ];
  assert.ok(utf8Size(input) > SYNTHESIS_BUDGET.finalPayload);
  const calls: ReduceCall[] = [];

  await assert.rejects(
    reduceWithinBudget({
      records: input,
      layer: 'course',
      identity: 'course',
      report() {},
      reduce: mockReducer(calls),
    }),
    /超预算的单个结构项/,
  );
  assert.equal(calls.length, 0);
});
