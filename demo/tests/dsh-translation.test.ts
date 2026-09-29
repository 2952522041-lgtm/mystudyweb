import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from '../lib/translation.ts';
import {
  createMemoryStore,
  createTranslationCache,
  resolvePageTranslation,
} from '../lib/reader-cache.ts';
import type {
  DshCompletionRequest,
  DshCompletionResult,
  DshProgress,
} from '../lib/dsh-types.ts';
import type { DshBridge } from '../lib/dsh-client.ts';

type BrowserGlobals = {
  localStorage?: unknown;
  window?: unknown;
};

class FakeDshBridge implements DshBridge {
  readonly requests: DshCompletionRequest[] = [];
  readonly listeners = new Set<(progress: DshProgress) => void>();
  readonly runImpl: (request: DshCompletionRequest) => Promise<DshCompletionResult>;

  constructor(
    runImpl: (request: DshCompletionRequest) => Promise<DshCompletionResult>,
  ) {
    this.runImpl = runImpl;
  }

  runDsh(request: DshCompletionRequest): Promise<DshCompletionResult> {
    this.requests.push(request);
    return this.runImpl(request);
  }

  cancelDsh(_requestId: string): Promise<void> {
    return Promise.resolve();
  }

  onDshProgress(listener: (progress: DshProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(progress: DshProgress): void {
    for (const listener of this.listeners) listener(progress);
  }
}

function installBrowserGlobals(
  settings: Record<string, unknown>,
  bridge: DshBridge,
): () => void {
  const globalObject = globalThis as typeof globalThis & BrowserGlobals;
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalObject,
    'localStorage',
  );
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalObject, 'window');
  const stored = JSON.stringify(settings);
  Object.defineProperty(globalObject, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return key === 'yeyu-agent-settings' ? stored : null;
      },
      setItem() {},
    },
  });
  Object.defineProperty(globalObject, 'window', {
    configurable: true,
    value: { yeyuDesktop: bridge },
  });
  return () => {
    if (localStorageDescriptor) {
      Object.defineProperty(globalObject, 'localStorage', localStorageDescriptor);
    } else {
      Reflect.deleteProperty(globalObject, 'localStorage');
    }
    if (windowDescriptor) {
      Object.defineProperty(globalObject, 'window', windowDescriptor);
    } else {
      Reflect.deleteProperty(globalObject, 'window');
    }
  };
}

function response(content: string, finishReason: DshCompletionResult['finishReason'] = 'stop'): DshCompletionResult {
  return { content, finishReason };
}

function sourceTextFrom(request: DshCompletionRequest): string {
  const user = request.messages.find((message) => message.role === 'user');
  assert.ok(user && typeof user.content === 'string');
  return user.content.split('\n---\n')[1] ?? '';
}

function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error('timed out waiting for DSH request'));
      } else {
        setTimeout(poll, 1);
      }
    };
    poll();
  });
}

const baseConfig: OpenAICompatibleConfig = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'provider-secret',
  model: 'glm-4.7-flashx',
  disableThinking: true,
};

const request = {
  text: 'Use $x^2$ and α in this paragraph.',
  sourceLanguage: 'auto',
  targetLanguage: 'zh',
  pageNumber: 7,
};

void test('allAi routes translation through DSH with the exact protected messages', async () => {
  const apiCalls: RequestInit[] = [];
  const apiProvider = createOpenAICompatibleProvider({
    ...baseConfig,
    fetchImpl: (async (_url, init: RequestInit = {}) => {
      apiCalls.push(init);
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
        messages: Array<{ content: string }>;
      };
      const content = body.messages[1].content.split('\n---\n')[1] ?? '';
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n` +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n' +
          'data: [DONE]\n',
        { status: 200 },
      );
    }) as typeof fetch,
  });
  const apiResult = await apiProvider.translate(request);
  assert.equal(apiResult.provider, 'openai-compatible');

  const bridge = new FakeDshBridge(async (dshRequest) => {
    const protectedText = sourceTextFrom(dshRequest);
    const markers = [...protectedText.matchAll(/YYKEEP\d+ZZ/g)].map((match) => match[0]);
    const content = `译文 ${markers.join(' ')}`;
    bridge.emit({ requestId: dshRequest.requestId, content });
    return response(content);
  });
  const restore = installBrowserGlobals(
    { backend: 'dsh', dshDocumentChat: false, allAi: true },
    bridge,
  );
  try {
    let fetchCalls = 0;
    const dshProvider = createOpenAICompatibleProvider({
      ...baseConfig,
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error('translation API fallback must not run');
      }) as typeof fetch,
    });
    const snapshots: string[][] = [];
    const result = await dshProvider.translate(request, {
      onPartial: (paragraphs) => snapshots.push(paragraphs),
    });

    assert.equal(dshProvider.id, 'openai-compatible:dsh');
    assert.equal(result.provider, 'openai-compatible:dsh');
    assert.equal(fetchCalls, 0);
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.requests[0].thinking, 'disabled');
    assert.equal(bridge.requests[0].maxTokens, 1024);
    assert.deepEqual(
      bridge.requests[0].messages,
      JSON.parse(apiCalls[0].body as string).messages,
    );
    assert.deepEqual(result.paragraphs, ['译文 $x^2$ α']);
    assert.deepEqual(snapshots.at(-1), result.paragraphs);
    assert.ok(snapshots.every((parts) => !parts.join('').includes('YYKEEP')));
  } finally {
    restore();
  }
});

void test('DSH length responses retain chunk splitting and never call fetch', async () => {
  let fetchCalls = 0;
  const bridge = new FakeDshBridge(async (dshRequest) => {
    const text = sourceTextFrom(dshRequest);
    if (bridge.requests.length === 1) return response('discarded partial', 'length');
    return response(text);
  });
  const restore = installBrowserGlobals(
    { backend: 'dsh', dshDocumentChat: false, allAi: true },
    bridge,
  );
  try {
    const provider = createOpenAICompatibleProvider({
      ...baseConfig,
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error('translation API fallback must not run');
      }) as typeof fetch,
    });
    const text = Array.from(
      { length: 300 },
      (_, index) => `Sentence ${index + 1} keeps its words intact.`,
    ).join(' ');
    const result = await provider.translate({ ...request, text });

    assert.ok(bridge.requests.length > 2);
    assert.equal(fetchCalls, 0);
    assert.equal(result.paragraphs.length, 1);
    assert.equal(result.paragraphs[0], text);
    assert.equal(result.paragraphs.some((paragraph) => paragraph.includes('discarded')), false);
  } finally {
    restore();
  }
});

void test('aborted DSH translation does not save a cache entry', async () => {
  let resolveRun!: (result: DshCompletionResult) => void;
  const bridge = new FakeDshBridge(
    () => new Promise<DshCompletionResult>((resolve) => {
      resolveRun = resolve;
    }),
  );
  const restore = installBrowserGlobals(
    { backend: 'dsh', dshDocumentChat: false, allAi: true },
    bridge,
  );
  try {
    const cache = createTranslationCache(createMemoryStore());
    const provider = createOpenAICompatibleProvider({
      ...baseConfig,
      fetchImpl: (async () => {
        throw new Error('translation API fallback must not run');
      }) as typeof fetch,
    });
    const controller = new AbortController();
    const translating = resolvePageTranslation({
      cache,
      fingerprint: 'document-fingerprint',
      provider,
      request: { ...request, text: 'A long paragraph with $x$.' },
      signal: controller.signal,
    });
    await waitFor(() => bridge.requests.length > 0);
    controller.abort();

    await assert.rejects(translating, { name: 'AbortError' });
    assert.deepEqual(await cache.list(), []);
    resolveRun({ content: 'late result', finishReason: 'stop' });
  } finally {
    restore();
  }
});
