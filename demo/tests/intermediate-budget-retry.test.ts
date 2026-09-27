import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import { renderDocumentSummary } from '../lib/knowledge/artifact-renderer.ts';
import {
  lecturePages,
  reply,
  settings,
} from './fixtures/hierarchical-synthesis.ts';

const POINT_TEXT = '关键证据：归并后仍保留原文页码、公式和适用条件。';

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
      const value = JSON.parse(line) as unknown;
      if (Array.isArray(value)) return value;
    } catch {
      // The prompt schema example is not the input records array.
    }
  }
  return [];
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

function intermediateResponse(prompt: string, overview: string, points: unknown[]) {
  const page = firstPage(parseInputRecords(prompt));
  return {
    title: '紧凑中间材料',
    overview,
    sections: [{
      title: '中间索引',
      summary: '按本批材料保留的简短主题索引。',
      points,
      pageStart: page,
      pageEnd: page,
    }],
    concepts: [{
      id: 'intermediate-concept',
      parentId: null,
      label: '中间概念',
      description: '保留本批材料的独有事实。',
      sources: [{ documentId: 'lecture', pageStart: page, pageEnd: page }],
    }],
    relations: [],
    unresolvedQuestions: [],
  };
}

function createBudgetRetryMock() {
  const requests: RequestBody[] = [];
  let budgetFailureSent = false;
  let budgetRetries = 0;
  let finalCalls = 0;

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as RequestBody;
    requests.push(request);
    const prompt = request.messages?.[1]?.content ?? '';
    const chunk = prompt.includes('分析以下 PDF 分块');
    const intermediate = prompt.includes('当前只是中间压缩') || prompt.includes('这是分层中间归并');
    const retry = request.messages?.some((message) =>
      message.role === 'assistant' && message.content?.includes('上次输出未通过校验')) ?? false;

    if (chunk) {
      const page = Number(/<page number="(\d+)"/.exec(prompt)?.[1] ?? 1);
      const result = reply('lecture', page, true);
      if (page === 1) {
        (result.sections as Array<Record<string, unknown>>)[0]!.points = [{
          text: POINT_TEXT,
          pageStart: page,
          pageEnd: page,
        }];
      }
      return streamResponse(result);
    }

    if (intermediate) {
      if (retry) {
        budgetRetries += 1;
        const retryInstruction = request.messages?.at(-1)?.content ?? '';
        assert.match(retryInstruction, /中间归并未满足预算/);
        return streamResponse(intermediateResponse(prompt, '紧凑中间摘要。', []));
      }
      if (!budgetFailureSent) {
        budgetFailureSent = true;
        return streamResponse(intermediateResponse(prompt, 'x'.repeat(25_000), [{
          text: POINT_TEXT,
          pageStart: firstPage(parseInputRecords(prompt)),
          pageEnd: firstPage(parseInputRecords(prompt)),
        }]));
      }
      return streamResponse(intermediateResponse(prompt, '紧凑中间摘要。', []));
    }

    finalCalls += 1;
    const result = reply('lecture', 1);
    result.overview = '最终摘要保留应用证据账本。';
    return streamResponse(result);
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
    get budgetRetries() { return budgetRetries; },
    get finalCalls() { return finalCalls; },
  };
}

void test('retries one oversized intermediate response and restores critical chunk evidence in the final digest', async () => {
  const mock = createBudgetRetryMock();
  const digest = await mock.provider.analyzeDocument({
    documentId: 'lecture',
    fingerprint: 'intermediate-budget-retry',
    fileName: 'lecture.pdf',
    pages: lecturePages,
    bypassCache: true,
  });

  assert.equal(mock.budgetRetries, 1);
  assert.equal(mock.finalCalls, 1);
  assert.equal(digest.documentId, 'lecture');
  assert.ok(digest.sections.length > 0);
  assert.ok(digest.concepts.length > 0);
  assert.ok(digest.concepts.every((concept) =>
    concept.sources.every((source) => source.documentId === 'lecture' && source.fileName === 'lecture.pdf')));

  const evidence = digest.evidence?.find((item) => item.text === POINT_TEXT);
  assert.ok(evidence, 'the original chunk point must remain in the evidence ledger');
  assert.deepEqual(evidence.sources.map((source) => source.pageStart), [1]);
  assert.ok(
    digest.sections.some((section) => section.points?.some((point) => point.text === POINT_TEXT)),
    'the final digest must restore the critical point into its summary sections',
  );
  assert.match(renderDocumentSummary(digest), new RegExp(POINT_TEXT));

  const budgetRetry = mock.requests.filter((request) =>
    request.messages?.some((message) =>
      message.role === 'user' && message.content?.includes('中间归并未满足预算')),
  );
  assert.equal(budgetRetry.length, 1);
  assert.match(budgetRetry[0]!.messages?.at(-1)?.content ?? '', /points 使用 \[\]/);
  assert.match(budgetRetry[0]!.messages?.at(-1)?.content ?? '', /原始全部要点、公式和表格/);
});
