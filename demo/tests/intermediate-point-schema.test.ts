import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
  KnowledgeError,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import {
  lecturePages,
  reply,
  settings,
} from './fixtures/hierarchical-synthesis.ts';

const POINT_TEXT = '关键要点：归并后仍保留原文页码。';

type Message = { role?: string; content?: string };
type RequestBody = { messages?: Message[] };

function streamResponse(value: unknown): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })}\n`,
    'data: [DONE]\n',
  ].join('\n');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function parseInputRecords(prompt: string): unknown[] {
  for (const line of prompt.split('\n')) {
    if (!line.trimStart().startsWith('[')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // The schema example is an object; only the array carrying input matters.
    }
  }
  return [];
}

interface Point {
  text: string;
  pageStart: number;
  pageEnd: number;
}

function pointObjects(value: unknown, result: Point[] = []): Point[] {
  if (Array.isArray(value)) {
    for (const child of value) pointObjects(child, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  const object = value as Record<string, unknown>;
  if (
    typeof object.text === 'string' &&
    typeof object.pageStart === 'number' &&
    typeof object.pageEnd === 'number'
  ) {
    result.push({
      text: object.text,
      pageStart: object.pageStart,
      pageEnd: object.pageEnd,
    });
  }
  for (const child of Object.values(object)) pointObjects(child, result);
  return result;
}

function firstPage(value: unknown): number {
  if (Array.isArray(value)) {
    for (const child of value) {
      const page = firstPage(child);
      if (page > 0) return page;
    }
    return 1;
  }
  if (!value || typeof value !== 'object') return 0;
  const object = value as Record<string, unknown>;
  if (typeof object.pageStart === 'number') return object.pageStart;
  for (const child of Object.values(object)) {
    const page = firstPage(child);
    if (page > 0) return page;
  }
  return 0;
}

function uniquePoints(points: Point[]): Point[] {
  return [
    ...new Map(
      points.map((point) => [
        `${point.text}:${point.pageStart}:${point.pageEnd}`,
        point,
      ]),
    ).values(),
  ];
}

function addPoints(result: ReturnType<typeof reply>, points: unknown[]) {
  (result.sections as Array<Record<string, unknown>>)[0]!.points = points;
  return result;
}

function isIntermediate(prompt: string): boolean {
  return (
    prompt.includes('当前只是中间压缩') || prompt.includes('这是分层中间归并')
  );
}

function createDocumentMock(options: { invalidPointPage?: number } = {}) {
  const requests: RequestBody[] = [];
  let malformedIntermediateSent = false;
  let intermediateRetries = 0;
  let finalDocumentCalls = 0;
  let firstIntermediatePage = 0;

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as RequestBody;
    requests.push(request);
    const prompt = request.messages?.[1]?.content ?? '';
    const chunk = prompt.includes('分析以下 PDF 分块');
    const intermediate = isIntermediate(prompt);

    if (chunk) {
      const page = Number(/<page number="(\d+)"/.exec(prompt)?.[1] ?? 1);
      const result = reply('lecture', page, true);
      return streamResponse(
        addPoints(result, [
          {
            text: POINT_TEXT,
            pageStart: page,
            pageEnd: page,
          },
        ]),
      );
    }

    const retry =
      request.messages?.some(
        (message) =>
          message.role === 'assistant' &&
          message.content?.includes('上次输出未通过校验'),
      ) ?? false;
    if (intermediate) {
      if (retry) intermediateRetries += 1;
      const records = parseInputRecords(prompt);
      const inputPoints = pointObjects(records);
      const page = firstPage(records);
      if (!firstIntermediatePage) firstIntermediatePage = page;
      const pointPage =
        options.invalidPointPage ?? inputPoints[0]?.pageStart ?? page;
      const points: Point[] = options.invalidPointPage
        ? [{ text: POINT_TEXT, pageStart: pointPage, pageEnd: pointPage }]
        : uniquePoints([
            ...(inputPoints.length ? [inputPoints[0]!] : []),
            { text: POINT_TEXT, pageStart: pointPage, pageEnd: pointPage },
          ]);
      const result = {
        title: '中间材料',
        overview: '中间摘要',
        sections: [
          {
            title: '中间小节',
            summary: '中间概括',
            points,
            pageStart: page,
            pageEnd: page,
          },
        ],
        concepts: [
          {
            id: `intermediate-${requests.length}`,
            parentId: null,
            label: '中间概念',
            description: '保留页码的中间概念。',
            sources: [
              { documentId: 'lecture', pageStart: page, pageEnd: page },
            ],
          },
        ],
        relations: [],
        unresolvedQuestions: [],
      };
      if (!options.invalidPointPage && !malformedIntermediateSent && !retry) {
        malformedIntermediateSent = true;
        (result.sections as Array<Record<string, unknown>>)[0]!.points = [
          POINT_TEXT,
        ];
      }
      return streamResponse(result);
    }

    finalDocumentCalls += 1;
    const records = parseInputRecords(prompt);
    const points = uniquePoints(pointObjects(records));
    const point = points.find((item) => item.text === POINT_TEXT) ?? {
      text: POINT_TEXT,
      pageStart: firstPage(records),
      pageEnd: firstPage(records),
    };
    const result = reply('lecture', point.pageStart);
    return streamResponse(addPoints(result, [point]));
  }) as typeof fetch;

  const provider = createKnowledgeProviderForSettings(
    settings,
    fetchImpl,
    createKnowledgeDigestCache(createMemoryStore()),
    createMemoryStore(),
  );
  return {
    provider,
    requests,
    get malformedIntermediateSent() {
      return malformedIntermediateSent;
    },
    get intermediateRetries() {
      return intermediateRetries;
    },
    get finalDocumentCalls() {
      return finalDocumentCalls;
    },
    get firstIntermediatePage() {
      return firstIntermediatePage;
    },
  };
}

function documentInput() {
  return {
    documentId: 'lecture',
    fingerprint: 'intermediate-point-schema',
    fileName: 'lecture.pdf',
    pages: lecturePages,
  };
}

void test('document intermediate compression specifies object points and preserves their evidence', async () => {
  const mock = createDocumentMock();
  const digest = await mock.provider.analyzeDocument(documentInput());
  const intermediateRequests = mock.requests.filter((request) =>
    isIntermediate(request.messages?.[1]?.content ?? ''),
  );
  assert.ok(
    intermediateRequests.length >= 2,
    'long document should use document intermediate reduction',
  );

  const intermediatePrompt =
    intermediateRequests[0]!.messages?.[1]?.content ?? '';
  assert.match(
    intermediatePrompt,
    /"points":\[\{"text":"要点内容","pageStart":1,"pageEnd":1\}\]/,
  );
  assert.match(intermediatePrompt, /sections\[i\]\.points 可为 \[\]/);
  assert.match(
    intermediatePrompt,
    /每项必须是含 text\/pageStart\/pageEnd 的对象/,
  );
  assert.match(intermediatePrompt, /禁止字符串数组/);
  assert.match(intermediatePrompt, /页码必须来自本批材料/);

  assert.equal(mock.malformedIntermediateSent, true);
  assert.equal(mock.intermediateRetries, 1);
  const repairRequest = mock.requests.find((request) =>
    request.messages?.some(
      (message) =>
        message.role === 'assistant' &&
        message.content?.includes('上次输出未通过校验'),
    ),
  );
  assert.ok(repairRequest, 'malformed point should trigger a targeted retry');
  const repairPrompt = repairRequest.messages?.at(-1)?.content ?? '';
  assert.match(repairPrompt, /单文档综合 sections\[0\]\.points\[0\]/);
  assert.match(repairPrompt, /text\/pageStart\/pageEnd/);

  assert.equal(mock.finalDocumentCalls, 1);
  assert.deepEqual(digest.sourcePages, [1, 2, 3, 4, 5, 6]);
  const point = digest.sections
    .flatMap((section) => section.points ?? [])
    .find((item) => item.text === POINT_TEXT);
  assert.ok(
    point,
    'the corrected point should remain in the final document digest',
  );
  assert.equal(point.pageStart, mock.firstIntermediatePage);
  assert.equal(point.pageEnd, mock.firstIntermediatePage);
  const evidence = digest.evidence?.find((item) => item.text === POINT_TEXT);
  assert.ok(evidence, 'point text should remain in final evidence');
  assert.deepEqual(
    evidence.sources.map((source) => source.pageStart),
    [1, 2, 3, 4, 5, 6],
  );
});

void test('document intermediate point pages outside the PDF are rejected', async () => {
  const mock = createDocumentMock({
    invalidPointPage: lecturePages.length + 1,
  });
  await assert.rejects(
    mock.provider.analyzeDocument(documentInput()),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, 'invalid_source_pages');
      return true;
    },
  );
  assert.equal(mock.finalDocumentCalls, 0);
});
