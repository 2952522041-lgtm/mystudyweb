import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
  KnowledgeError,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore, type KVStore } from '../lib/reader-cache.ts';
import type { SynthesisDiagnostic } from '../lib/knowledge/hierarchical-synthesis.ts';
import type { DocumentDigest } from '../lib/course-storage/types.ts';

const SETTINGS = {
  baseUrl: 'https://deepseek.example/v1',
  apiKey: 'test-key',
  model: 'deepseek-flash',
};
const DOCUMENT_ID = 'truncation-recovery';
const FILE_NAME = 'truncation-recovery.pdf';
const PAGE_MARKERS = [
  'PAGE_1_CONTENT_MARKER',
  'PAGE_2_CONTENT_MARKER',
  'PAGE_3_CONTENT_MARKER',
];
const TRUNCATED_MARKER = 'TRUNCATED_COMPLETE_JSON_MUST_NOT_SURVIVE';

interface RequestMessage {
  role?: string;
  content?: string;
}

interface RequestBody {
  messages?: RequestMessage[];
  max_tokens?: number;
  model?: string;
  thinking?: unknown;
}

interface RequestRecord {
  body: RequestBody;
  layer: 'chunk' | 'document';
  page?: number;
  part: boolean;
  finishReason: string;
  content: string;
}

function streamJson(value: unknown, finishReason = 'stop'): Response {
  const content = JSON.stringify(value);
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function userPrompt(body: RequestBody): string {
  return (
    body.messages?.find((message) => message.role === 'user')?.content ?? ''
  );
}

function markersIn(text: string): string[] {
  return [...new Set(text.match(/PAGE_[1-3]_CONTENT_MARKER/g) ?? [])].sort(
    (a, b) => a.localeCompare(b),
  );
}

function pagesForMarkers(markers: string[]): number[] {
  return markers
    .map((marker) => PAGE_MARKERS.indexOf(marker) + 1)
    .filter((page) => page > 0)
    .sort((a, b) => a - b);
}

function chunkPayload(
  page: number,
  marker: string,
  suffix = '',
): Record<string, unknown> {
  const id = `chunk-${page}-${suffix || 'whole'}`;
  return {
    title: `第${page}页`,
    overview: marker,
    sections: [
      {
        title: `第${page}页主题`,
        summary: marker,
        points: [{ text: marker, pageStart: page, pageEnd: page }],
        pageStart: page,
        pageEnd: page,
      },
    ],
    concepts: [
      {
        id,
        parentId: null,
        label: `第${page}页概念${suffix ? ` ${suffix}` : ''}`,
        description: marker,
        sources: [
          {
            documentId: DOCUMENT_ID,
            fileName: FILE_NAME,
            pageStart: page,
            pageEnd: page,
          },
        ],
      },
    ],
    relations: [],
    unresolvedQuestions: [],
  };
}

function documentPayload(
  markers: string[],
  pages = pagesForMarkers(markers),
): Record<string, unknown> {
  const safeMarkers = markers.length ? markers : PAGE_MARKERS;
  const safePages = pages.length ? pages : pagesForMarkers(safeMarkers);
  const points = safeMarkers.map((marker) => {
    const page = PAGE_MARKERS.indexOf(marker) + 1;
    return { text: marker, pageStart: page, pageEnd: page };
  });
  return {
    hierarchy: { mode: 'flat', reason: '夹具材料没有显式章节层级。' },
    title: '截断恢复文档',
    overview: safeMarkers.join(' | '),
    sections: [
      {
        title: '全部页码',
        summary: safeMarkers.join(' | '),
        points,
        pageStart: Math.min(...safePages),
        pageEnd: Math.max(...safePages),
      },
    ],
    concepts: [
      {
        id: 'all-markers',
        parentId: null,
        label: '截断恢复后的完整材料',
        description: safeMarkers.join(' | '),
        sources: safePages.map((page) => ({
          documentId: DOCUMENT_ID,
          fileName: FILE_NAME,
          pageStart: page,
          pageEnd: page,
        })),
      },
    ],
    relations: [],
    unresolvedQuestions: [],
    sourcePages: safePages,
  };
}

function pages(): string[] {
  return PAGE_MARKERS.map(
    (marker) => `${marker}\n${'正文内容。'.repeat(2200)}`,
  );
}

function createProvider(
  fetchImpl: typeof fetch,
  digestStore: KVStore<DocumentDigest> = createMemoryStore<DocumentDigest>(),
  layerStore: KVStore<unknown> = createMemoryStore<unknown>(),
) {
  return {
    provider: createKnowledgeProviderForSettings(
      SETTINGS,
      fetchImpl,
      createKnowledgeDigestCache(digestStore),
      layerStore,
    ),
    digestStore,
    layerStore,
  };
}

void test('length-finished chunks are discarded, split, and recovered without recomputing completed pages', async () => {
  const requests: RequestRecord[] = [];
  const digestStore = createMemoryStore<DocumentDigest>();
  const layerStore = createMemoryStore<unknown>();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as RequestBody;
    const prompt = userPrompt(body);
    const isChunk = prompt.startsWith('分析以下 PDF 分块');
    const page = Number(/<page number="(\d+)"/.exec(prompt)?.[1] ?? 0);
    const part = / part="\d+"/.test(prompt);
    const marker = PAGE_MARKERS[page - 1] ?? PAGE_MARKERS[0]!;
    let payload: Record<string, unknown>;
    let finishReason = 'stop';
    if (isChunk) {
      payload = chunkPayload(page, marker, part ? 'recovered-part' : 'whole');
      if (page === 2 && !part) {
        // This is deliberately valid JSON: finish_reason must take precedence
        // over parsing success, so this response cannot enter the layer cache.
        payload = chunkPayload(page, marker, TRUNCATED_MARKER);
        finishReason = 'length';
      }
    } else {
      payload = documentPayload(markersIn(prompt));
    }
    const content = JSON.stringify(payload);
    requests.push({
      body,
      layer: isChunk ? 'chunk' : 'document',
      page: isChunk ? page : undefined,
      part,
      finishReason,
      content,
    });
    return streamJson(payload, finishReason);
  }) as typeof fetch;
  const { provider } = createProvider(fetchImpl, digestStore, layerStore);
  const diagnostics: SynthesisDiagnostic[] = [];

  const digest = await provider.analyzeDocument({
    documentId: DOCUMENT_ID,
    fingerprint: 'truncation-recovery-fingerprint',
    fileName: FILE_NAME,
    pages: pages(),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  const chunkRequests = requests.filter((request) => request.layer === 'chunk');
  assert.ok(requests.length > 0);
  assert.equal(
    new Set(requests.map((request) => request.body.max_tokens)).size,
    1,
  );
  assert.equal(requests[0]?.body.max_tokens, 8192);
  assert.equal(
    requests.every((request) => request.body.model === SETTINGS.model),
    true,
  );
  assert.equal(
    requests.every((request) => request.body.thinking === undefined),
    true,
  );
  assert.equal(
    chunkRequests.filter(
      (request) => request.page === 1 && request.finishReason === 'stop',
    ).length,
    1,
  );
  assert.equal(
    chunkRequests.filter(
      (request) => request.page === 3 && request.finishReason === 'stop',
    ).length,
    1,
  );
  assert.ok(
    chunkRequests.some(
      (request) =>
        request.page === 2 &&
        request.finishReason === 'length' &&
        !request.part,
    ),
  );
  assert.ok(
    chunkRequests.filter(
      (request) =>
        request.page === 2 && request.finishReason === 'stop' && request.part,
    ).length >= 2,
  );

  assert.deepEqual(digest.sourcePages, [1, 2, 3]);
  const digestText = JSON.stringify(digest);
  for (const marker of PAGE_MARKERS)
    assert.match(digestText, new RegExp(marker));
  assert.doesNotMatch(digestText, new RegExp(TRUNCATED_MARKER));
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.layer === 'chunk' &&
        diagnostic.action === 'split' &&
        /输出被截断/.test(diagnostic.detail),
    ),
  );
  assert.ok(
    diagnostics.every(
      (diagnostic) =>
        diagnostic.droppedBytes === 0 || diagnostic.action === 'rejected',
    ),
  );
  for (const key of await layerStore.keys()) {
    assert.doesNotMatch(
      JSON.stringify(await layerStore.get(key)),
      new RegExp(TRUNCATED_MARKER),
    );
  }
  assert.equal((await digestStore.keys()).length, 1);
});

void test('a truncated final document synthesis is reduced through intermediate batches and succeeds', async () => {
  const requests: RequestRecord[] = [];
  let finalAttempts = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as RequestBody;
    const prompt = userPrompt(body);
    const isChunk = prompt.startsWith('分析以下 PDF 分块');
    const intermediate =
      prompt.includes('当前只是中间压缩') ||
      prompt.includes('这是分层中间归并');
    const markers = markersIn(prompt);
    const pageNumbers = pagesForMarkers(markers);
    let payload: Record<string, unknown>;
    let finishReason = 'stop';
    if (isChunk) {
      const page = Number(/<page number="(\d+)"/.exec(prompt)?.[1] ?? 1);
      const marker = PAGE_MARKERS[page - 1] ?? PAGE_MARKERS[0]!;
      payload = chunkPayload(page, marker, 'large-output');
      payload.sections = [
        {
          ...(payload.sections as Array<Record<string, unknown>>)[0],
          summary: `${marker}:${'long chunk summary '.repeat(430)}`,
        },
      ];
    } else if (intermediate) {
      payload = documentPayload(markers, pageNumbers);
    } else {
      finalAttempts += 1;
      payload = documentPayload(PAGE_MARKERS, [1, 2, 3]);
      if (finalAttempts === 1) {
        // The object is complete, but the provider must reject it solely from
        // the finish reason and ask the bounded reducer to make smaller calls.
        payload.overview = TRUNCATED_MARKER;
        finishReason = 'length';
      }
    }
    const content = JSON.stringify(payload);
    requests.push({
      body,
      layer: isChunk ? 'chunk' : 'document',
      page: isChunk
        ? Number(/<page number="(\d+)"/.exec(prompt)?.[1] ?? 0)
        : undefined,
      part: / part="\d+"/.test(prompt),
      finishReason,
      content,
    });
    return streamJson(payload, finishReason);
  }) as typeof fetch;
  const { provider } = createProvider(fetchImpl);
  const diagnostics: SynthesisDiagnostic[] = [];

  const digest = await provider.analyzeDocument({
    documentId: DOCUMENT_ID,
    fingerprint: 'document-final-truncation-fingerprint',
    fileName: FILE_NAME,
    pages: pages(),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  const chunkRequests = requests.filter((request) => request.layer === 'chunk');
  const documentRequests = requests.filter(
    (request) => request.layer === 'document',
  );
  assert.equal(chunkRequests.length, 3);
  assert.equal(
    documentRequests.filter((request) => request.finishReason === 'length')
      .length,
    1,
  );
  assert.equal(finalAttempts, 2);
  assert.ok(
    documentRequests.some(
      (request) =>
        request.finishReason === 'stop' &&
        userPrompt(request.body).includes('当前只是中间压缩'),
    ),
  );
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.layer === 'document' &&
        diagnostic.action === 'split' &&
        /模型输出被截断/.test(diagnostic.detail),
    ),
  );
  assert.equal(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.layer === 'document' &&
        diagnostic.action === 'split' &&
        /上下文不足/.test(diagnostic.detail),
    ),
    false,
  );
  assert.deepEqual(digest.sourcePages, [1, 2, 3]);
  for (const marker of PAGE_MARKERS)
    assert.match(JSON.stringify(digest), new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(digest), new RegExp(TRUNCATED_MARKER));
});

void test('a very small chunk that stays truncated fails once without splitting or caching a partial result', async () => {
  const requests: RequestRecord[] = [];
  const digestStore = createMemoryStore<DocumentDigest>();
  const layerStore = createMemoryStore<unknown>();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as RequestBody;
    const prompt = userPrompt(body);
    const page = Number(/<page number="(\d+)"/.exec(prompt)?.[1] ?? 1);
    const marker = 'TINY_TRUNCATED_JSON';
    const payload = chunkPayload(page, marker, 'tiny');
    requests.push({
      body,
      layer: 'chunk',
      page,
      part: / part="\d+"/.test(prompt),
      finishReason: 'length',
      content: JSON.stringify(payload),
    });
    return streamJson(payload, 'length');
  }) as typeof fetch;
  const { provider } = createProvider(fetchImpl, digestStore, layerStore);
  const diagnostics: SynthesisDiagnostic[] = [];

  await assert.rejects(
    provider.analyzeDocument({
      documentId: DOCUMENT_ID,
      fingerprint: 'tiny-truncation-fingerprint',
      fileName: FILE_NAME,
      pages: ['TINY_PAGE'],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }),
    (error: unknown) =>
      error instanceof KnowledgeError && error.code === 'truncated',
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.part, false);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.action === 'split'),
    false,
  );
  assert.equal((await digestStore.keys()).length, 0);
  assert.equal((await layerStore.keys()).length, 0);
});

void test('authorization errors are not treated as recoverable size failures', async () => {
  const requests: RequestBody[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    requests.push(
      JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      ) as RequestBody,
    );
    return Response.json(
      { error: { message: 'invalid api key' } },
      { status: 401 },
    );
  }) as typeof fetch;
  const { provider } = createProvider(fetchImpl);
  const diagnostics: SynthesisDiagnostic[] = [];

  await assert.rejects(
    provider.analyzeDocument({
      documentId: DOCUMENT_ID,
      fingerprint: 'auth-truncation-fingerprint',
      fileName: FILE_NAME,
      pages: [`AUTH_PAGE_MARKER\n${'正文内容。'.repeat(2200)}`],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }),
    (error: unknown) =>
      error instanceof Error && (error as { code?: unknown }).code === 'auth',
  );
  assert.equal(requests.length, 1);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.action === 'split'),
    false,
  );
});
