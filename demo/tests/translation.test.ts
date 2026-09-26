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
  splitTranslationChunks,
  translateWithRetry,
  translationCacheKey,
} from '../lib/translation.ts';

void test('cache keys change with language, provider, model, and prompt version', () => {
  const base = {
    sourceHash: 'abc',
    targetLanguage: '简体中文',
    provider: 'p',
    model: 'm',
  };
  assert.equal(translationCacheKey(base), 'abc:简体中文:p:m:v6');
  assert.notEqual(
    translationCacheKey(base),
    translationCacheKey({ ...base, targetLanguage: '日本語' }),
  );
  assert.notEqual(
    translationCacheKey(base),
    translationCacheKey({ ...base, model: 'm2' }),
  );
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
  const result = await translateWithRetry(provider, {
    text: 't',
    sourceLanguage: 'auto',
    targetLanguage: '简体中文',
    pageNumber: 1,
  });
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
    translateWithRetry(provider, {
      text: 't',
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      pageNumber: 1,
    }),
    /bad key/,
  );
  assert.equal(calls, 1);
});

/** Builds a fetch stub that answers with an SSE chat-completions stream. */
function streamResponse(
  content: string,
  chunksSize = 8,
  finishReason = 'stop',
): Response {
  const chunks =
    content.match(new RegExp(`[\\s\\S]{1,${chunksSize}}`, 'g')) ?? [];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        const data = JSON.stringify({
          choices: [{ delta: { content: chunk } }],
        });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      const final = JSON.stringify({
        choices: [{ delta: {}, finish_reason: finishReason }],
      });
      controller.enqueue(encoder.encode(`data: ${final}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function stubStreamFetch(
  content: string,
  chunksSize = 8,
  finishReason = 'stop',
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return streamResponse(content, chunksSize, finishReason);
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
  const { fetchImpl, calls } = stubStreamFetch(
    '第一段。\n\n第二段。\n\n第三段。',
  );
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-test',
    model: 'test-model',
    fetchImpl,
  });

  const snapshots: string[][] = [];
  const result = await provider.translate(
    {
      text: 'Hello.',
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      pageNumber: 3,
    },
    { onPartial: (paragraphs) => snapshots.push([...paragraphs]) },
  );

  assert.deepEqual(result.paragraphs, ['第一段。\n\n第二段。\n\n第三段。']);
  assert.ok(snapshots.length >= 2, 'onPartial should fire while streaming');
  assert.deepEqual(snapshots.at(-1), result.paragraphs);
  for (let index = 1; index < snapshots.length; index += 1) {
    const growth = snapshots[index]
      .join('|')
      .startsWith(snapshots[index - 1].join('|'));
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

void test('dense pages are split into bounded translation chunks without losing text', () => {
  const paragraphs = Array.from({ length: 8 }, (_, index) =>
    `Paragraph ${index + 1}. ${'source text '.repeat(70)}`.trim(),
  );
  const source = paragraphs.join('\n\n');
  const chunks = splitTranslationChunks(source, 1800);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1800));
  assert.equal(chunks.join('\n\n'), source);

  const oversized = Array.from(
    { length: 40 },
    (_, index) => `Sentence ${index + 1} keeps its source words intact.`,
  ).join(' ');
  const sentenceChunks = splitTranslationChunks(oversized, 240);
  assert.ok(sentenceChunks.length > 1);
  assert.ok(sentenceChunks.every((chunk) => chunk.length <= 240));
  assert.equal(sentenceChunks.join(' '), oversized);
});

void test('provider translates a dense page in multiple sequential requests', async () => {
  const calls: Array<{ init: RequestInit }> = [];
  const fetchImpl = (async (_url: string | URL, init: RequestInit = {}) => {
    calls.push({ init });
    return streamResponse(`译文分块 ${calls.length}。`);
  }) as typeof fetch;
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'glm-test',
    fetchImpl,
  });
  const source = Array.from({ length: 10 }, (_, index) =>
    `Source paragraph ${index + 1}. ${'dense journal content '.repeat(35)}`.trim(),
  ).join('\n\n');
  const result = await provider.translate({
    text: source,
    sourceLanguage: 'auto',
    targetLanguage: '简体中文',
    pageNumber: 4,
  });

  assert.ok(calls.length >= 2);
  assert.equal(result.paragraphs.length, calls.length);
  for (const call of calls) {
    const body = JSON.parse(call.init.body as string);
    const userText = body.messages[1].content.split('\n---\n')[1];
    assert.ok(userText.length <= 3000);
    assert.match(body.messages[0].content, /Translate every sentence/);
    assert.match(body.messages[0].content, /character for character/);
    assert.match(body.messages[0].content, /Greek letters/);
    assert.match(
      body.messages[0].content,
      /Never drop, transliterate, or replace them/,
    );
  }
});

void test('length-truncated output is discarded and retried as smaller chunks', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1
      ? streamResponse('这是一段残缺译文', 8, 'length')
      : streamResponse(`完整译文 ${calls - 1}。`);
  }) as typeof fetch;
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'glm-test',
    fetchImpl,
  });
  const source = Array.from(
    { length: 18 },
    (_, index) =>
      `Sentence ${index + 1} contains enough words to exercise retry splitting.`,
  ).join(' ');
  const result = await provider.translate({
    text: source,
    sourceLanguage: 'auto',
    targetLanguage: '简体中文',
    pageNumber: 4,
  });

  assert.ok(calls >= 3);
  assert.equal(result.paragraphs.length, 1);
  assert.deepEqual(
    result.paragraphs,
    [Array.from({ length: calls - 1 }, (_, index) => `完整译文 ${index + 1}。`).join(' ')],
  );
  assert.doesNotMatch(result.paragraphs.join(''), /残缺/);
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
  await provider.translate({
    text: 'Hi.',
    sourceLanguage: 'auto',
    targetLanguage: '简体中文',
    pageNumber: 1,
  });
  const body = JSON.parse(calls[0].init.body as string);
  assert.deepEqual(body.thinking, { type: 'disabled' });

  const without = createOpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    fetchImpl,
  });
  await without.translate({
    text: 'Hi.',
    sourceLanguage: 'auto',
    targetLanguage: '简体中文',
    pageNumber: 1,
  });
  const body2 = JSON.parse(calls[1].init.body as string);
  assert.equal(body2.thinking, undefined);
});

void test('openai-compatible provider surfaces auth errors without retrying', async () => {
  const { fetchImpl } = stubStatusFetch(401, {
    error: { message: '令牌已过期或验证不正确' },
  });
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-bad',
    model: 'test-model',
    fetchImpl,
  });
  await assert.rejects(
    provider.translate({
      text: 'Hello.',
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      pageNumber: 1,
    }),
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
    provider.translate({
      text: 'Hello.',
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      pageNumber: 1,
    }),
    (error: unknown) =>
      error instanceof TranslationError && error.code === 'network',
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
  assert.deepEqual(parseParagraphList('第一段。\n\n第二段。', 'src'), [
    '第一段。',
    '第二段。',
  ]);
  assert.deepEqual(
    parseParagraphList('{"paragraphs": ["来自 JSON。"]}', 'src'),
    ['来自 JSON。'],
  );
  assert.deepEqual(parseParagraphList('第一行。\n第二行。', 'src'), [
    '第一行。\n第二行。',
  ]);
  assert.deepEqual(
    parseParagraphList('``` translation\n第一段。\n\n第二段。\n```', 'src'),
    ['第一段。', '第二段。'],
  );
});

void test('scientific formulas and characters survive model requests and partial output byte for byte', async () => {
  const source = String.raw`Use $x^2 + α$ and $$\begin{matrix}1 & 2\\

3 & 4\end{matrix}$$ with H_2O m/s² N·m ℃ α β γ θ μ Ω ≈ ≤ ≥ ± × ÷ → ∑ ∫ ∂ - – —.

Next \begin{align}a&=b\\

c&=d\end{align}.`;
  const snapshots: string[][] = [];
  const provider = createOpenAICompatibleProvider({baseUrl:'https://mock.test',apiKey:'test',model:'mock',
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      const text = body.messages[1].content.split('\n---\n')[1];
      assert.doesNotMatch(text, /\$|α|℃|H_2O/);
      return streamResponse(text.replace('Use', '使用').replace('Next', '下一段'), 1);
    }) as typeof fetch});
  const result = await provider.translate({text:source,sourceLanguage:'auto',targetLanguage:'zh',pageNumber:1},
    {onPartial: (parts) => snapshots.push(parts)});
  assert.equal(result.paragraphs.length, 2);
  assert.equal(result.paragraphs.join('\n\n'), source.replace('Use', '使用').replace('Next', '下一段'));
  assert.ok(snapshots.every((parts) => !parts.join('').includes('YYKEEP')));
});

void test('lost or reordered math markers get one corrective attempt and never become successful output', async () => {
  for (const mode of ['lost', 'duplicate', 'reorder']) {
    let calls = 0;
    const provider = createOpenAICompatibleProvider({baseUrl:'https://mock.test',apiKey:'test',model:'mock',
      fetchImpl: (async (_url, init) => {
        calls++;
        const body = JSON.parse(init?.body as string);
        const tokens = body.messages[1].content.match(/YYKEEP\d+ZZ/g);
        return streamResponse(mode === 'lost' ? '公式丢失' : mode === 'duplicate' ? tokens.join(' ') + tokens[0] : tokens.reverse().join(' '));
      }) as typeof fetch});
    await assert.rejects(provider.translate({text:'$x$ then $y$',sourceLanguage:'auto',targetLanguage:'zh',pageNumber:1}),
      (error: unknown) => error instanceof TranslationError && error.code === 'invalid_output');
    assert.equal(calls, 2);
  }
});

void test('a corrective response restores notation and numbered lists remain inside their source paragraph', async () => {
  let calls = 0;
  const provider = createOpenAICompatibleProvider({baseUrl:'https://mock.test',apiKey:'test',model:'mock',
    fetchImpl: (async (_url, init) => {
      calls++;
      const text = JSON.parse(init?.body as string).messages[1].content.split('\n---\n')[1];
      return streamResponse(calls === 1 ? 'bad output' : text);
    }) as typeof fetch});
  const text = '1. $x$\n2. H_2O\n\nSecond paragraph';
  const result = await provider.translate({text,sourceLanguage:'auto',targetLanguage:'zh',pageNumber:1});
  assert.deepEqual(result.paragraphs, ['1. $x$\n2. H_2O', 'Second paragraph']);
  assert.equal(calls, 3);
});

void test('an oversized source paragraph retains its ownership and an atomic matrix across chunks', async () => {
  const formula = '$$'+String.raw`\begin{matrix}`+'1 & 2 '.repeat(700)+String.raw`\end{matrix}`+'$$';
  const first = 'Long scientific paragraph. '.repeat(150)+formula+' End.';
  let calls = 0;
  const provider = createOpenAICompatibleProvider({baseUrl:'https://mock.test',apiKey:'test',model:'mock',
    fetchImpl:(async (_url, init) => {
      calls++;
      const text = JSON.parse(init?.body as string).messages[1].content.split('\n---\n')[1];
      assert.doesNotMatch(text, /\$|matrix/);
      return streamResponse(text);
    }) as typeof fetch});
  const result = await provider.translate({text:first+'\n\nSecond.',sourceLanguage:'auto',targetLanguage:'zh',pageNumber:1});
  assert.ok(calls >= 3);
  assert.deepEqual(result.paragraphs, [first, 'Second.']);
  const rawChunks = splitTranslationChunks('Before '+formula+' After', 100);
  assert.ok(rawChunks.some((chunk) => chunk.includes(formula)));
  assert.equal(rawChunks.join(' '), 'Before '+formula+' After');
});
