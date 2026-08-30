import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TranslationError,
  classifyHttpError,
  createMockTranslationProvider,
  createOpenAICompatibleProvider,
  parseParagraphList,
  recommendedMaxOutputTokens,
  shouldAutoRetry,
  translateWithRetry,
  translationCacheKey,
} from '../lib/translation.ts';

void test('cache keys change with language, provider, model, and prompt version', () => {
  const base = { sourceHash: 'abc', targetLanguage: '简体中文', provider: 'p', model: 'm' };
  assert.equal(translationCacheKey(base), 'abc:简体中文:p:m:v3');
  assert.notEqual(
    translationCacheKey(base),
    translationCacheKey({ ...base, targetLanguage: '日本語' }),
  );
  assert.notEqual(translationCacheKey(base), translationCacheKey({ ...base, model: 'm2' }));
  assert.notEqual(
    translationCacheKey(base),
    translationCacheKey({ ...base, promptVersion: 4 }),
  );
});

void test('http errors map to user-facing categories', () => {
  assert.equal(classifyHttpError(401), 'auth');
  assert.equal(classifyHttpError(402), 'quota');
  assert.equal(classifyHttpError(429), 'rate_limit');
  assert.equal(classifyHttpError(413), 'invalid_input');
  assert.equal(classifyHttpError(503), 'server');
  assert.equal(classifyHttpError(400), 'unknown');
});

void test('only transient errors retry, and at most twice', () => {
  assert.equal(shouldAutoRetry('network', 0), true);
  assert.equal(shouldAutoRetry('rate_limit', 1), true);
  assert.equal(shouldAutoRetry('server', 0), true);
  assert.equal(shouldAutoRetry('auth', 0), false);
  assert.equal(shouldAutoRetry('quota', 0), false);
  assert.equal(shouldAutoRetry('network', 2), false);
});

void test('translateWithRetry retries transient failures and then succeeds', async () => {
  let calls = 0;
  const provider = {
    id: 'test',
    model: 'test',
    async translate() {
      calls += 1;
      if (calls < 3) throw new TranslationError('server', 'boom');
      return { paragraphs: ['ok'], provider: 'test', model: 'test' };
    },
  };
  const result = await translateWithRetry(provider, { text: 't', sourceLanguage: 'auto', targetLanguage: '简体中文', pageNumber: 1 });
  assert.deepEqual(result.paragraphs, ['ok']);
  assert.equal(calls, 3);
});

void test('translateWithRetry does not retry deterministic failures', async () => {
  let calls = 0;
  const provider = {
    id: 'test',
    model: 'test',
    async translate() {
      calls += 1;
      throw new TranslationError('auth', 'bad key');
    },
  };
  await assert.rejects(
    translateWithRetry(provider, { text: 't', sourceLanguage: 'auto', targetLanguage: '简体中文', pageNumber: 1 }),
    /bad key/,
  );
  assert.equal(calls, 1);
});

/** Builds a fetch stub that answers with an SSE chat-completions stream. */
function stubStreamFetch(content: string, chunksSize = 8) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const chunks = content.match(new RegExp(`[\\s\\S]{1,${chunksSize}}`, 'g')) ?? [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          const data = JSON.stringify({ choices: [{ delta: { content: chunk } }] });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function stubStatusFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

void test('openai-compatible provider streams paragraphs progressively', async () => {
  const { fetchImpl, calls } = stubStreamFetch('第一段。\n\n第二段。\n\n第三段。');
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-test',
    model: 'test-model',
    fetchImpl,
  });

  const snapshots: string[][] = [];
  const result = await provider.translate(
    { text: 'Hello.', sourceLanguage: 'auto', targetLanguage: '简体中文', pageNumber: 3 },
    { onPartial: (paragraphs) => snapshots.push([...paragraphs]) },
  );

  assert.deepEqual(result.paragraphs, ['第一段。', '第二段。', '第三段。']);
  assert.ok(snapshots.length >= 2, 'onPartial should fire while streaming');
  assert.deepEqual(snapshots.at(-1), result.paragraphs);
  for (let index = 1; index < snapshots.length; index += 1) {
    const growth = snapshots[index].join('|').startsWith(snapshots[index - 1].join('|'));
    assert.equal(growth, true, 'partial paragraphs must only grow');
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 1024);
});

void test('translation output limit scales with page length and stays bounded', () => {
  assert.equal(recommendedMaxOutputTokens('short page'), 1024);
  assert.equal(recommendedMaxOutputTokens('x'.repeat(2000)), 2400);
  assert.equal(recommendedMaxOutputTokens('x'.repeat(20000)), 8192);
});

void test('disableThinking adds the thinking-off flag to the request body', async () => {
  const { fetchImpl, calls } = stubStreamFetch('x');
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'glm-4-flash',
    disableThinking: true,
    fetchImpl,
  });
  await provider.translate({ text: 'Hi.', sourceLanguage: 'auto', targetLanguage: '简体中文', pageNumber: 1 });
  const body = JSON.parse(calls[0].init.body as string);
  assert.deepEqual(body.thinking, { type: 'disabled' });

  const without = createOpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    fetchImpl,
  });
  await without.translate({ text: 'Hi.', sourceLanguage: 'auto', targetLanguage: '简体中文', pageNumber: 1 });
  const body2 = JSON.parse(calls[1].init.body as string);
  assert.equal(body2.thinking, undefined);
});

void test('openai-compatible provider surfaces auth errors without retrying', async () => {
  const { fetchImpl } = stubStatusFetch(401, { error: { message: '令牌已过期或验证不正确' } });
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-bad',
    model: 'test-model',
    fetchImpl,
  });
  await assert.rejects(
    provider.translate({ text: 'Hello.', sourceLanguage: 'auto', targetLanguage: '简体中文', pageNumber: 1 }),
    (error: unknown) =>
      error instanceof TranslationError &&
      error.code === 'auth' &&
      /令牌已过期或验证不正确/.test(error.message),
  );
});

void test('openai-compatible provider reports network failures', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    fetchImpl,
  });
  await assert.rejects(
    provider.translate({ text: 'Hello.', sourceLanguage: 'auto', targetLanguage: '简体中文', pageNumber: 1 }),
    (error: unknown) => error instanceof TranslationError && error.code === 'network',
  );
});

void test('mock provider mirrors the source paragraph count offline', async () => {
  const provider = createMockTranslationProvider();
  const result = await provider.translate({
    text: 'Paragraph one.\n\nParagraph two.',
    sourceLanguage: 'auto',
    targetLanguage: '简体中文',
    pageNumber: 5,
  });
  assert.equal(result.paragraphs.length, 2);
  assert.match(result.paragraphs[0], /第 5 页/);
});

void test('paragraph parsing handles blank-line text, JSON fallback, and lines', () => {
  assert.deepEqual(
    parseParagraphList('第一段。\n\n第二段。', 'src'),
    ['第一段。', '第二段。'],
  );
  assert.deepEqual(
    parseParagraphList('{"paragraphs": ["来自 JSON。"]}', 'src'),
    ['来自 JSON。'],
  );
  assert.deepEqual(parseParagraphList('第一行。\n第二行。', 'src'), ['第一行。\n第二行。']);
  assert.deepEqual(
    parseParagraphList('``` translation\n第一段。\n\n第二段。\n```', 'src'),
    ['第一段。', '第二段。'],
  );
});
