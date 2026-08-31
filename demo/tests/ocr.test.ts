import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOcrCache,
  createOcrProviderForSettings,
  normalizeOcrText,
  pageNeedsOcr,
  resolvePageOcr,
  type CachedOcr,
  type OcrRequest,
} from '../lib/ocr.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';

const request: OcrRequest = {
  fingerprint: 'scan-fingerprint',
  pageNumber: 2,
  pageImage: {
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,c2Nhbg==',
    width: 1200,
    height: 1600,
  },
};

void test('OCR detection distinguishes text pages from scanned pages', () => {
  assert.equal(pageNeedsOcr('  '), true);
  assert.equal(pageNeedsOcr('short'), true);
  assert.equal(
    pageNeedsOcr('A normal PDF page contains enough extractable text.'),
    false,
  );
  assert.equal(
    normalizeOcrText('```text\n识别结果：\nHello $x^2$\n```'),
    'Hello $x^2$',
  );
});

void test('visual OCR reuses chat vision settings and sends only the page image', async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url, init) => {
    if (typeof init?.body !== 'string')
      throw new Error('expected a JSON request body');
    body = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(
      'data: {"choices":[{"delta":{"content":"```text\\nHandwritten $x^2$\\n```"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;
  const provider = createOcrProviderForSettings(
    {
      baseUrl: 'https://example.com/v1/',
      apiKey: 'secret',
      model: 'vision-model',
      visionConfirmed: true,
    },
    fetchImpl,
  );
  const result = await provider.recognize(request);
  assert.equal(result.text, 'Handwritten $x^2$');
  const messages = body?.messages as Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
  }>;
  const context = messages[1].content as Array<Record<string, unknown>>;
  assert.equal(context[1].type, 'image_url');
  const instruction = messages.at(-1)?.content;
  assert.equal(typeof instruction, 'string');
  assert.match(instruction as string, /Perform OCR/);
  assert.doesNotMatch(JSON.stringify(body), /secret/);
});

void test('OCR results are cached by document, page, provider, model and prompt', async () => {
  const cache = createOcrCache(createMemoryStore<CachedOcr>());
  let calls = 0;
  const provider = {
    id: 'vision:https://example.com/v1',
    model: 'vision-model',
    async recognize() {
      calls += 1;
      return { text: 'recognized text', provider: this.id, model: this.model };
    },
  };

  const first = await resolvePageOcr({ provider, cache, request });
  const second = await resolvePageOcr({ provider, cache, request });

  assert.equal(first.status, 'complete');
  assert.equal(second.status, 'cached');
  assert.equal(second.result.text, 'recognized text');
  assert.equal(calls, 1);
});
