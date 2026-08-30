import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatError,
  classifyChatHttpError,
  createOpenAICompatibleChatProvider,
  trimChatHistory,
  type ChatMessage,
  type PageChatRequest,
} from '../lib/chat.ts';
import {
  chatSettingsConfigured,
  createConversationStore,
  DEFAULT_CHAT_SETTINGS,
  loadChatSettings,
  pageConversationKey,
  saveChatSettings,
  validateChatSettings,
  type PageConversation,
} from '../lib/chat-cache.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';

const request: PageChatRequest = {
  fingerprint: 'document-fingerprint',
  pageNumber: 7,
  pageText: 'Figure 2 shows that y = x².',
  pageImage: {
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,cGFnZQ==',
    width: 1200,
    height: 1600,
  },
  messages: [],
  question: '这个公式表达了什么？',
};

void test('multimodal chat sends page text and image and streams the answer', async () => {
  let body: Record<string, unknown> | undefined;
  const snapshots: string[] = [];
  const provider = createOpenAICompatibleChatProvider({
    baseUrl: 'https://example.com/v1/',
    apiKey: 'secret',
    model: 'vision-model',
    fetchImpl: (async (_url, init) => {
      if (typeof init?.body !== 'string')
        throw new Error('expected a JSON request body');
      body = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"公式"}}]}\n',
          'data: {"choices":[{"delta":{"content":"表示平方关系。"}}]}\n',
          'data: [DONE]\n',
        ].join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch,
  });

  const result = await provider.answer(request, {
    onPartial: (content) => snapshots.push(content),
  });

  assert.equal(result.content, '公式表示平方关系。');
  assert.equal(snapshots.at(-1), result.content);
  assert.equal(provider.supportsVision, true);
  assert.equal(body?.model, 'vision-model');
  const messages = body?.messages as Array<{ role: string; content: unknown }>;
  const context = messages[1].content as Array<Record<string, unknown>>;
  assert.match(String(context[0].text), /Figure 2/);
  assert.deepEqual(context[1], {
    type: 'image_url',
    image_url: { url: request.pageImage.dataUrl, detail: 'high' },
  });
  assert.equal(messages.at(-1)?.content, request.question);
  assert.doesNotMatch(JSON.stringify(body), /secret/);
});

void test('chat history keeps only the latest non-empty messages', () => {
  const messages: ChatMessage[] = Array.from({ length: 15 }, (_, index) => ({
    id: String(index),
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 2 ? ' ' : `message-${index}`,
    createdAt: '2026-08-30T00:00:00.000Z',
  }));
  const trimmed = trimChatHistory(messages, 4);
  assert.deepEqual(
    trimmed.map((message) => message.content),
    ['message-11', 'message-12', 'message-13', 'message-14'],
  );
});

void test('chat provider preserves service error details without exposing credentials', async () => {
  const provider = createOpenAICompatibleChatProvider({
    baseUrl: 'https://example.com/v1',
    apiKey: 'secret-key',
    model: 'vision-model',
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ error: { message: 'vision model unavailable' } }),
        {
          status: 503,
          headers: { 'content-type': 'application/json' },
        },
      )) as typeof fetch,
  });

  await assert.rejects(
    provider.answer(request),
    (error: unknown) =>
      error instanceof ChatError &&
      error.code === 'server' &&
      /vision model unavailable/.test(error.message) &&
      !/secret-key/.test(error.message),
  );
  assert.equal(classifyChatHttpError(401), 'auth');
  assert.equal(classifyChatHttpError(413), 'invalid_input');
  assert.equal(classifyChatHttpError(429), 'rate_limit');
});

void test('AI settings remain independent and validate a complete visual model configuration', () => {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
  } satisfies Pick<Storage, 'getItem' | 'setItem'>;

  assert.deepEqual(loadChatSettings(storage), DEFAULT_CHAT_SETTINGS);
  assert.equal(chatSettingsConfigured(DEFAULT_CHAT_SETTINGS), false);
  assert.match(validateChatSettings(DEFAULT_CHAT_SETTINGS) ?? '', /API Key/);

  const configured = {
    ...DEFAULT_CHAT_SETTINGS,
    apiKey: 'chat-only-key',
    model: 'vision-model',
  };
  saveChatSettings(configured, storage);
  assert.deepEqual(loadChatSettings(storage), configured);
  assert.equal(chatSettingsConfigured(configured), true);
  assert.equal(backing.has('pdf-reader-settings'), false);
});

void test('page conversations are isolated and can be cleared without touching other keys', async () => {
  const store = createMemoryStore<PageConversation>();
  const conversations = createConversationStore(store);
  const timestamp = '2026-08-30T00:00:00.000Z';
  const conversation = (pageNumber: number): PageConversation => ({
    fingerprint: 'fp',
    pageNumber,
    messages: [
      {
        id: `q-${pageNumber}`,
        role: 'user',
        content: `page ${pageNumber}`,
        createdAt: timestamp,
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await conversations.save(conversation(1));
  await conversations.save(conversation(2));
  assert.equal(
    (await conversations.load('fp', 1))?.messages[0].content,
    'page 1',
  );
  assert.equal(
    (await conversations.load('fp', 2))?.messages[0].content,
    'page 2',
  );
  assert.equal(pageConversationKey('fp', 2), 'chat:fp:2');

  await conversations.delete('fp', 1);
  assert.equal(await conversations.load('fp', 1), undefined);
  assert.ok(await conversations.load('fp', 2));

  await store.set('unrelated', conversation(9));
  await conversations.clearAll();
  assert.equal(await conversations.load('fp', 2), undefined);
  assert.ok(await store.get('unrelated'));
});
