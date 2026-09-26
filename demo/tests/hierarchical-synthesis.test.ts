import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createKnowledgeProviderForSettings,
  createKnowledgeDigestCache,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import type { DocumentDigest } from '../lib/course-storage/types.ts';
import {
  reduceWithinBudget,
  synthesisCacheKey,
  synthesisRecords,
  synthesisSources,
  SYNTHESIS_BUDGET,
  utf8Size,
  type SynthesisDiagnostic,
} from '../lib/knowledge/hierarchical-synthesis.ts';
import { MemoryCourseStorage } from '../lib/course-storage/memory-course-storage.ts';
import { buildPdfChunks } from '../lib/knowledge/pdf-chunks.ts';
import {
  applyAiCourseKnowledge,
  emptyCourseKnowledge,
  removeDocumentContribution,
} from '../lib/knowledge/course-merger.ts';
import {
  renderCourseSummary,
  renderDocumentSummary,
} from '../lib/knowledge/artifact-renderer.ts';
import { knowledgeStageMessage } from '../lib/knowledge/synthesis-progress.ts';
import {
  formula,
  table,
  paperPages,
  lecturePages,
  settings,
  reply,
  legacyLongDigest,
  source,
} from './fixtures/hierarchical-synthesis.ts';

function mock(
  options: {
    failAt?: number;
    abortAt?: number;
    controller?: AbortController;
    verbose?: boolean;
    omitScience?: boolean;
  } = {},
) {
  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const outputs: unknown[] = [];
  const store = createMemoryStore<unknown>();
  const digests = createMemoryStore<DocumentDigest>();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    );
    requests.push(request);
    if (requests.length === options.failAt) throw new Error('mock failure');
    if (requests.length === options.abortAt) options.controller?.abort();
    const text = request.messages[1].content as string;
    const chunk = text.includes('分析以下 PDF 分块');
    const intermediate = text.includes('这是分层中间归并');
    const documentId = /documentId[：]([^；，]+)/.exec(text)?.[1] ?? 'lecture';
    const documentRecords =
      !chunk && !text.includes('你在为一门课程')
        ? JSON.parse(text.split('\n')[1])
        : [];
    const page = chunk
      ? Number(/<page number="(\d+)"/.exec(text)?.[1] ?? 1)
      : (synthesisSources(documentRecords, source(documentId))[0]?.pageStart ??
        1);
    const result = reply(documentId, page, options.verbose && chunk);
    if (!options.omitScience && chunk && text.includes(formula))
      Object.assign(result.sections[0], {
        points: [
          { text: formula, pageStart: page, pageEnd: page },
          { text: table, pageStart: page, pageEnd: page },
        ],
      });
    if (text.includes('你在为一门课程')) {
      const records = JSON.parse(text.split('\n')[2]);
      result.concepts[0].sources = synthesisSources(records).map((s) => ({
        ...s,
        pageEnd: s.pageEnd ?? s.pageStart,
        type: 'pdf' as const,
      }));
      result.sections[0].pageStart = result.concepts[0].sources[0].pageStart;
      result.sections[0].pageEnd = result.concepts[0].sources[0].pageStart;
    }
    if (intermediate) result.overview = '中间摘要';
    outputs.push(result);
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;
  const provider = createKnowledgeProviderForSettings(
    settings,
    fetchImpl,
    createKnowledgeDigestCache(digests),
    store,
  );
  return { provider, requests, outputs, store, digests, options };
}
const input = (pages = lecturePages) => ({
  documentId: 'lecture',
  fingerprint: 'fingerprint',
  fileName: 'lecture.pdf',
  pages,
});

void test('long lecture maps every chunk, reduces bounded groups, and short material has only one document synthesis', async () => {
  const m = mock({ verbose: true });
  const diagnostics: SynthesisDiagnostic[] = [];
  const digest = await m.provider.analyzeDocument({
    ...input(),
    onDiagnostic: (d) => diagnostics.push(d),
  });
  const chunks = buildPdfChunks(lecturePages).length;
  const chunkCalls = m.requests.filter((r) =>
    r.messages[1].content.includes('分析以下 PDF 分块'),
  ).length;
  assert.equal(chunkCalls, chunks);
  assert.equal(diagnostics.filter((d) => d.action === 'split').length, 1);
  assert.equal(m.requests.length, 11); // six maps, four document groups, one final synthesis
  assert.ok(digest.concepts.length);
  for (const request of m.requests)
    assert.ok(
      utf8Size(request.messages) <=
        (request.messages[1].content.includes('分析以下 PDF 分块')
          ? SYNTHESIS_BUDGET.chunk
          : SYNTHESIS_BUDGET.document),
    );
  assert.ok(
    diagnostics.every((d) => d.droppedItems === 0 && d.droppedBytes === 0),
  );
  const short = mock();
  await short.provider.analyzeDocument(
    input(['一份平坦短材料，只介绍能量的基本概念。']),
  );
  assert.equal(short.requests.length, 2);
  await short.provider.synthesizeCourseKnowledge({
    courseId: 'c',
    courseName: '短课程',
    digests: [{ ...digest, sections: digest.sections.slice(0, 1) }],
  });
  assert.equal(short.requests.length, 3);
});

void test('multi-document long legacy course reduces and deduplicates while retaining all sources', async () => {
  const m = mock();
  const digests = [
    legacyLongDigest('a'),
    legacyLongDigest('b'),
    legacyLongDigest('c'),
  ];
  const ai = await m.provider.synthesizeCourseKnowledge({
    courseId: 'c',
    courseName: '长课程',
    digests,
  });
  assert.equal(m.requests.length, 19); // 36 indivisible sections plus headers, bounded packing
  assert.equal(ai.nodes.length, 1);
  assert.equal(ai.nodes[0].sources.length, 3);
  assert.ok(
    ai.diagnostics?.some((d) => d.layer === 'course' && d.action === 'split'),
  );
  for (const request of m.requests)
    assert.ok(utf8Size(request.messages) <= SYNTHESIS_BUDGET.course);
  console.log(
    'HIERARCHY_METRICS',
    JSON.stringify({
      beforeBytes: utf8Size(digests),
      calls: m.requests.length,
      outputBytes: m.outputs.map(utf8Size),
    }),
  );
});

void test('scientific paper guards formulas, tables, definitions and conclusions even when model omits them', async () => {
  const m = mock({ omitScience: true });
  const digest = await m.provider.analyzeDocument(input(paperPages));
  const markdown = renderDocumentSummary(digest);
  for (const text of [
    formula,
    table,
    '定义：质量 m 为正。',
    '结论：能量正比于质量。',
  ])
    assert.ok(markdown.includes(text));
  const ai = await m.provider.synthesizeCourseKnowledge({
    courseId: 'c',
    courseName: '论文',
    digests: [digest],
  });
  assert.equal(ai.evidence?.length, 4);
  assert.ok(ai.diagnostics?.some((d) => d.action === 'quality-restored'));
  const knowledge = applyAiCourseKnowledge(
    emptyCourseKnowledge('c', '论文'),
    ai,
  );
  const rendered = renderCourseSummary(
    { name: '论文', documents: [] } as never,
    knowledge,
  );
  assert.ok(rendered.includes(formula));
  assert.ok(rendered.includes(table));
  assert.ok(
    ai.evidence?.every((item) =>
      item.sources.every(
        (s) =>
          s.documentId === 'lecture' &&
          s.fileName === 'lecture.pdf' &&
          s.pageStart === 1,
      ),
    ),
  );
  assert.equal(
    removeDocumentContribution(knowledge, 'lecture').evidence?.length,
    0,
  );
});

void test('failure and cancellation retain completed layers, reject late output, and retry reuses checkpoints', async () => {
  for (const mode of ['failure', 'cancel']) {
    const controller = new AbortController();
    const m = mock({
      verbose: true,
      controller,
      ...(mode === 'cancel' ? { abortAt: 3 } : { failAt: 3 }),
    });
    const previous = emptyCourseKnowledge('c', '旧成果');
    const before = JSON.stringify(previous);
    await assert.rejects(
      m.provider.analyzeDocument({ ...input(), signal: controller.signal }),
    );
    assert.equal((await m.digests.keys()).length, 0);
    assert.equal((await m.store.keys()).length, 2);
    assert.equal(JSON.stringify(previous), before);
    m.options.failAt = undefined;
    m.options.abortAt = undefined;
    const diagnostics: SynthesisDiagnostic[] = [];
    await m.provider.analyzeDocument({
      ...input(),
      onDiagnostic: (d) => diagnostics.push(d),
    });
    assert.equal(diagnostics.filter((d) => d.action === 'cache-hit').length, 2);
    assert.equal((await m.digests.keys()).length, 1);
  }
});

void test('cancelling during a document reduction preserves previous completed document groups', async () => {
  const controller = new AbortController();
  const m = mock({ verbose: true, controller, abortAt: 8 });
  await assert.rejects(
    m.provider.analyzeDocument({ ...input(), signal: controller.signal }),
  );
  assert.equal((await m.store.keys()).length, 7);
  assert.equal((await m.digests.keys()).length, 0);
  m.options.abortAt = undefined;
  const events: SynthesisDiagnostic[] = [];
  await m.provider.analyzeDocument({
    ...input(),
    onDiagnostic: (d) => events.push(d),
  });
  assert.equal(events.filter((d) => d.action === 'cache-hit').length, 7);
});

void test('cache identities include layer, identity, provider, model, prompt and source content', async () => {
  const parts = {
    layer: 'document' as const,
    identity: 'd/round0',
    provider: 'p',
    model: 'm',
    promptVersion: 'v1',
    input: { source: 'a' },
  };
  const first = await synthesisCacheKey(parts);
  for (const change of [
    { layer: 'course' as const },
    { identity: 'd/round1' },
    { provider: 'q' },
    { model: 'n' },
    { promptVersion: 'v2' },
    { input: { source: 'b' } },
  ])
    assert.notEqual(first, await synthesisCacheKey({ ...parts, ...change }));
  const m = mock();
  await m.provider.analyzeDocument(input(paperPages));
  for (const key of await m.store.keys())
    await m.store.set(key, { schemaVersion: 0, raw: null });
  for (const key of await m.digests.keys()) await m.digests.delete(key);
  await m.provider.analyzeDocument(input(paperPages));
  assert.equal(m.requests.length, 4);
});

void test('oversized atomic table is rejected with explicit zero-loss diagnostic and no model call', async () => {
  const m = mock();
  const digest = legacyLongDigest('a');
  digest.sections = [
    {
      id: 's',
      title: '表格',
      summary: '|x|y|'.repeat(9000),
      pageStart: 1,
      pageEnd: 1,
    },
  ];
  const events: SynthesisDiagnostic[] = [];
  await assert.rejects(
    m.provider.synthesizeCourseKnowledge({
      courseId: 'c',
      courseName: '课程',
      digests: [digest],
      onDiagnostic: (d) => events.push(d),
    }),
    /未截断/,
  );
  assert.equal(m.requests.length, 0);
  assert.equal(events[0].action, 'rejected');
  assert.equal(events[0].layer, 'course');
  assert.equal(events[0].droppedBytes, 0);
  assert.match(events[0].detail, /来源/);
});

void test('complete prompts including oversized user metadata are bounded before requesting', async () => {
  const m = mock();
  const events: SynthesisDiagnostic[] = [];
  await assert.rejects(
    m.provider.analyzeDocument({
      ...input(['短文材料']),
      fileName: '名'.repeat(30000),
      onDiagnostic: (d) => events.push(d),
    }),
    /预算/,
  );
  assert.equal(m.requests.length, 0);
  assert.ok(
    events.some((d) => d.action === 'rejected' && d.inputBytes > d.limit),
  );
});

void test('non-shrinking reductions stop explicitly rather than looping or silently slicing', async () => {
  const events: SynthesisDiagnostic[] = [];
  const records = [{ text: 'a'.repeat(15000) }, { text: 'b'.repeat(15000) }];
  await assert.rejects(
    reduceWithinBudget({
      records,
      layer: 'document',
      identity: 'd',
      report: (d) => events.push(d),
      reduce: async (batch) => batch,
    }),
    /未缩小/,
  );
  assert.ok(events.some((d) => d.action === 'rejected'));
  assert.ok(events.every((d) => d.droppedItems === 0));
});

void test('very large page segmentation has no hidden 202-segment cutoff', () => {
  const text = 'x'.repeat(12000 * 205 + 1);
  const chunks = buildPdfChunks([text]);
  assert.equal(
    chunks.reduce((n, c) => n + c.charCount, 0),
    text.length,
  );
  assert.equal(chunks.length, 206);
});

void test('schema splitting carries document identity and progress labels name all three layers', () => {
  const records = synthesisRecords(reply(), {
    documentId: 'd',
    fileName: 'd.pdf',
  });
  assert.ok(
    records.every(
      (record) => (record as { documentId: string }).documentId === 'd',
    ),
  );
  assert.match(
    knowledgeStageMessage('chunk-analysis', { chunkIndex: 2, chunkCount: 6 }),
    /分块层.*2 \/ 6/,
  );
  assert.match(
    knowledgeStageMessage('synthesize', { identity: 'd/round-1' }),
    /文档层.*round-1/,
  );
  assert.match(knowledgeStageMessage('course-merge'), /课程层/);
});

void test('long lecture plus multiple course documents completes through all layers with bounded calls', async () => {
  const m = mock({ verbose: true });
  const digest = await m.provider.analyzeDocument(input());
  const digests = [
    digest,
    legacyLongDigest('paper-a'),
    legacyLongDigest('paper-b'),
  ];
  const ai = await m.provider.synthesizeCourseKnowledge({
    courseId: 'mixed',
    courseName: '长讲义与论文合集',
    digests,
  });
  assert.equal(m.requests.length, 24);
  assert.ok(ai.nodes[0].sources.some((s) => s.documentId === 'lecture'));
  assert.ok(ai.nodes[0].sources.some((s) => s.documentId === 'paper-b'));
  const levels = m.requests.map((r, index) => ({
    layer: r.messages[1].content.includes('分析以下 PDF 分块')
      ? 'chunk'
      : r.messages[1].content.includes('你在为一门课程')
        ? 'course'
        : 'document',
    input: utf8Size(r.messages),
    output: utf8Size(m.outputs[index]),
  }));
  assert.equal(levels.filter((l) => l.layer === 'chunk').length, 6);
  assert.equal(levels.filter((l) => l.layer === 'document').length, 5);
  assert.equal(levels.filter((l) => l.layer === 'course').length, 13);
  console.log(
    'MIXED_HIERARCHY_METRICS',
    JSON.stringify({ legacyCourseInput: utf8Size(digests), levels }),
  );
});

void test('course cancellation retains old committed artifacts and retry reuses completed course groups', async () => {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('旧成果');
  const doc = legacyLongDigest('a');
  const imported = await storage.importDocument(
    new File(['pdf'], 'a.pdf'),
    doc,
    {
      generateSummary: true,
      generateMindmap: true,
      mergeIntoCourse: true,
      includeConversationInsights: false,
    },
    initial.manifest.revision,
  );
  const before = JSON.stringify(await storage.load());
  const controller = new AbortController();
  const m = mock({ controller, abortAt: 3 });
  const courseInput = {
    courseId: initial.manifest.id,
    courseName: '旧成果',
    digests: [doc, legacyLongDigest('b')],
  };
  await assert.rejects(
    (async () => {
      const ai = await m.provider.synthesizeCourseKnowledge({
        ...courseInput,
        signal: controller.signal,
      });
      await storage.mergeDocument('a', imported.bundle.manifest.revision, ai);
    })(),
  );
  assert.equal(JSON.stringify(await storage.load()), before);
  assert.equal((await m.store.keys()).length, 2);
  m.options.abortAt = undefined;
  const events: SynthesisDiagnostic[] = [];
  await m.provider.synthesizeCourseKnowledge({
    ...courseInput,
    onDiagnostic: (d) => events.push(d),
  });
  assert.equal(events.filter((d) => d.action === 'cache-hit').length, 2);
});

void test('failed forced regeneration resumes new checkpoints instead of returning the old final digest', async () => {
  const m = mock();
  await m.provider.analyzeDocument(input(paperPages));
  m.options.failAt = 4;
  await assert.rejects(
    m.provider.analyzeDocument({ ...input(paperPages), bypassCache: true }),
  );
  m.options.failAt = undefined;
  await m.provider.analyzeDocument({ ...input(paperPages), resume: true });
  assert.equal(m.requests.length, 5);
});

void test('many tiny PDF pages budget their page tags as well as text', () => {
  const pages = Array.from({ length: 2000 }, () => '短页');
  const chunks = buildPdfChunks(pages);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.flatMap((chunk) => chunk.pages).length, 2000);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 12000));
});

void test('truncated outputs report exact discarded bytes and never cache partial layers', async () => {
  const store = createMemoryStore<unknown>();
  const events: SynthesisDiagnostic[] = [];
  const partial = '{"unfinished":';
  const fetchImpl = (async () =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: partial }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )) as typeof fetch;
  const provider = createKnowledgeProviderForSettings(
    settings,
    fetchImpl,
    createKnowledgeDigestCache(createMemoryStore<DocumentDigest>()),
    store,
  );
  await assert.rejects(
    provider.analyzeDocument({
      ...input(paperPages),
      onDiagnostic: (d) => events.push(d),
    }),
    /输出被截断/,
  );
  const rejected = events.find((d) => d.action === 'rejected')!;
  assert.equal(rejected.layer, 'chunk');
  assert.equal(rejected.droppedItems, 1);
  assert.equal(rejected.droppedBytes, utf8Size(partial));
  assert.equal((await store.keys()).length, 0);
});

void test('provenance survives every cached layer and keeps source gaps', async () => {
  const m = mock({ verbose: true });
  await m.provider.analyzeDocument(input());
  for (const key of await m.store.keys()) {
    const entry = (await m.store.get(key)) as {
      raw: { provenance: ReturnType<typeof synthesisSources> };
    };
    assert.ok(entry.raw.provenance.length);
    assert.ok(
      entry.raw.provenance.every(
        (s) => s.documentId === 'lecture' && s.fileName === 'lecture.pdf',
      ),
    );
  }
  assert.equal(synthesisSources([source('a', 1), source('a', 3)]).length, 2);
});
