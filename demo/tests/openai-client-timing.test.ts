import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatError } from '../lib/ai-errors.ts';
import {
  requestChatCompletion,
  type ChatCompletionTiming,
} from '../lib/openai-client.ts';

const config = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

const encoder = new TextEncoder();

void test('already cancelled requests do not call the provider', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const timings: ChatCompletionTiming[] = [];
  await assert.rejects(requestChatCompletion({ ...config, fetchImpl: async () => {
    calls++;
    throw new Error('must not run');
  } }, { messages: [], signal: controller.signal, connectionTimeoutMs: 10,
    onTiming: value => timings.push(value),
  }), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal(timings[0].status, 'cancelled');
});

for (const status of [200, 503]) {
  void test(`stall timeout bounds an empty response body (HTTP ${status})`, async () => {
    const timings: ChatCompletionTiming[] = [];
    await assert.rejects(requestChatCompletion({ ...config,
      fetchImpl: async () => new Response(new ReadableStream({
        pull: () => new Promise<void>(() => {}),
      }), { status }),
    }, { messages: [], streamStallTimeoutMs: 15,
      onTiming: value => timings.push(value),
    }), (error: unknown) => error instanceof ChatError && error.code === 'network');
    assert.equal(timings.length, 1);
    assert.equal(timings[0].status, 'failure');
    assert.equal(timings[0].firstContentMs, null);
  });
}

function sse(data: string): Uint8Array {
  return encoder.encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: data } }] })}\n`,
  );
}

function finish(): Uint8Array {
  return encoder.encode(
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n',
  );
}

void test('onTiming reports only request metrics and cleans configured timers on success', async () => {
  const timings: ChatCompletionTiming[] = [];
  let fetchSignal: AbortSignal | undefined;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let secondTimer: ReturnType<typeof setTimeout> | undefined;
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    fetchSignal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        firstTimer = setTimeout(() => controller.enqueue(sse('你')), 5);
        secondTimer = setTimeout(() => {
          controller.enqueue(sse('好'));
          controller.enqueue(finish());
          controller.close();
        }, 10);
      },
      cancel() {
        if (firstTimer) clearTimeout(firstTimer);
        if (secondTimer) clearTimeout(secondTimer);
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  const result = await requestChatCompletion(
    { ...config, fetchImpl, connectionTimeoutMs: 40, streamStallTimeoutMs: 40 },
    {
      messages: [{ role: 'user', content: 'private prompt' }],
      onTiming: (timing) => timings.push(timing),
    },
  );

  assert.equal(result.content, '你好');
  assert.equal(timings.length, 1);
  const timing = timings[0];
  assert.equal(timing.status, 'success');
  assert.equal(timing.outputChars, 2);
  assert.notEqual(timing.headersMs, null);
  assert.notEqual(timing.firstContentMs, null);
  assert.ok(timing.firstContentMs! >= timing.headersMs!);
  assert.ok(timing.totalMs >= timing.firstContentMs!);
  assert.equal(Object.hasOwn(timing, 'content'), false);
  assert.equal(JSON.stringify(timing).includes('private prompt'), false);

  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.equal(
    fetchSignal?.aborted,
    false,
    'success must clear connection and stream timers',
  );
});

void test('connection timeout aborts a fetch that never produces response headers', async () => {
  let fetchSignal: AbortSignal | undefined;
  const timings: ChatCompletionTiming[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    fetchSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }) as typeof fetch;

  await assert.rejects(
    requestChatCompletion(
      { ...config, fetchImpl },
      {
        messages: [{ role: 'user', content: 'private prompt' }],
        connectionTimeoutMs: 12,
        onTiming: (timing) => timings.push(timing),
      },
    ),
    (error: unknown) => error instanceof ChatError && error.code === 'network',
  );

  assert.equal(fetchSignal?.aborted, true);
  assert.equal(timings.length, 1);
  assert.equal(timings[0].status, 'failure');
  assert.equal(timings[0].headersMs, null);
  assert.equal(timings[0].outputChars, 0);
});

void test('stream stall timeout covers the first and subsequent reads and cancels the reader', async () => {
  let streamCancelled = false;
  let fetchSignal: AbortSignal | undefined;
  const timings: ChatCompletionTiming[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    fetchSignal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sse('first'));
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        streamCancelled = true;
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  await assert.rejects(
    requestChatCompletion(
      { ...config, fetchImpl },
      {
        messages: [{ role: 'user', content: 'private prompt' }],
        streamStallTimeoutMs: 15,
        onTiming: (timing) => timings.push(timing),
      },
    ),
    (error: unknown) => error instanceof ChatError && error.code === 'network',
  );

  assert.equal(fetchSignal?.aborted, true);
  assert.equal(streamCancelled, true);
  assert.equal(timings.length, 1);
  assert.equal(timings[0].status, 'failure');
  assert.equal(timings[0].outputChars, 5);
  assert.notEqual(timings[0].firstContentMs, null);
});

void test('external abort is propagated and reported as cancellation', async () => {
  const controller = new AbortController();
  let streamCancelled = false;
  let fetchSignal: AbortSignal | undefined;
  const timings: ChatCompletionTiming[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    fetchSignal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        streamCancelled = true;
      },
    });
    setTimeout(() => controller.abort(), 10);
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  await assert.rejects(
    requestChatCompletion(
      { ...config, fetchImpl },
      {
        messages: [{ role: 'user', content: 'private prompt' }],
        signal: controller.signal,
        onTiming: (timing) => timings.push(timing),
      },
    ),
    (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError',
  );

  assert.equal(
    fetchSignal,
    controller.signal,
    'without internal timeouts, pass through the external signal',
  );
  assert.equal(streamCancelled, true);
  assert.equal(timings.length, 1);
  assert.equal(timings[0].status, 'cancelled');
  assert.equal(timings[0].outputChars, 0);
});
