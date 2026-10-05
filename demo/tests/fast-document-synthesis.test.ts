import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KnowledgeError,
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore, type KVStore } from '../lib/reader-cache.ts';
import type {
  DigestSection,
  DocumentDigest,
  SourceReference,
} from '../lib/course-storage/types.ts';
import { buildPdfChunks } from '../lib/knowledge/pdf-chunks.ts';
import { synthesisSources } from '../lib/knowledge/hierarchical-synthesis.ts';
import {
  formula,
  paperPages,
  reply,
  settings as proxySettings,
  table,
} from './fixtures/hierarchical-synthesis.ts';

type GenerationMode = 'fast' | 'deep';

void test('fast and deep reject blank extracted pages with an actionable error before any AI request', async () => {
  for (const generationMode of ['fast', 'deep'] as const) {
    const digestStore = createMemoryStore<DocumentDigest>();
    const layerStore = createMemoryStore<unknown>();
    let requests = 0;
    const provider = createKnowledgeProviderForSettings(
      { ...proxySettings, generationMode },
      async () => {
        requests += 1;
        throw new Error('Blank pages must not contact AI');
      },
      createKnowledgeDigestCache(digestStore),
      layerStore,
    );

    for (const pages of [[''], ['', ' \n\t', '\u3000']]) {
      await assert.rejects(
        provider.analyzeDocument({
          documentId: 'blank', fingerprint: 'blank', fileName: 'blank.pdf', pages,
        }),
        (error: unknown) => {
          assert.ok(error instanceof KnowledgeError);
          assert.equal(error.code, 'invalid_input');
          assert.match(error.message, /没有可分析的文字/);
          assert.match(error.message, /PDF 内容或 OCR 识别结果/);
          return true;
        },
      );
    }
    assert.equal(requests, 0);
    assert.deepEqual(await digestStore.keys(), []);
    assert.deepEqual(await layerStore.keys(), []);
  }
});

interface KnowledgeSettingsLike {
  baseUrl: string;
  apiKey: string;
  model: string;
  generationMode?: GenerationMode;
}

interface RequestBody {
  messages?: Array<{ role?: string; content?: string }>;
  max_tokens?: number;
  thinking?: unknown;
  response_format?: unknown;
}

interface RawSection {
  title?: unknown;
  summary?: unknown;
  points?: unknown;
  pageStart?: number;
  pageEnd?: number;
}

const CHUNK_MARK = '分析以下 PDF 分块';
const FINAL_MARK = '请把分块结果综合成整份文档的知识摘要';
const INTERMEDIATE_MARK = '当前只是中间压缩';
const REPAIR_MARK = '仅修复以下脑图结构';

function modeSettings(
  base: { baseUrl: string; model: string },
  generationMode?: GenerationMode,
): KnowledgeSettingsLike {
  return {
    baseUrl: base.baseUrl,
    apiKey: 'mock-only',
    model: base.model,
    ...(generationMode ? { generationMode } : {}),
  };
}

function streamJson(value: unknown, finishReason = 'stop'): Response {
  const content = JSON.stringify(value);
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function parseRequest(init?: RequestInit): RequestBody {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as RequestBody;
}

function userPrompt(request: RequestBody): string {
  const message = request.messages?.find((candidate) => candidate.role === 'user');
  if (typeof message?.content !== 'string')
    throw new Error('mock request is missing a user prompt');
  return message.content;
}

function isChunkPrompt(prompt: string): boolean {
  return prompt.includes(CHUNK_MARK);
}
function isFinalPrompt(prompt: string): boolean {
  return prompt.includes(FINAL_MARK);
}
function isIntermediatePrompt(prompt: string): boolean {
  return prompt.includes(INTERMEDIATE_MARK);
}
function isRepairPrompt(prompt: string): boolean {
  return prompt.includes(REPAIR_MARK);
}

function chunkPageStart(prompt: string): number {
  const match = /本分块覆盖第 (\d+)[–-](\d+) 页/.exec(prompt);
  if (!match) throw new Error('chunk prompt is missing its page range');
  return Number(match[1]);
}

function pdfSource(
  documentId: string,
  fileName: string,
  pageStart: number,
  pageEnd = pageStart,
): SourceReference {
  return { documentId, fileName, pageStart, pageEnd, type: 'pdf' };
}

function chunkPayload(options: {
  documentId: string;
  fileName: string;
  page: number;
  title: string;
  summary: string;
  points?: Array<{ text: string; pageStart: number; pageEnd: number }>;
  conceptLabel?: string;
}): Record<string, unknown> {
  return {
    hierarchy: { mode: 'flat', reason: 'mock chunk' },
    sections: [
      {
        title: options.title,
        summary: options.summary,
        ...(options.points ? { points: options.points } : {}),
        pageStart: options.page,
        pageEnd: options.page,
      },
    ],
    concepts: [
      {
        id: 'c1',
        parentId: null,
        label: options.conceptLabel ?? `分块概念${options.page}`,
        description: `第${options.page}页概念说明`,
        sources: [pdfSource(options.documentId, options.fileName, options.page)],
      },
    ],
    relations: [],
    unresolvedQuestions: [],
  };
}

function flatFinalPayload(options: {
  title: string;
  overview: string;
  documentId: string;
  fileName: string;
  sources?: SourceReference[];
  sections?: unknown[];
}): Record<string, unknown> {
  const source = options.sources?.[0]
    ?? pdfSource(options.documentId, options.fileName, 1);
  return {
    hierarchy: { mode: 'flat', reason: 'mock flat final' },
    title: options.title,
    overview: options.overview,
    ...(options.sections ? { sections: options.sections } : {}),
    concepts: [
      { id: 'root', parentId: null, label: '总概念', description: '整体说明', sources: [source] },
    ],
    relations: [],
    unresolvedQuestions: [],
  };
}

function documentInput(options: {
  pages: string[];
  documentId?: string;
  fingerprint?: string;
  fileName?: string;
  signal?: AbortSignal;
  resume?: boolean;
  bypassCache?: boolean;
}): {
  documentId: string;
  fingerprint: string;
  fileName: string;
  pages: string[];
  signal?: AbortSignal;
  resume?: boolean;
  bypassCache?: boolean;
} {
  return {
    documentId: options.documentId ?? 'lecture',
    fingerprint: options.fingerprint ?? 'fingerprint',
    fileName: options.fileName ?? 'lecture.pdf',
    pages: options.pages,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.resume ? { resume: true } : {}),
    ...(options.bypassCache ? { bypassCache: true } : {}),
  };
}

function sectionShape(sections: DigestSection[]): unknown[] {
  return sections.map((section) => ({
    title: section.title,
    summary: section.summary,
    points: (section.points ?? []).map((point) => ({
      text: point.text,
      pageStart: point.pageStart,
      pageEnd: point.pageEnd,
    })),
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
  }));
}

async function documentLayerSections(
  store: KVStore<unknown>,
  sectionCount: number,
): Promise<Array<{ key: string; summaries: string[] }>> {
  const found: Array<{ key: string; summaries: string[] }> = [];
  for (const key of await store.keys()) {
    if (!key.startsWith('hierarchy:document:')) continue;
    const entry = await store.get(key) as { raw?: { sections?: RawSection[] } } | undefined;
    const sections = entry?.raw?.sections;
    if (!Array.isArray(sections) || sections.length !== sectionCount) continue;
    found.push({
      key,
      summaries: sections
        .map((section) => section.summary)
        .filter((value): value is string => typeof value === 'string'),
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. Fast assembly preserves ordered chunk sections even when the final model
//    omits them or returns bogus/reordered/out-of-range replacements.
// ---------------------------------------------------------------------------
void test('fast final preserves every ordered original chapter, point, page and formula', async () => {
  const unicodeProse = '引理：中文字符 😀𠮷 与变量 α 均需保留。';
  const pages = [
    `定义：质量 m 为正。\n\n${formula}\n\n${table}\n\n${'第一页正文内容。'.repeat(900)}`,
    `推论：${unicodeProse}\n\n${'第二页正文内容。'.repeat(900)}`,
    `结论：能量正比于质量，且 $E=mc^2$。\n\n${'第三页正文内容。'.repeat(900)}`,
  ];
  assert.equal(buildPdfChunks(pages).length, 3, 'fixture must split into three chunks');

  // The second chunk point deliberately omits pageEnd; the final digest must
  // resolve it to pageStart instead of rejecting the preserved section.
  const chunkSections = [
    {
      title: '共同主题',
      summary: '第1页摘要',
      points: [
        { text: '定义：质量 m 为正。', pageStart: 1, pageEnd: 1 },
        { text: formula, pageStart: 1, pageEnd: 1 },
        { text: table, pageStart: 1, pageEnd: 1 },
      ],
      pageStart: 1,
      pageEnd: 1,
    },
    {
      title: '共同主题',
      summary: '第2页摘要',
      points: [
        { text: `推论：${unicodeProse}`, pageStart: 2 },
        { text: '无结束页要点', pageStart: 2 },
      ],
      pageStart: 2,
      pageEnd: 2,
    },
    {
      title: '结论',
      summary: '第3页摘要',
      points: [{ text: '结论：能量正比于质量，且 $E=mc^2$。', pageStart: 3, pageEnd: 3 }],
      pageStart: 3,
      pageEnd: 3,
    },
  ];
  const expectedSections = [
    chunkSections[0],
    {
      ...chunkSections[1],
      points: [
        { text: `推论：${unicodeProse}`, pageStart: 2, pageEnd: 2 },
        { text: '无结束页要点', pageStart: 2, pageEnd: 2 },
      ],
    },
    chunkSections[2],
  ];

  async function run(finalSections?: unknown[]) {
    const requests: RequestBody[] = [];
    const completionOrder: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const request = parseRequest(init);
      requests.push(request);
      const prompt = userPrompt(request);
      if (isChunkPrompt(prompt)) {
        const page = chunkPageStart(prompt);
        if (page === 1) await firstGate;
        completionOrder.push(page);
        if (page === 2) releaseFirst();
        const section = chunkSections[page - 1]!;
        return streamJson({
          hierarchy: { mode: 'flat', reason: 'mock chunk' },
          sections: [{
            ...section,
            points: section.points.map((point, index) => index === 0
              ? { text: point.text, pageStart: point.pageStart }
              : index === 1 ? { ...point, pageEnd: null } : point),
          }],
          concepts: [
            {
              id: 'c1',
              parentId: null,
              label: `分块概念${page}`,
              description: `第${page}页概念说明`,
              sources: [pdfSource('lecture', 'lecture.pdf', page)],
            },
          ],
          relations: [],
          unresolvedQuestions: [],
        });
      }
      const payload = flatFinalPayload({
        title: '文档标题',
        overview: '整体概述。',
        documentId: 'lecture',
        fileName: 'lecture.pdf',
      });
      if (finalSections) payload.sections = finalSections;
      return streamJson(payload);
    }) as typeof fetch;
    const provider = createKnowledgeProviderForSettings(
      modeSettings(proxySettings, 'fast'),
      fetchImpl,
      createKnowledgeDigestCache(createMemoryStore<DocumentDigest>()),
      createMemoryStore(),
    );
    const digest = await provider.analyzeDocument(documentInput({ pages }));
    return { digest, requests, completionOrder };
  }

  const omitted = await run();
  assert.equal(
    omitted.completionOrder[0],
    2,
    'a later chunk must complete before the gated first chunk',
  );
  assert.deepEqual(omitted.completionOrder.slice().sort((left, right) => left - right), [1, 2, 3]);
  assert.equal(
    omitted.requests.filter((request) => isChunkPrompt(userPrompt(request))).length,
    3,
  );
  assert.equal(
    omitted.requests.filter((request) => isFinalPrompt(userPrompt(request))).length,
    1,
  );
  assert.deepEqual(sectionShape(omitted.digest.sections), expectedSections);

  const faked = await run([
    { title: 'bogus', summary: 'bogus', pageStart: 99, pageEnd: 99, points: [{ text: 'bogus', pageStart: 99, pageEnd: 99 }] },
    { title: '共同主题', summary: '伪造', pageStart: 2, pageEnd: 1 },
  ]);
  assert.ok(
    faked.digest.sections.every((section) => section.title !== 'bogus' && section.summary !== '伪造'),
    'model-supplied sections must be ignored and replaced by the original chunk sections',
  );
  assert.deepEqual(sectionShape(faked.digest.sections), expectedSections);
});

// ---------------------------------------------------------------------------
// 2. Deep mode still requires final sections.
// ---------------------------------------------------------------------------
void test('deep final without sections is rejected and no digest is stored', async () => {
  const requests: RequestBody[] = [];
  const digestStore = createMemoryStore<DocumentDigest>();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const request = parseRequest(init);
    requests.push(request);
    const prompt = userPrompt(request);
    if (isChunkPrompt(prompt)) return streamJson(reply('lecture', 1));
    return streamJson(flatFinalPayload({
      title: '缺少章节',
      overview: '没有 sections。',
      documentId: 'lecture',
      fileName: 'lecture.pdf',
    }));
  }) as typeof fetch;
  const provider = createKnowledgeProviderForSettings(
    modeSettings(proxySettings, 'deep'),
    fetchImpl,
    createKnowledgeDigestCache(digestStore),
    createMemoryStore(),
  );
  await assert.rejects(
    provider.analyzeDocument(documentInput({ pages: paperPages })),
    /sections/,
  );
  assert.equal((await digestStore.keys()).length, 0);
  assert.equal(
    requests.filter((request) => isFinalPrompt(userPrompt(request))).length,
    2,
    'the rejected deep draft must be retried once and still fail',
  );
});

// ---------------------------------------------------------------------------
// 3. Fast/deep final caches are isolated; chunk caches are shared; a fast
//    digest never satisfies a deep request while a deep digest may satisfy fast.
// ---------------------------------------------------------------------------
async function analyzeWithMock(options: {
  base: { baseUrl: string; model: string };
  generationMode?: GenerationMode;
  layerStore: KVStore<unknown>;
  digestStore: KVStore<DocumentDigest>;
  finalTitle: string;
}) {
  const requests: RequestBody[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const request = parseRequest(init);
    requests.push(request);
    const prompt = userPrompt(request);
    if (isChunkPrompt(prompt)) return streamJson(reply('lecture', 1));
    const payload = reply('lecture', 1);
    payload.title = options.finalTitle;
    return streamJson(payload);
  }) as typeof fetch;
  const provider = createKnowledgeProviderForSettings(
    modeSettings(options.base, options.generationMode),
    fetchImpl,
    createKnowledgeDigestCache(options.digestStore),
    options.layerStore,
  );
  const digest = await provider.analyzeDocument(documentInput({ pages: paperPages }));
  return { digest, requests };
}

void test('fast and deep final layers stay isolated while chunks are shared and digests are asymmetric', async () => {
  const cases: Array<{ name: string; base: { baseUrl: string; model: string } }> = [
    { name: 'official DeepSeek', base: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } },
    { name: 'ordinary proxy', base: proxySettings },
  ];

  for (const { name, base } of cases) {
    // Shared chunk layer, fast then deep: the deep run must reuse the chunk and
    // re-request only its own final layer.
    const layerFastFirst = createMemoryStore<unknown>();
    const fastFirst = await analyzeWithMock({
      base, generationMode: 'fast', layerStore: layerFastFirst,
      digestStore: createMemoryStore(), finalTitle: 'fast-title',
    });
    assert.equal(fastFirst.requests.length, 2, `${name} fast first run maps one chunk and one final`);
    const deepSecond = await analyzeWithMock({
      base, generationMode: 'deep', layerStore: layerFastFirst,
      digestStore: createMemoryStore(), finalTitle: 'deep-title',
    });
    assert.equal(deepSecond.requests.length, 1, `${name} deep reuses the fast chunk and re-requests its final layer`);
    assert.ok(isFinalPrompt(userPrompt(deepSecond.requests[0]!)), `${name} the single deep request must be final synthesis`);
    assert.equal(deepSecond.digest.title, 'deep-title');

    // Shared chunk layer, deep then fast.
    const layerDeepFirst = createMemoryStore<unknown>();
    const deepFirst = await analyzeWithMock({
      base, generationMode: 'deep', layerStore: layerDeepFirst,
      digestStore: createMemoryStore(), finalTitle: 'deep-title',
    });
    assert.equal(deepFirst.requests.length, 2);
    const fastSecond = await analyzeWithMock({
      base, generationMode: 'fast', layerStore: layerDeepFirst,
      digestStore: createMemoryStore(), finalTitle: 'fast-title',
    });
    assert.equal(fastSecond.requests.length, 1, `${name} fast reuses the deep chunk and re-requests its final layer`);
    assert.ok(isFinalPrompt(userPrompt(fastSecond.requests[0]!)));
    assert.equal(fastSecond.digest.title, 'fast-title');

    // Shared digest store, fast then deep: the fast digest must not satisfy deep.
    const sharedFastFirst = createMemoryStore<DocumentDigest>();
    const fastDigestSeed = await analyzeWithMock({
      base, generationMode: 'fast', layerStore: createMemoryStore(),
      digestStore: sharedFastFirst, finalTitle: 'fast-title',
    });
    assert.equal(fastDigestSeed.requests.length, 2);
    const deepFromFastDigest = await analyzeWithMock({
      base, generationMode: 'deep', layerStore: createMemoryStore(),
      digestStore: sharedFastFirst, finalTitle: 'deep-title',
    });
    assert.equal(deepFromFastDigest.requests.length, 2, `${name} a fast digest must not satisfy a deep request`);
    assert.equal(deepFromFastDigest.digest.title, 'deep-title');

    // Shared digest store, deep then fast: intentionally allowed to reuse deep.
    const sharedDeepFirst = createMemoryStore<DocumentDigest>();
    const deepDigestSeed = await analyzeWithMock({
      base, generationMode: 'deep', layerStore: createMemoryStore(),
      digestStore: sharedDeepFirst, finalTitle: 'deep-title',
    });
    assert.equal(deepDigestSeed.requests.length, 2);
    const fastFromDeepDigest = await analyzeWithMock({
      base, generationMode: 'fast', layerStore: createMemoryStore(),
      digestStore: sharedDeepFirst, finalTitle: 'fast-title',
    });
    assert.equal(fastFromDeepDigest.requests.length, 0, `${name} fast may intentionally reuse a validated deep digest`);
    assert.equal(fastFromDeepDigest.digest.title, 'deep-title');
  }
});

void test('a final checkpoint restores original sections before returning a cached result', async () => {
  const layerStore = createMemoryStore<unknown>();
  const seeded = await analyzeWithMock({
    base: proxySettings,
    generationMode: 'fast',
    layerStore,
    digestStore: createMemoryStore(),
    finalTitle: 'cached-title',
  });
  const key = (await layerStore.keys()).find((candidate) => candidate.startsWith('hierarchy:document:'));
  assert.ok(key);
  const entry = await layerStore.get(key) as { schemaVersion: number; raw: Record<string, unknown> };
  await layerStore.set(key, {
    ...entry,
    raw: {
      ...entry.raw,
      sections: [{ title: 'tampered', summary: 'untrusted body', pageStart: 999 }],
    },
  });

  const restored = await analyzeWithMock({
    base: proxySettings,
    generationMode: 'fast',
    layerStore,
    digestStore: createMemoryStore(),
    finalTitle: 'must-not-request',
  });
  assert.equal(restored.requests.length, 0, 'chunk and final checkpoint both remain reusable');
  assert.equal(restored.digest.title, 'cached-title');
  assert.deepEqual(restored.digest.sections, seeded.digest.sections);
});

// ---------------------------------------------------------------------------
// 4. The final checkpoint identity includes the preserved original section
//    body even when intermediate reduction output and final prompt are stable.
// ---------------------------------------------------------------------------
void test('final cache identity includes preserved section bodies after intermediate reduction', async () => {
  const documentId = 'lecture';
  const fileName = 'lecture.pdf';
  const pages = ['第四页正文内容。'.repeat(900), '第五页正文内容。'.repeat(900), '第六页正文内容。'.repeat(900)];
  assert.equal(buildPdfChunks(pages).length, 3);

  let marker = 'A';
  const requests: RequestBody[] = [];
  const layerStore = createMemoryStore<unknown>();

  function intermediatePayload(prompt: string): Record<string, unknown> {
    const records = JSON.parse(prompt.split('\n')[2] ?? '[]') as unknown[];
    const allowed = synthesisSources(records, pdfSource(documentId, fileName, 1));
    const first = allowed[0] ?? pdfSource(documentId, fileName, 1);
    return {
      hierarchy: { mode: 'flat', reason: 'mock intermediate' },
      title: '中间索引',
      overview: '中间概述',
      sections: [{ title: '中间主题', summary: '中间', pageStart: first.pageStart, pageEnd: first.pageEnd ?? first.pageStart }],
      concepts: [{
        id: 'mid',
        parentId: null,
        label: '中间概念',
        description: '中间说明',
        sources: [pdfSource(first.documentId, first.fileName, first.pageStart, first.pageEnd ?? first.pageStart)],
      }],
      relations: [],
      unresolvedQuestions: [],
    };
  }

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const request = parseRequest(init);
    requests.push(request);
    const prompt = userPrompt(request);
    if (isChunkPrompt(prompt)) {
      const page = chunkPageStart(prompt);
      return streamJson(chunkPayload({
        documentId,
        fileName,
        page,
        title: `原始章节${page}`,
        summary: marker.repeat(18000),
        points: [{ text: `原始要点${page}`, pageStart: page, pageEnd: page }],
        conceptLabel: `原始概念${page}`,
      }));
    }
    if (isIntermediatePrompt(prompt)) return streamJson(intermediatePayload(prompt));
    const batch = JSON.parse(prompt.split('\n')[1] ?? '[]') as unknown[];
    const allowed = synthesisSources(batch, pdfSource(documentId, fileName, 1));
    return streamJson(flatFinalPayload({
      title: '最终标题',
      overview: '最终概述',
      documentId,
      fileName,
      sources: allowed.length ? allowed : [pdfSource(documentId, fileName, 1)],
    }));
  }) as typeof fetch;

  function createProvider(digestStore: KVStore<DocumentDigest>) {
    return createKnowledgeProviderForSettings(
      modeSettings(proxySettings, 'fast'),
      fetchImpl,
      createKnowledgeDigestCache(digestStore),
      layerStore,
    );
  }

  const firstDigest = await createProvider(createMemoryStore<DocumentDigest>())
    .analyzeDocument(documentInput({ pages }));
  const firstFinal = requests.find((request) => isFinalPrompt(userPrompt(request)));
  assert.ok(firstFinal, 'first run must issue a final synthesis request');
  const firstFinalPrompt = userPrompt(firstFinal);
  assert.ok(
    requests.some((request) => isIntermediatePrompt(userPrompt(request))),
    'verbose chunk sections must force document intermediate reduction',
  );
  assert.ok(firstDigest.sections.every((section) => section.summary.startsWith('A')));

  const keysBefore = await layerStore.keys();
  const finalLayersBefore = await documentLayerSections(layerStore, 3);
  assert.ok(finalLayersBefore.length >= 1, 'the first final layer must be checkpointed');
  const firstFinalKeys = new Set(finalLayersBefore.map((entry) => entry.key));

  // Change the original chunk section body but keep its byte length so batch
  // packing, intermediate output and the final prompt stay identical. Only the
  // chunk checkpoints are dropped; the final checkpoint stays cached.
  marker = 'B';
  for (const key of keysBefore)
    if (key.startsWith('hierarchy:chunk:')) await layerStore.delete(key);

  const secondDigest = await createProvider(createMemoryStore<DocumentDigest>())
    .analyzeDocument(documentInput({ pages }));
  const secondFinal = requests.filter((request) => isFinalPrompt(userPrompt(request))).at(-1);
  assert.ok(secondFinal, 'changed preserved sections must force a fresh final request');
  assert.equal(requests.filter((request) => isFinalPrompt(userPrompt(request))).length, 2);
  assert.equal(userPrompt(secondFinal), firstFinalPrompt, 'the compact final prompt must remain identical');

  const finalLayersAfter = await documentLayerSections(layerStore, 3);
  assert.ok(
    finalLayersAfter.some((entry) => !firstFinalKeys.has(entry.key) && entry.summaries.some((summary) => summary.startsWith('B'))),
    'a new final checkpoint identity must be written for the changed preserved body',
  );
  assert.ok(secondDigest.sections.every((section) => section.summary.startsWith('B')));
});

// ---------------------------------------------------------------------------
// 5. A corrupt chunk checkpoint is rejected, recomputed, and the run recovers.
// ---------------------------------------------------------------------------
void test('a corrupted chunk checkpoint is recomputed instead of feeding invalid sections forward', async () => {
  const pages = ['第六页正文内容。'.repeat(900), '第七页正文内容。'.repeat(900)];
  assert.equal(buildPdfChunks(pages).length, 2);
  const layerStore = createMemoryStore<unknown>();

  function createProvider(digestStore: KVStore<DocumentDigest>) {
    const requests: RequestBody[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const request = parseRequest(init);
      requests.push(request);
      const prompt = userPrompt(request);
      if (isChunkPrompt(prompt)) {
        const page = chunkPageStart(prompt);
        return streamJson(chunkPayload({
          documentId: 'lecture',
          fileName: 'lecture.pdf',
          page,
          title: `原始章节${page}`,
          summary: `第${page}页摘要`,
          points: [{ text: `要点${page}`, pageStart: page, pageEnd: page }],
          conceptLabel: `概念${page}`,
        }));
      }
      return streamJson(flatFinalPayload({
        title: '标题', overview: '概述', documentId: 'lecture', fileName: 'lecture.pdf',
      }));
    }) as typeof fetch;
    const provider = createKnowledgeProviderForSettings(
      modeSettings(proxySettings, 'fast'),
      fetchImpl,
      createKnowledgeDigestCache(digestStore),
      layerStore,
    );
    return { provider, requests };
  }

  const seed = createProvider(createMemoryStore<DocumentDigest>());
  await seed.provider.analyzeDocument(documentInput({ pages }));
  assert.equal(seed.requests.filter((request) => isChunkPrompt(userPrompt(request))).length, 2);

  const chunkKeys = (await layerStore.keys())
    .filter((key) => key.startsWith('hierarchy:chunk:'))
    .sort();
  assert.equal(chunkKeys.length, 2);
  const corruptedKey = chunkKeys[0]!;
  const entry = await layerStore.get(corruptedKey) as
    | { schemaVersion?: number; raw?: { sections?: RawSection[] } }
    | undefined;
  const raw = entry?.raw?.sections;
  assert.ok(raw?.[0], 'stored chunk must carry a section');
  raw[0]!.title = '';
  await layerStore.set(corruptedKey, entry);

  const second = createProvider(createMemoryStore<DocumentDigest>());
  const digest = await second.provider.analyzeDocument(documentInput({ pages }));
  assert.equal(
    second.requests.filter((request) => isChunkPrompt(userPrompt(request))).length,
    1,
    'only the corrupted chunk checkpoint may be recomputed',
  );
  assert.equal(
    second.requests.filter((request) => isFinalPrompt(userPrompt(request))).length,
    0,
    'the untouched final checkpoint may be reused',
  );
  assert.deepEqual(
    sectionShape(digest.sections).map((section) => (section as { title: string }).title).sort(),
    ['原始章节1', '原始章节2'],
  );
});

// ---------------------------------------------------------------------------
// 6. A truncated or aborted final never saves a new final layer or digest,
//    while the validated chunk checkpoint remains.
// ---------------------------------------------------------------------------
void test('truncated and aborted final regeneration keep the old digest and chunk checkpoint', async () => {
  for (const failure of ['length', 'abort'] as const) {
    const digestStore = createMemoryStore<DocumentDigest>();
    const layerStore = createMemoryStore<unknown>();
    const controller = new AbortController();
    let phase: 'seed' | 'fail' = 'seed';
    const requests: RequestBody[] = [];

    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const request = parseRequest(init);
      requests.push(request);
      const prompt = userPrompt(request);
      if (isChunkPrompt(prompt)) return streamJson(reply('lecture', 1));
      if (phase === 'seed') return streamJson(reply('lecture', 1));
      if (failure === 'length') return streamJson({ unfinished: true }, 'length');
      controller.abort(new Error('final aborted'));
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    const provider = createKnowledgeProviderForSettings(
      modeSettings(proxySettings, 'fast'),
      fetchImpl,
      createKnowledgeDigestCache(digestStore),
      layerStore,
    );

    await provider.analyzeDocument(documentInput({ pages: paperPages }));
    const digestKey = (await digestStore.keys())[0];
    assert.ok(digestKey);
    const digestBefore = JSON.stringify(await digestStore.get(digestKey));
    const chunkKeysBefore = (await layerStore.keys())
      .filter((key) => key.startsWith('hierarchy:chunk:'));
    assert.ok(chunkKeysBefore.length > 0);
    for (const key of await layerStore.keys())
      if (key.startsWith('hierarchy:document:')) await layerStore.delete(key);
    assert.equal(
      (await layerStore.keys()).filter((key) => key.startsWith('hierarchy:document:')).length,
      0,
    );

    phase = 'fail';
    requests.length = 0;
    await assert.rejects(
      provider.analyzeDocument(documentInput({ pages: paperPages, resume: true, signal: controller.signal })),
      failure === 'length' ? /输出被截断/ : /final aborted/,
      `${failure} final regeneration must fail`,
    );

    assert.equal(
      requests.filter((request) => isChunkPrompt(userPrompt(request))).length,
      0,
      `${failure}: the validated chunk checkpoint must be reused`,
    );
    assert.equal(
      requests.filter((request) => isFinalPrompt(userPrompt(request))).length,
      1,
      `${failure}: exactly one failed final request is made`,
    );
    assert.equal(
      JSON.stringify(await digestStore.get(digestKey)),
      digestBefore,
      `${failure}: the existing digest must stay untouched`,
    );
    assert.equal(
      (await layerStore.keys()).filter((key) => key.startsWith('hierarchy:document:')).length,
      0,
      `${failure}: no final layer may be saved`,
    );
    const keysAfter = await layerStore.keys();
    for (const key of chunkKeysBefore)
      assert.ok(keysAfter.includes(key), `${failure}: validated chunk checkpoints must remain`);
  }
});

// ---------------------------------------------------------------------------
// 7. Structure-only repair keeps exact chunk prose and never repeats sections.
// ---------------------------------------------------------------------------
void test('structure-only repair preserves exact chunk prose and does not repeat sections', async () => {
  const pages = [
    `第1章 基础\n\n1.1 定义\n\n定义：质量 m 为正。\n\n${formula}\n\n${table}\n\n结论：能量正比于质量。`,
  ];
  const scientificSection = {
    title: '第一章 基础',
    summary: '定义与结论。',
    points: [
      { text: '1.1 定义', pageStart: 1, pageEnd: 1 },
      { text: '定义：质量 m 为正。', pageStart: 1, pageEnd: 1 },
      { text: formula, pageStart: 1, pageEnd: 1 },
      { text: table, pageStart: 1, pageEnd: 1 },
      { text: '结论：能量正比于质量。', pageStart: 1, pageEnd: 1 },
    ],
    pageStart: 1,
    pageEnd: 1,
  };
  const invalidFlatDraft = {
    hierarchy: { mode: 'flat', reason: '错误地声明为平坦材料。' },
    title: '草稿标题',
    overview: '草稿概述。',
    sections: [
      { title: '错误章节', summary: '错误摘要', pageStart: 1, pageEnd: 1, points: [{ text: '错误要点', pageStart: 1, pageEnd: 1 }] },
    ],
    concepts: [
      { id: 'c1', parentId: null, label: '一级要点', description: '一级说明', sources: [pdfSource('lecture', 'lecture.pdf', 1)] },
      { id: 'c2', parentId: null, label: '二级要点', description: '二级说明', sources: [pdfSource('lecture', 'lecture.pdf', 1)] },
      { id: 'c3', parentId: null, label: '三级要点', description: '三级说明', sources: [pdfSource('lecture', 'lecture.pdf', 1)] },
    ],
    relations: [],
    unresolvedQuestions: [],
  };
  const repair = {
    hierarchy: { mode: 'structured', reason: '第1章与1.1提供章→节→要点结构。' },
    assignments: [
      { id: 'c1', parentId: null },
      { id: 'c2', parentId: 'c1' },
      { id: 'c3', parentId: 'c2' },
    ],
    branches: [],
    relations: [],
  };

  const requests: RequestBody[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const request = parseRequest(init);
    requests.push(request);
    const prompt = userPrompt(request);
    if (isChunkPrompt(prompt)) {
      return streamJson(chunkPayload({
        documentId: 'lecture',
        fileName: 'lecture.pdf',
        page: 1,
        title: scientificSection.title,
        summary: scientificSection.summary,
        points: scientificSection.points,
        conceptLabel: '分块概念',
      }));
    }
    if (isRepairPrompt(prompt)) return streamJson(repair);
    return streamJson(invalidFlatDraft);
  }) as typeof fetch;

  const provider = createKnowledgeProviderForSettings(
    modeSettings(proxySettings, 'fast'),
    fetchImpl,
    createKnowledgeDigestCache(createMemoryStore()),
    createMemoryStore(),
  );
  const digest = await provider.analyzeDocument(documentInput({ pages }));

  assert.equal(
    requests.filter((request) => isRepairPrompt(userPrompt(request))).length,
    1,
    'the invalid flat tree must trigger exactly one structure-only repair',
  );
  assert.ok(
    digest.diagnostics?.some((diagnostic) => diagnostic.detail.includes('结构') || diagnostic.detail.includes('脑图')),
    'the invalid hierarchy rejection must be reported',
  );
  assert.deepEqual(sectionShape(digest.sections), [scientificSection]);
  assert.ok(
    digest.sections.every((section) => section.title !== '错误章节' && section.summary !== '错误摘要'),
    'the deliberately wrong final sections must be ignored',
  );

});
