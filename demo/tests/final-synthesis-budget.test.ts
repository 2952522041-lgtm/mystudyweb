import assert from 'node:assert/strict';
import test from 'node:test';
import { createKnowledgeProviderForSettings, createKnowledgeDigestCache } from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import { settings, reply } from './fixtures/hierarchical-synthesis.ts';

import {
  reduceWithinBudget,
  synthesisSources,
  utf8Size,
  SYNTHESIS_BUDGET,
  type SynthesisDiagnostic,
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

for (const variant of ['fast', 'deep', 'fast-with-glossary'] as const) {
  void test(`document provider uses the larger final budget only for fast mode without glossary: ${variant}`, async () => {
    const synthesisPrompts: string[] = [];
    const summaries = [1, 2, 3].map(page => `source-${page}-` + 'x'.repeat(14_000));
    const provider = createKnowledgeProviderForSettings({ ...settings, generationMode: variant === 'deep' ? 'deep' : 'fast' }, async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      const prompt: string = body.messages[1].content;
      const page = Number(/<page number="(\d+)"/.exec(prompt)?.[1] ?? 0);
      const output = reply('lecture', page || 1);
      if (prompt.startsWith('分析以下 PDF 分块')) output.sections[0]!.summary = summaries[page - 1]!;
      else {
        synthesisPrompts.push(prompt);
        const records = JSON.parse(prompt.split('\n')[prompt.startsWith('归并文档') ? 2 : 1]!);
        const allowed = synthesisSources(records, {documentId:'lecture',fileName:'lecture.pdf',pageStart:1,type:'pdf'});
        output.sections[0]!.pageStart = allowed[0]!.pageStart;
        output.sections[0]!.pageEnd = allowed[0]!.pageEnd ?? allowed[0]!.pageStart;
        output.concepts[0]!.sources = allowed.map(source => ({...source, pageEnd:source.pageEnd ?? source.pageStart, type:'pdf' as const}));
      }
      return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(output)},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
    }, createKnowledgeDigestCache(createMemoryStore()), createMemoryStore());
    const digest = await provider.analyzeDocument({
      documentId:'lecture', fingerprint:`larger-budget-${variant}`, fileName:'lecture.pdf',
      pages:[1,2,3].map(page => `page ${page}\n` + '页面内容。'.repeat(1400)),
      ...(variant === 'fast-with-glossary' ? { glossary: { schemaVersion:1 as const, version:1, entries:[{source:'source',target:'来源',forbidden:[],note:''}] } } : {}),
    });
    if (variant === 'fast') {
      assert.equal(synthesisPrompts.length, 1);
      for (const summary of summaries) assert.ok(synthesisPrompts[0]!.includes(summary));
      assert.deepEqual(digest.sections.map(section => section.summary), summaries);
      assert.ok(!digest.diagnostics?.some(event => event.layer === 'document' && event.action === 'split'));
    } else {
      assert.ok(synthesisPrompts.length > 1);
      assert.ok(digest.diagnostics?.some(event => event.layer === 'document' && event.action === 'split'));
    }
  });
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

// Configurable final thresholds preserve the existing default behavior above.
type Layer = 'document' | 'course';

interface Provenance {
  documentId: string;
  fileName: string;
  pageStart: number;
  pageEnd: number;
  type: 'pdf';
}

interface LedgerRecord {
  id: string;
  marker: string;
  provenance: Provenance[];
  text: string;
  formula?: string;
  table?: string;
}

interface BudgetReduceCall {
  records: unknown[];
  identity: string;
  intermediate: boolean;
}

interface Tracker {
  calls: BudgetReduceCall[];
  reports: SynthesisDiagnostic[];
  report: (diagnostic: SynthesisDiagnostic) => void;
}

function tracker(): Tracker {
  const calls: BudgetReduceCall[] = [];
  const reports: SynthesisDiagnostic[] = [];
  return {
    calls,
    reports,
    report: (diagnostic) => {
      reports.push(diagnostic);
    },
  };
}

/**
 * Builds whole ledger records whose JSON payload hits `targetBytes` exactly.
 * Appending one ASCII character to `text` always adds exactly one UTF-8 byte,
 * so the resulting array can straddle a threshold by a single byte.
 */
function buildFixture(targetBytes: number, count: number, withFormula = false): LedgerRecord[] {
  const records: LedgerRecord[] = Array.from({ length: count }, (_, index) => ({
    id: `record-${index}`,
    marker: `marker-${index}`,
    provenance: [
      {
        documentId: `doc-${index}`,
        fileName: `file-${index}.pdf`,
        pageStart: index + 1,
        pageEnd: index + 2,
        type: 'pdf' as const,
      },
    ],
    text: '',
  }));
  const first = records[0];
  if (withFormula && first) {
    first.marker = '∑-marker-α';
    first.formula = '\\sum_{i=1}^{n} x_i = \\frac{α}{β}';
    first.table = '| a | b |\n| - | - |\n| 一 | 二 |';
  }
  const remaining = targetBytes - utf8Size(records);
  assert.ok(remaining >= count, `target ${targetBytes} is too small for ${count} records`);
  const base = Math.floor(remaining / count);
  const extra = remaining - base * count;
  records.forEach((record, index) => {
    record.text = 'x'.repeat(base + (index < extra ? 1 : 0));
  });
  assert.equal(utf8Size(records), targetBytes, 'fixture must hit the exact byte target');
  return records;
}

/** Emits one compact digest per batch that survives repeated reduction rounds. */
function compactRecord(records: unknown[]): { markers: string[] } {
  const markers = records.flatMap((record) => {
    const value = record as { marker?: string; markers?: string[] };
    return value.markers ?? (value.marker === undefined ? [] : [value.marker]);
  });
  return { markers };
}

function byteSequence(calls: BudgetReduceCall[]): string[] {
  return calls
    .map((call) => `${call.identity}:${call.intermediate}`)
    .sort((left, right) => left.localeCompare(right));
}

class RecoverableSynthesisError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecoverableSynthesisError';
    this.code = code;
  }
}

void test('finalPayloadLimit sends complete records to exactly one final callback and counts UTF-8 bytes', async () => {
  const fixture = buildFixture(44000, 3, true);
  assert.equal(utf8Size(fixture), 44000);
  assert.ok(
    utf8Size(fixture) > JSON.stringify(fixture).length,
    'fixture must contain multi-byte UTF-8 so byte counting is observable',
  );

  const { calls, reports, report } = tracker();
  const result = await reduceWithinBudget({
    records: fixture,
    layer: 'document',
    identity: 'document',
    report,
    finalPayloadLimit: 52000,
    reduce: async (records, identity, intermediate) => {
      calls.push({ records, identity, intermediate });
      return { identity, count: records.length };
    },
  });

  assert.equal(calls.length, 1, 'a payload under the chosen limit must not be reduced');
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.intermediate, false);
  assert.equal(call.identity, 'document/final');
  assert.deepEqual(call.records, fixture, 'payload, markers, provenance and order stay intact');
  assert.deepEqual(result, { identity: 'document/final', count: fixture.length });
  assert.deepEqual(reports, []);
});

void test('omitted and explicit-undefined finalPayloadLimit keep the 36000 default, matching explicit 36000', async () => {
  const fixture = buildFixture(44000, 3, true);

  const run = async (payloadOption: 'omitted' | 'undefined' | number) => {
    const { calls, reports, report } = tracker();
    const base = {
      records: fixture,
      layer: 'document' as Layer,
      identity: 'document',
      report,
      reduce: async (records: unknown[], identity: string, intermediate: boolean) => {
        calls.push({ records, identity, intermediate });
        return compactRecord(records);
      },
    };
    const result = payloadOption === 'omitted'
      ? await reduceWithinBudget(base)
      : payloadOption === 'undefined'
        ? await reduceWithinBudget({ ...base, finalPayloadLimit: undefined })
        : await reduceWithinBudget({ ...base, finalPayloadLimit: payloadOption });
    return { calls, reports, result };
  };

  const omitted = await run('omitted');
  const undefinedOption = await run('undefined');
  const explicit = await run(SYNTHESIS_BUDGET.finalPayload);

  assert.ok(omitted.calls.some((call) => call.intermediate), 'default path must reduce above 36000 bytes');
  assert.equal(omitted.calls.filter((call) => !call.intermediate).length, 1);

  const splitReports = omitted.reports.filter((entry) => entry.action === 'split');
  assert.equal(splitReports.length, 1);
  const [splitReport] = splitReports;
  assert.ok(splitReport);
  assert.equal(splitReport.limit, SYNTHESIS_BUDGET.payload);

  assert.deepEqual(byteSequence(omitted.calls), byteSequence(undefinedOption.calls));
  assert.deepEqual(omitted.result, undefinedOption.result);
  assert.deepEqual(byteSequence(omitted.calls), byteSequence(explicit.calls));
  assert.deepEqual(omitted.result, explicit.result);
});

void test('a chosen 52000 limit finalizes after one intermediate round once digests total 40-50KB', async () => {
  const fixture = buildFixture(54000, 3, false);
  assert.ok(utf8Size(fixture) > 52000);
  for (const record of fixture)
    assert.ok(
      utf8Size([record]) <= SYNTHESIS_BUDGET.payload,
      'each source record must fit the 24000 intermediate packing limit',
    );

  const digestText = 14500;
  const { calls, reports, report } = tracker();
  const result = await reduceWithinBudget({
    records: fixture,
    layer: 'document',
    identity: 'document',
    report,
    finalPayloadLimit: 52000,
    reduce: async (records, identity, intermediate) => {
      calls.push({ records, identity, intermediate });
      if (intermediate) {
        const markers = records.map((record) => (record as LedgerRecord).marker);
        const sources = records.flatMap((record) => (record as LedgerRecord).provenance);
        return { kind: 'digest', markers, sources, text: 'z'.repeat(digestText) };
      }
      return {
        kind: 'final',
        markers: records.flatMap((record) => (record as { markers: string[] }).markers),
        sources: records.flatMap((record) => (record as { sources: Provenance[] }).sources),
      };
    },
  });

  const intermediateCalls = calls.filter((call) => call.intermediate);
  const finalCalls = calls.filter((call) => !call.intermediate);
  assert.equal(intermediateCalls.length, 3, 'one intermediate callback per packed batch');
  assert.equal(finalCalls.length, 1, 'exactly one final callback');
  const [finalCall] = finalCalls;
  assert.ok(finalCall);
  assert.ok(
    utf8Size(finalCall.records) > SYNTHESIS_BUDGET.finalPayload,
    'the digest total must exceed the old 36000 default',
  );
  assert.ok(utf8Size(finalCall.records) >= 40000);
  assert.ok(utf8Size(finalCall.records) <= 50000);

  const splitReports = reports.filter((entry) => entry.action === 'split');
  assert.equal(splitReports.length, 1, 'no unnecessary second reduction round');

  const expectedMarkers = fixture.map((record) => record.marker).sort((left, right) => left.localeCompare(right));
  const resultRecord = result as { markers: string[]; sources: Provenance[] };
  assert.deepEqual([...resultRecord.markers].sort((left, right) => left.localeCompare(right)), expectedMarkers);
  assert.deepEqual(resultRecord.sources, fixture.flatMap((record) => record.provenance));
});

void test('recoverable final failures split without losing whole records, markers, or ranges', async () => {
  const fixture = buildFixture(45000, 3, true);
  assert.ok(utf8Size(fixture) > SYNTHESIS_BUDGET.finalPayload);
  assert.ok(utf8Size(fixture) < 52000);

  const cases: Array<{
    name: string;
    error: RecoverableSynthesisError;
    denied: (payloadBytes: number, intermediate: boolean) => boolean;
  }> = [
    {
      name: 'full-message overhead',
      error: new RecoverableSynthesisError('context_overflow', '模拟：完整消息超出本地预算'),
      denied: (payloadBytes, intermediate) => !intermediate && payloadBytes + 22000 > SYNTHESIS_BUDGET.document,
    },
    {
      name: 'provider context overflow',
      error: new RecoverableSynthesisError('context_overflow', '模拟：服务商拒绝较大的最终请求'),
      denied: (payloadBytes, intermediate) => !intermediate && payloadBytes > 40000,
    },
    {
      name: 'truncated output',
      error: new RecoverableSynthesisError('truncated', '模拟：模型输出被截断'),
      denied: (payloadBytes, intermediate) => !intermediate && payloadBytes > 36000,
    },
  ];

  for (const scenario of cases) {
    const { calls, reports, report } = tracker();
    const result = await reduceWithinBudget({
      records: fixture,
      layer: 'document',
      identity: 'document',
      report,
      shouldSplit: (error) => error instanceof RecoverableSynthesisError,
      finalPayloadLimit: 52000,
      reduce: async (records, identity, intermediate) => {
        calls.push({ records, identity, intermediate });
        if (scenario.denied(utf8Size(records), intermediate)) throw scenario.error;
        if (intermediate)
          return {
            markers: records.map((record) => (record as LedgerRecord).marker),
            sources: records.flatMap((record) => (record as LedgerRecord).provenance),
            digest: true,
          };
        return {
          markers: records.flatMap((record) => (record as { markers: string[] }).markers),
          sources: records.flatMap((record) => (record as { sources: Provenance[] }).sources),
        };
      },
    });

    const [firstCall] = calls;
    assert.ok(firstCall, scenario.name);
    assert.equal(firstCall.intermediate, false);
    assert.deepEqual(firstCall.records, fixture);

    assert.ok(
      calls.filter((call) => call.intermediate).length >= 2,
      `${scenario.name}: the denial must trigger the bounded splitting fallback`,
    );
    assert.ok(
      reports.some((entry) => entry.action === 'split'),
      `${scenario.name}: the split must be reported`,
    );

    const seen = calls.filter((call) => call.intermediate).flatMap((call) => call.records);
    for (const original of fixture)
      assert.ok(
        seen.some((record) => JSON.stringify(record) === JSON.stringify(original)),
        `${scenario.name}: record ${original.id} must be passed whole, never string-sliced`,
      );

    const expectedMarkers = fixture.map((record) => record.marker).sort((left, right) => left.localeCompare(right));
    const resultRecord = result as { markers: string[]; sources: Provenance[] };
    assert.deepEqual([...resultRecord.markers].sort((left, right) => left.localeCompare(right)), expectedMarkers);
    assert.deepEqual(resultRecord.sources, fixture.flatMap((record) => record.provenance));
  }
});

void test('invalid finalPayloadLimit values reject with RangeError before any report or reduce call', async () => {
  const fixture = buildFixture(30000, 2, false);
  const invalid: Array<{ label: string; value: unknown }> = [
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'zero', value: 0 },
    { label: 'negative', value: -1 },
    { label: 'below payload', value: 23999 },
    { label: 'above layer maximum', value: 64001 },
    { label: 'fraction', value: 24000.5 },
    { label: 'numeric string', value: '52000' },
    { label: 'null', value: null },
    { label: 'boolean', value: true },
  ];

  for (const { label, value } of invalid) {
    let reportCalls = 0;
    let reduceCalls = 0;
    const promise = reduceWithinBudget({
      records: fixture,
      layer: 'document',
      identity: 'document',
      report: () => {
        reportCalls += 1;
      },
      finalPayloadLimit: value as number,
      reduce: async () => {
        reduceCalls += 1;
        return {};
      },
    });
    await assert.rejects(promise, RangeError, `expected RangeError for ${label}`);
    assert.equal(reportCalls, 0, `report must not run for ${label}`);
    assert.equal(reduceCalls, 0, `reduce must not run for ${label}`);
  }
});

void test('boundary finalPayloadLimit values are accepted and steer the final-vs-intermediate decision', async () => {
  const fixture = buildFixture(30000, 2, false);
  assert.ok(utf8Size(fixture) > SYNTHESIS_BUDGET.payload);
  assert.ok(utf8Size(fixture) < SYNTHESIS_BUDGET.finalPayload);

  for (const limit of [24000, 36000, 52000, 64000]) {
    const { calls, report } = tracker();
    await reduceWithinBudget({
      records: fixture,
      layer: 'document',
      identity: 'document',
      report,
      finalPayloadLimit: limit,
      reduce: async (records, identity, intermediate) => {
        calls.push({ records, identity, intermediate });
        if (intermediate) return compactRecord(records);
        return { identity, count: records.length };
      },
    });
    assert.equal(calls.filter((call) => !call.intermediate).length, 1, `limit ${limit}: exactly one final call`);
    if (limit === SYNTHESIS_BUDGET.payload)
      assert.ok(calls.some((call) => call.intermediate), 'the 24000 boundary must still reduce first');
    else assert.equal(calls.length, 1, `limit ${limit} must finalize directly`);
  }
});

void test('the course layer applies its own SYNTHESIS_BUDGET maximum', async () => {
  const fixture = buildFixture(30000, 2, false);
  let reduceCalls = 0;
  await reduceWithinBudget({
    records: fixture,
    layer: 'course',
    identity: 'course',
    report: () => {},
    finalPayloadLimit: SYNTHESIS_BUDGET.course,
    reduce: async () => {
      reduceCalls += 1;
      return {};
    },
  });
  assert.equal(reduceCalls, 1);
  await assert.rejects(
    reduceWithinBudget({
      records: fixture,
      layer: 'course',
      identity: 'course',
      report: () => {},
      finalPayloadLimit: SYNTHESIS_BUDGET.course + 1,
      reduce: async () => {
        reduceCalls += 1;
        return {};
      },
    }),
    RangeError,
  );
  assert.equal(reduceCalls, 1, 'an invalid course limit must not reach reduce');
});

void test('the UTF-8 threshold is inclusive, while one byte above starts intermediate reduction', async () => {
  const exact = buildFixture(52000, 3, false);
  assert.equal(utf8Size(exact), 52000);
  const exactTracker = tracker();
  await reduceWithinBudget({
    records: exact,
    layer: 'document',
    identity: 'document',
    report: exactTracker.report,
    finalPayloadLimit: 52000,
    reduce: async (records, identity, intermediate) => {
      exactTracker.calls.push({ records, identity, intermediate });
      return {};
    },
  });
  const [exactCall] = exactTracker.calls;
  assert.ok(exactCall);
  assert.equal(exactTracker.calls.length, 1, 'exactly 52000 bytes must finalize in one call');
  assert.equal(exactCall.intermediate, false);

  const over = buildFixture(52001, 3, false);
  assert.equal(utf8Size(over), 52001);
  const overTracker = tracker();
  await reduceWithinBudget({
    records: over,
    layer: 'document',
    identity: 'document',
    report: overTracker.report,
    finalPayloadLimit: 52000,
    reduce: async (records, identity, intermediate) => {
      overTracker.calls.push({ records, identity, intermediate });
      if (intermediate) return compactRecord(records);
      return {};
    },
  });
  assert.ok(overTracker.calls.some((call) => call.intermediate), '52001 bytes must reduce first');
  assert.equal(overTracker.calls.filter((call) => !call.intermediate).length, 1);
  assert.ok(overTracker.reports.some((entry) => entry.action === 'split'));
});
