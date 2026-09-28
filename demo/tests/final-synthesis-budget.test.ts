import assert from 'node:assert/strict';
import test from 'node:test';
import { createKnowledgeProviderForSettings, createKnowledgeDigestCache } from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import { settings, reply } from './fixtures/hierarchical-synthesis.ts';

import {
  reduceWithinBudget,
  utf8Size,
  SYNTHESIS_BUDGET,
} from '../lib/knowledge/hierarchical-synthesis.ts';

interface MarkerRecord {
  marker: string;
  content: string;
}

void test('document provider does not expand a final-sized chunk payload into extra AI rounds', async () => {
  const chunkCalls: number[] = [];
  const summaries = [1, 2, 3].map(page => `page-${page}-` + 'x'.repeat(8500));
  const synthesisPrompts: string[] = [];
  const provider = createKnowledgeProviderForSettings(settings, async (_url, init) => {
    assert.equal(typeof init?.body, 'string');
    const body = JSON.parse(init!.body as string);
    assert.match(body.messages[0].content, /Serialize JSON compactly/);
    assert.match(body.messages[0].content, /keep all required facts/);
    const prompt: string = body.messages[1].content;
    const page = Number(/<page number="(\d+)"/.exec(prompt)?.[1] ?? 0);
    const output = reply('lecture', page || 1);
    if (prompt.startsWith('分析以下 PDF 分块')) {
      chunkCalls.push(page);
      output.sections[0]!.summary = summaries[page - 1]!;
    } else {
      synthesisPrompts.push(prompt);
    }
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(output)},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  }, createKnowledgeDigestCache(createMemoryStore()), createMemoryStore());
  const digest = await provider.analyzeDocument({documentId:'lecture',fingerprint:'final-sized',fileName:'lecture.pdf',pages:[1,2,3].map(page => `page ${page}\n` + '页面内容。'.repeat(1400))});
  assert.deepEqual(chunkCalls.sort((a,b) => a-b), [1,2,3]);
  assert.equal(synthesisPrompts.length, 1);
  for (const summary of summaries) assert.ok(synthesisPrompts[0]!.includes(summary));
  assert.ok(!digest.diagnostics?.some(event => event.layer === 'document' && event.action === 'split'));
  const timings = digest.diagnostics?.filter(event => event.action === 'request-timing') ?? [];
  assert.equal(timings.length, 4);
  for (const event of timings) {
    assert.equal(event.timing?.status, 'success');
    assert.ok((event.timing?.outputChars ?? 0) > 0);
    assert.ok((event.timing?.totalMs ?? -1) >= 0);
    assert.ok(!JSON.stringify(event.timing).includes(settings.apiKey));
  }
});

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
