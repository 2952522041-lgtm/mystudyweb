import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requestChatCompletion,
  type ChatCompletionInput,
} from '../lib/openai-client.ts';

const config = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'test-key',
  model: 'glm-4.6v',
};

async function runRequest(input: ChatCompletionInput) {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImpl = (async (
    _url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (typeof init?.body !== 'string') {
      throw new Error('expected a JSON request body');
    }
    requestBody = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"第一段"}}]}\n',
        'data: {"choices":[{"delta":{"content":"第二段"},"finish_reason":"stop"}]}\n',
        'data: [DONE]\n',
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;

  const result = await requestChatCompletion({ ...config, fetchImpl }, input);
  if (!requestBody) throw new Error('mock fetch did not receive a request');
  return { requestBody, result };
}

void test('default requests omit thinking and preserve request fields and SSE parsing', async () => {
  const messages = [{ role: 'user' as const, content: '请总结这段内容。' }];
  const snapshots: string[] = [];
  const { requestBody, result } = await runRequest({
    messages,
    maxTokens: 123,
    onPartial: (content) => snapshots.push(content),
  });

  assert.equal(Object.hasOwn(requestBody, 'thinking'), false);
  assert.deepEqual(requestBody.messages, messages);
  assert.equal(requestBody.max_tokens, 123);
  assert.equal(result.content, '第一段第二段');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(snapshots, ['第一段', '第一段第二段']);
});

void test('explicitly disabling thinking sends the provider option', async () => {
  const { requestBody, result } = await runRequest({
    messages: [{ role: 'user', content: '只返回结论。' }],
    thinking: 'disabled',
  });

  assert.deepEqual(requestBody.thinking, { type: 'disabled' });
  assert.equal(result.content, '第一段第二段');
  assert.equal(result.finishReason, 'stop');
});
