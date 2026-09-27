import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import { buildPdfChunks } from '../lib/knowledge/pdf-chunks.ts';
import { settings, reply, source } from './fixtures/hierarchical-synthesis.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function streamResponse(value: unknown, status = 200): Response {
  if (status !== 200) {
    return new Response(
      JSON.stringify({ error: { message: 'first failure' } }),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    );
  }
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })}\n`,
    'data: [DONE]\n',
  ].join('\n');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function pages() {
  return Array.from(
    { length: 3 },
    (_, index) => `第 ${index + 1} 页\n${'页面内容。'.repeat(1400)}`,
  );
}

function chunkReply(page: number) {
  const result = reply('lecture', page);
  result.sections[0]!.title = `第 ${page} 页`;
  result.concepts[0]!.id = `page-${page}`;
  result.concepts[0]!.label = `page-${page}`;
  result.concepts[0]!.sources = [source('lecture', page)];
  return result;
}

type Gate = {
  page: number;
  request: ReturnType<typeof deferred<Response>>;
  signal?: AbortSignal;
};

function createGatedProvider() {
  const gates: Gate[] = [];
  const startedPages: number[] = [];
  const firstBatch = deferred<void>();
  const thirdStarted = deferred<void>();
  let active = 0;
  let maximumActive = 0;
  let finalPrompt = '';

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as {
      messages?: Array<{ content?: string }>;
    };
    const prompt = body.messages?.[1]?.content ?? '';
    if (!prompt.includes('分析以下 PDF 分块')) {
      finalPrompt = prompt;
      return streamResponse(reply());
    }

    const page = Number(/<page number="(\d+)"/.exec(prompt)?.[1] ?? 0);
    startedPages.push(page);
    if (startedPages.length === 2) firstBatch.resolve();
    if (startedPages.length === 3) thirdStarted.resolve();
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const request = deferred<Response>();
    const requestSignal = init?.signal ?? undefined;
    const gate: Gate = { page, request, signal: requestSignal };
    gates.push(gate);
    request.promise.then(
      () => {
        active -= 1;
      },
      () => {
        active -= 1;
      },
    );
    requestSignal?.addEventListener(
      'abort',
      () => {
        request.reject(requestSignal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
    return request.promise;
  }) as typeof fetch;

  const provider = createKnowledgeProviderForSettings(
    settings,
    fetchImpl,
    createKnowledgeDigestCache(createMemoryStore()),
    createMemoryStore(),
  );
  return {
    provider,
    gates,
    startedPages,
    firstBatch,
    thirdStarted,
    get maximumActive() {
      return maximumActive;
    },
    get finalPrompt() {
      return finalPrompt;
    },
  };
}

void test('analyzes original chunks with two real fetches and preserves chunk order', async () => {
  const inputPages = pages();
  assert.equal(buildPdfChunks(inputPages).length, 3);
  const m = createGatedProvider();
  const resultPromise = m.provider.analyzeDocument({
    documentId: 'lecture',
    fingerprint: 'fingerprint',
    fileName: 'lecture.pdf',
    pages: inputPages,
  });

  await m.firstBatch.promise;
  assert.deepEqual(m.startedPages, [1, 2]);
  assert.equal(m.maximumActive, 2);
  assert.equal(
    m.gates.some((gate) => gate.page === 3),
    false,
  );

  m.gates
    .find((gate) => gate.page === 2)!
    .request.resolve(streamResponse(chunkReply(2)));
  await m.thirdStarted.promise;
  assert.deepEqual(m.startedPages, [1, 2, 3]);
  assert.equal(m.maximumActive, 2);

  m.gates
    .find((gate) => gate.page === 1)!
    .request.resolve(streamResponse(chunkReply(1)));
  m.gates
    .find((gate) => gate.page === 3)!
    .request.resolve(streamResponse(chunkReply(3)));
  const digest = await resultPromise;
  assert.ok(digest.title);
  assert.ok(m.finalPrompt.indexOf('page-1') < m.finalPrompt.indexOf('page-2'));
  assert.ok(m.finalPrompt.indexOf('page-2') < m.finalPrompt.indexOf('page-3'));
});

void test('the first chunk failure aborts active work and never starts the queued chunk', async () => {
  const m = createGatedProvider();
  const resultPromise = m.provider.analyzeDocument({
    documentId: 'lecture',
    fingerprint: 'fingerprint-failure',
    fileName: 'lecture.pdf',
    pages: pages(),
  });

  await m.firstBatch.promise;
  assert.deepEqual(m.startedPages, [1, 2]);
  m.gates
    .find((gate) => gate.page === 1)!
    .request.resolve(streamResponse({}, 500));

  await assert.rejects(resultPromise, /服务/);
  assert.deepEqual(m.startedPages, [1, 2]);
  assert.equal(m.gates.find((gate) => gate.page === 2)!.signal?.aborted, true);
  assert.equal(m.maximumActive, 2);
});
