import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOpenAICompatibleChatProvider,
  type PageChatRequest,
} from '../lib/chat.ts';
import {
  requestChatCompletion,
  type ChatCompletionConfig,
  type ChatCompletionInput,
} from '../lib/openai-client.ts';
import type {
  DshCompletionRequest,
  DshCompletionResult,
  DshProgress,
} from '../lib/dsh-types.ts';
import { type DshBridge } from '../lib/dsh-client.ts';
import {
  KNOWLEDGE_PROVIDER_ID,
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
  knowledgeDigestCacheKey,
  knowledgeProviderIdentity,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';

class FakeDshBridge implements DshBridge {
  readonly requests: DshCompletionRequest[] = [];
  readonly replies: string[];
  finishReason: DshCompletionResult['finishReason'] = 'stop';

  constructor(replies: string[] = ['DSH answer']) {
    this.replies = replies;
  }

  runDsh(request: DshCompletionRequest): Promise<DshCompletionResult> {
    this.requests.push(request);
    return Promise.resolve({
      content: this.replies[this.requests.length - 1] ?? this.replies.at(-1) ?? '',
      finishReason: this.finishReason,
    });
  }

  cancelDsh(_requestId: string): Promise<void> {
    return Promise.resolve();
  }

  onDshProgress(_listener: (progress: DshProgress) => void): () => void {
    return () => {};
  }
}

function installBrowserGlobals(
  backend: 'api' | 'dsh',
  bridge?: DshBridge,
  dshDocumentChat = false,
  knowledgeSettings: {
    baseUrl: string;
    apiKey: string;
    model: string;
  } = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'deepseek-secret',
    model: 'deepseek-flash',
  },
): () => void {
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const agentStored = JSON.stringify({ backend, dshDocumentChat });
  const knowledgeStored = JSON.stringify(knowledgeSettings);
  const storage = {
    getItem(key: string): string | null {
      if (key === 'yeyu-agent-settings') return agentStored;
      if (key === 'pdf-reader-knowledge-settings') return knowledgeStored;
      return null;
    },
    setItem() {},
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: bridge ? { yeyuDesktop: bridge } : undefined,
  });
  return () => {
    if (localStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
    if (windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  };
}

const directMessages: ChatCompletionInput['messages'] = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'question' },
];

void test('executionBackend=dsh delegates to DSH and never falls back to fetch', async () => {
  const bridge = new FakeDshBridge(['from dsh']);
  const restore = installBrowserGlobals('dsh', bridge);
  let fetchCalls = 0;
  try {
    const result = await requestChatCompletion(
      {
        baseUrl: 'https://provider.example/v1',
        apiKey: 'secret',
        model: 'deepseek-flash',
        executionBackend: 'dsh',
        fetchImpl: (async () => {
          fetchCalls += 1;
          throw new Error('API fallback must not run');
        }) as typeof fetch,
      },
      { messages: directMessages },
    );
    assert.deepEqual(result, { content: 'from dsh', finishReason: 'stop' });
    assert.equal(fetchCalls, 0);
    assert.equal(bridge.requests.length, 1);
  } finally {
    restore();
  }
});

void test('whole-document chat reads the selected backend while page image chat stays on API', async () => {
  const bridge = new FakeDshBridge(['全文回答']);
  let fetchCalls = 0;
  const fetchBodies: Array<{ model?: string; messages?: unknown[] }> = [];
  const config: ChatCompletionConfig = {
    baseUrl: 'https://chat.example/v1',
    apiKey: 'glm-secret',
    model: 'glm-4.6v',
    executionBackend: 'dsh',
    fetchImpl: (async (_url, init) => {
      fetchCalls += 1;
      const body = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      ) as { model?: string; messages?: unknown[] };
      fetchBodies.push(body);
      assert.ok(body.messages && body.messages.length > 0);
      return new Response(
        'data: {"choices":[{"delta":{"content":"页面回答"}}]}\n' +
          'data: [DONE]\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch,
  };
  const provider = createOpenAICompatibleChatProvider(config);
  const baseRequest: PageChatRequest = {
    fingerprint: 'fingerprint',
    pageNumber: 1,
    pageText: '本页内容',
    messages: [],
    question: '请回答',
  };

  // DSH selected without the explicit scope opt-in must keep the existing
  // GLM chat configuration and API path.
  const restoreDisabled = installBrowserGlobals('dsh', bridge, false);
  try {
    const disabledDocument = await provider.answer({
      ...baseRequest,
      documentChunks: [{ pageNumber: 1, text: '全文摘录' }],
    });
    assert.equal(disabledDocument.content, '页面回答\n\n检索来源：[第 1 页](#page=1)');
    assert.equal(fetchCalls, 1);
    assert.equal(bridge.requests.length, 0);
    assert.equal(fetchBodies[0]?.model, 'glm-4.6v');
  } finally {
    restoreDisabled();
  }

  // Explicit opt-in uses the independent knowledge DeepSeek credentials only
  // for text-only whole-document chat.
  const restoreEnabled = installBrowserGlobals('dsh', bridge, true);
  try {
    const wholeDocument = await provider.answer({
      ...baseRequest,
      documentChunks: [{ pageNumber: 1, text: '全文摘录' }],
    });
    assert.equal(wholeDocument.content, '全文回答\n\n检索来源：[第 1 页](#page=1)');
    assert.equal(fetchCalls, 1);
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.requests[0].baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(bridge.requests[0].apiKey, 'deepseek-secret');
    assert.equal(bridge.requests[0].model, 'deepseek-flash');
    assert.equal(bridge.requests[0].thinking, 'disabled');
    assert.ok(
      bridge.requests[0].messages.every((message) => typeof message.content === 'string'),
    );

    const page = await provider.answer({
      ...baseRequest,
      pageImage: {
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,page',
        width: 100,
        height: 100,
      },
    });
    assert.equal(page.content, '页面回答');
    assert.equal(fetchCalls, 2);
    assert.equal(bridge.requests.length, 1);
    assert.equal(fetchBodies.at(-1)?.model, 'glm-4.6v');
  } finally {
    restoreEnabled();
  }
});

void test('DSH length finishes are rejected as incomplete document answers', async () => {
  const bridge = new FakeDshBridge(['残缺回答']);
  bridge.finishReason = 'length';
  const restore = installBrowserGlobals('dsh', bridge, true);
  const provider = createOpenAICompatibleChatProvider({
    baseUrl: 'https://chat.example/v1',
    apiKey: 'glm-secret',
    model: 'glm-4.6v',
    fetchImpl: (async () => {
      throw new Error('DSH length must not fall back to API');
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      provider.answer({
        fingerprint: 'fingerprint',
        pageNumber: 1,
        pageText: '页面',
        documentChunks: [{ pageNumber: 1, text: '全文' }],
        messages: [],
        question: '请回答',
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('DSH') &&
        error.message.includes('残缺'),
    );
  } finally {
    restore();
  }
});

void test('API knowledge identity remains compatible while DSH gets an isolated cache namespace', () => {
  assert.equal(knowledgeProviderIdentity('api'), KNOWLEDGE_PROVIDER_ID);
  const dshIdentity = knowledgeProviderIdentity('dsh');
  assert.notEqual(dshIdentity, KNOWLEDGE_PROVIDER_ID);
  assert.match(dshIdentity, /dsh/i);

  const parts = {
    fingerprint: 'fingerprint',
    model: 'deepseek-flash',
    promptVersion: 'prompt-v1',
    schemaVersion: 2,
    input: { prompt: 'same input' },
  };
  const apiKey = knowledgeDigestCacheKey({
    ...parts,
    provider: KNOWLEDGE_PROVIDER_ID,
  });
  const dshKey = knowledgeDigestCacheKey({
    ...parts,
    provider: dshIdentity,
  });
  assert.notEqual(apiKey, dshKey);
});

void test('knowledge provider factory reads DSH selection and routes synthesis without changing API credentials', async () => {
  const documentId = 'doc-dsh-routing';
  const bridge = new FakeDshBridge([
    JSON.stringify({
      sections: [{ title: '主题', summary: '分块说明。', pageStart: 1, pageEnd: 1 }],
      concepts: [{
        id: 'chunk-concept',
        parentId: null,
        label: '主题',
        description: '分块概念。',
        sources: [{ pageStart: 1, pageEnd: 1 }],
      }],
      unresolvedQuestions: [],
    }),
    JSON.stringify({
      hierarchy: { mode: 'flat', reason: '单页材料没有章节从属结构。' },
      title: 'DSH 文档',
      overview: 'DSH 生成的文档摘要。',
      sections: [{ title: '主题', summary: '全文说明。', pageStart: 1, pageEnd: 1 }],
      concepts: [{
        id: 'digest-concept',
        parentId: null,
        label: '主题',
        description: '全文概念。',
        sources: [{ pageStart: 1, pageEnd: 1 }],
      }],
      relations: [],
      unresolvedQuestions: [],
      sourcePages: [1],
    }),
  ]);
  const restore = installBrowserGlobals('dsh', bridge);
  try {
    const provider = createKnowledgeProviderForSettings(
      {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'deepseek-secret',
        model: 'deepseek-flash',
      },
      (async () => {
        throw new Error('knowledge DSH must not call API fetch');
      }) as typeof fetch,
      createKnowledgeDigestCache(createMemoryStore()),
      createMemoryStore<unknown>(),
    );
    const digest = await provider.analyzeDocument({
      fingerprint: 'f'.repeat(64),
      fileName: 'dsh.pdf',
      documentId,
      pages: ['1 主题\n内容'],
    });
    assert.equal(provider.id, knowledgeProviderIdentity('dsh'));
    assert.equal(digest.provider, knowledgeProviderIdentity('dsh'));
    assert.equal(bridge.requests.length, 2);
    assert.equal(bridge.requests[0].apiKey, 'deepseek-secret');
    assert.equal(bridge.requests[0].model, 'deepseek-flash');
  } finally {
    restore();
  }
});
