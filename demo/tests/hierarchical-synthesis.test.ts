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
import { buildPdfChunks, splitPdfChunk } from '../lib/knowledge/pdf-chunks.ts';
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
    maxInputBytes?: Partial<Record<'chunk' | 'document' | 'course', number>>;
    maxOutputTokens?: number;
    overflowStatus?: number;
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
    const intermediate = text.includes('当前只是中间压缩') || text.includes('这是分层中间归并');
    const course = text.includes('归并课程') || text.includes('你在为一门课程');
    const layer = chunk ? 'chunk' : course ? 'course' : 'document';
    if (options.maxOutputTokens && request.max_tokens > options.maxOutputTokens)
      return Response.json({ error: { message: 'max_tokens must be less than the context window' } }, { status: 400 });
    if (options.maxInputBytes?.[layer] && utf8Size(request.messages) > options.maxInputBytes[layer]!)
      return options.overflowStatus === 413 ? new Response('Request Entity Too Large', { status: 413 })
        : Response.json({ error: { message: 'input is too long for this model' } }, { status: options.overflowStatus ?? 400 });
    const documentId = /documentId[：]([^；，]+)/.exec(text)?.[1]
      ?? /"documentId":"([^"]+)"/.exec(text)?.[1]
      ?? 'lecture';
    const documentRecords = !chunk
      ? JSON.parse(text.split('\n')[course || intermediate ? 2 : 1])
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
    if (course) {
      const records = JSON.parse(text.split('\n')[2]);
      const sources = synthesisSources(records);
      result.concepts[0].sources = (sources.length ? sources : [source(documentId, page)]).map((s) => ({
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
      : r.messages[1].content.includes('归并课程') || r.messages[1].content.includes('你在为一门课程')
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


void test('long Chinese pages recover from provider input limits without losing pages or source text', async () => {
  const pages = Array.from({ length: 3 }, (_, page) => `第${page + 1}页：` + '正文内容😀。'.repeat(1200));
  for (const overflowStatus of [400, 413, 422]) {
    const m = mock({ maxInputBytes: { chunk: 15000 }, overflowStatus });
    const events: SynthesisDiagnostic[] = [];
    const digest = await m.provider.analyzeDocument({ ...input(pages), onDiagnostic: d => events.push(d) });
    const successfulChunks = m.requests.filter(request => request.messages[1].content.includes('分析以下 PDF 分块')
      && utf8Size(request.messages) <= 15000);
    const byPage = new Map<number, string>();
    for (const request of successfulChunks) {
      for (const match of request.messages[1].content.matchAll(/<page number="(\d+)"[^>]*>\n([\s\S]*?)\n<\/page>/g))
        byPage.set(Number(match[1]), (byPage.get(Number(match[1])) ?? '') + match[2]);
    }
    assert.deepEqual([...byPage.values()], pages);
    assert.deepEqual(digest.sourcePages, [1, 2, 3]);
    assert.ok(events.some(event => event.layer === 'chunk' && event.action === 'split'));
    assert.ok(events.every(event => event.droppedBytes === 0));
    assert.ok(m.requests.length < 40, 'recovery must have a bounded number of calls');
  }
});

void test('document and course synthesis automatically reduce further when the provider has a smaller context', async () => {
  const m = mock({ verbose: true, maxInputBytes: { document: 17000, course: 17000 } });
  const digest = await m.provider.analyzeDocument(input());
  assert.ok(digest.diagnostics?.some(event => event.layer === 'document' && /服务商上下文不足/.test(event.detail)));
  const ai = await m.provider.synthesizeCourseKnowledge({ courseId: 'c', courseName: '课程', digests: [legacyLongDigest('a'), legacyLongDigest('b')] });
  assert.ok(ai.diagnostics?.some(event => event.layer === 'course' && /服务商上下文不足/.test(event.detail)));
  assert.deepEqual(ai.nodes[0].sources.map(source => source.documentId), ['a', 'b']);
  assert.ok(ai.diagnostics?.every(event => event.droppedBytes === 0));
});

void test('output reservations shrink on context conflict while retaining the complete input', async () => {
  const m = mock({ maxOutputTokens: 2048 });
  const digest = await m.provider.analyzeDocument(input(paperPages));
  assert.ok(digest.concepts.length);
  const requests = m.requests as Array<{ max_tokens: number; messages: unknown[] }>;
  assert.deepEqual(requests.slice(0, 3).map(request => request.max_tokens), [8192, 4096, 2048]);
  assert.deepEqual(requests[0].messages, requests[2].messages);
});

void test('adaptive splitting preserves supplementary Unicode characters and page numbers', () => {
  const text = '甲'.repeat(1001) + '😀𠮷'.repeat(1000);
  const original = buildPdfChunks(['', text])[0];
  const smaller = splitPdfChunk(original);
  assert.ok(smaller.length > 1);
  assert.equal(smaller.flatMap(chunk => chunk.segments!.map(segment => segment.text)).join(''), text);
  assert.ok(smaller.every(chunk => chunk.pages.every(page => page === 2)));
  assert.ok(smaller.every(chunk => chunk.segments!.every(segment => segment.text.isWellFormed())));
});

void test('adaptive reduction stops on unrelated errors and aborts without trying remaining batches', async () => {
  for (const code of ['auth', 'aborted']) {
    let calls = 0;
    const failure = Object.assign(new Error(code), { code });
    await assert.rejects(reduceWithinBudget({
      records: [{ text: 'a'.repeat(5000) }, { text: 'b'.repeat(5000) }], layer: 'document', identity: 'd',
      report() {}, shouldSplit: error => (error as { code: string }).code === 'context_overflow',
      reduce: async () => { calls++; throw failure; },
    }), error => error === failure);
    assert.equal(calls, 1);
  }
});

void test('cancelled adaptive chunk recovery retains checkpoints and retry reuses completed smaller chunks', async () => {
  const m = mock({ maxInputBytes: { chunk: 15000 } });
  const pages = ['正文内容。'.repeat(2000)];
  const controller = new AbortController();
  await assert.rejects(m.provider.analyzeDocument({
    ...input(pages), signal: controller.signal,
    onDiagnostic: event => {
      if (event.layer === 'chunk' && event.action === 'completed') controller.abort();
    },
  }));
  assert.equal((await m.digests.keys()).length, 0);
  assert.equal((await m.store.keys()).length, 1);
  const events: SynthesisDiagnostic[] = [];
  await m.provider.analyzeDocument({ ...input(pages), onDiagnostic: event => events.push(event) });
  assert.ok(events.some(event => event.action === 'cache-hit' && event.identity.includes('/part-')));
  assert.equal((await m.digests.keys()).length, 1);
});

void test('permanent provider context rejection stops bounded recovery and never caches partial output', async () => {
  const m = mock({ maxInputBytes: { chunk: 1 } });
  await assert.rejects(m.provider.analyzeDocument(input(['长文内容。'.repeat(2400)])), /输入内容超出/);
  assert.ok(m.requests.length > 1 && m.requests.length <= 6);
  assert.equal((await m.digests.keys()).length, 0);
  assert.equal((await m.store.keys()).length, 0);
});
