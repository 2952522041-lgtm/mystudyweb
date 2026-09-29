import assert from 'node:assert/strict';
import test from 'node:test';

import { requestDshCompletion, type DshBridge } from '../lib/dsh-client.ts';
import type {
  DshCompletionRequest,
  DshCompletionResult,
  DshProgress,
} from '../lib/dsh-types.ts';
import type {
  ChatCompletionConfig,
  ChatCompletionInput,
  ChatCompletionTiming,
} from '../lib/openai-client.ts';

const config: ChatCompletionConfig = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'private-api-key',
  model: 'private-model',
};

const privatePrompt = 'private prompt';
const messages: ChatCompletionInput['messages'] = [
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: privatePrompt },
];

class FakeDshBridge implements DshBridge {
  readonly requests: DshCompletionRequest[] = [];
  readonly cancellations: string[] = [];
  readonly listeners = new Set<(progress: DshProgress) => void>();
  cleanupCount = 0;
  runImpl: (request: DshCompletionRequest) => Promise<DshCompletionResult> =
    async () => ({ content: 'answer', finishReason: 'stop' });

  runDsh(request: DshCompletionRequest): Promise<DshCompletionResult> {
    this.requests.push(request);
    return this.runImpl(request);
  }

  cancelDsh(requestId: string): Promise<void> {
    this.cancellations.push(requestId);
    return Promise.resolve();
  }

  onDshProgress(listener: (progress: DshProgress) => void): () => void {
    this.listeners.add(listener);
    return () => {
      if (this.listeners.delete(listener)) this.cleanupCount++;
    };
  }

  emit(progress: DshProgress): void {
    for (const listener of this.listeners) listener(progress);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('timed out waiting for test condition'));
        return;
      }
      setTimeout(poll, 1);
    };
    poll();
  });
}

void test('routes progress by request ID and registers before runDsh', async () => {
  const bridge = new FakeDshBridge();
  const partials: string[] = [];
  let registeredBeforeRun = false;
  bridge.runImpl = async (request) => {
    registeredBeforeRun = bridge.listeners.size > 0;
    bridge.emit({ requestId: 'other-request', content: 'must be ignored' });
    bridge.emit({ requestId: request.requestId, content: '正文' });
    return { content: '正文完成', finishReason: 'stop' };
  };

  const result = await requestDshCompletion(
    config,
    { messages, onPartial: (content) => partials.push(content) },
    bridge,
  );

  assert.equal(registeredBeforeRun, true);
  assert.deepEqual(partials, ['正文']);
  assert.deepEqual(result, { content: '正文完成', finishReason: 'stop' });
  assert.equal(bridge.requests[0].maxTokens, 4096);
  assert.equal(bridge.requests[0].thinking, 'default');
  assert.deepEqual(bridge.requests[0].messages, messages);
  assert.equal(bridge.cleanupCount, 1);
});

void test('isolates concurrent request progress listeners', async () => {
  const bridge = new FakeDshBridge();
  const first = deferred<DshCompletionResult>();
  const second = deferred<DshCompletionResult>();
  bridge.runImpl = (_request) =>
    bridge.requests.length === 1 ? first.promise : second.promise;
  const firstPartials: string[] = [];
  const secondPartials: string[] = [];

  const firstRequest = requestDshCompletion(
    config,
    { messages, onPartial: (content) => firstPartials.push(content) },
    bridge,
  );
  await waitFor(() => bridge.requests.length === 1);
  const secondRequest = requestDshCompletion(
    config,
    { messages, onPartial: (content) => secondPartials.push(content) },
    bridge,
  );
  await waitFor(() => bridge.requests.length === 2);

  bridge.emit({ requestId: bridge.requests[1].requestId, content: 'second' });
  bridge.emit({ requestId: bridge.requests[0].requestId, content: 'first' });
  second.resolve({ content: 'second', finishReason: 'stop' });
  first.resolve({ content: 'first', finishReason: 'stop' });

  await Promise.all([firstRequest, secondRequest]);
  assert.deepEqual(firstPartials, ['first']);
  assert.deepEqual(secondPartials, ['second']);
  assert.equal(bridge.listeners.size, 0);
});

void test('does not call desktop bridge when already aborted', async () => {
  const bridge = new FakeDshBridge();
  const controller = new AbortController();
  controller.abort();
  const timings: ChatCompletionTiming[] = [];

  await assert.rejects(
    requestDshCompletion(
      config,
      {
        messages,
        signal: controller.signal,
        onTiming: (value) => timings.push(value),
      },
      bridge,
    ),
    (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(bridge.requests.length, 0);
  assert.equal(bridge.cancellations.length, 0);
  assert.equal(bridge.listeners.size, 0);
  assert.equal(timings[0].status, 'cancelled');
  assert.equal(timings[0].outputChars, 0);
});

void test('cancels an in-flight request and does not wait for late completion', async () => {
  const bridge = new FakeDshBridge();
  const running = deferred<DshCompletionResult>();
  bridge.runImpl = () => running.promise;
  const controller = new AbortController();
  const timings: ChatCompletionTiming[] = [];
  const partials: string[] = [];
  const requestPromise = requestDshCompletion(
    config,
    {
      messages,
      signal: controller.signal,
      onPartial: (content) => partials.push(content),
      onTiming: (value) => timings.push(value),
    },
    bridge,
  );

  await waitFor(() => bridge.requests.length === 1);
  const requestId = bridge.requests[0].requestId;
  bridge.emit({ requestId, content: 'before cancel' });
  controller.abort();

  await assert.rejects(
    Promise.race([
      requestPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('cancellation was not bounded')),
          500,
        ),
      ),
    ]),
    (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError',
  );
  assert.deepEqual(bridge.cancellations, [requestId]);
  assert.equal(bridge.listeners.size, 0);
  assert.equal(timings.length, 1);
  assert.equal(timings[0].status, 'cancelled');
  assert.equal(timings[0].outputChars, 'before cancel'.length);

  running.resolve({ content: 'late secret', finishReason: 'stop' });
  bridge.emit({ requestId, content: 'late secret' });
  await Promise.resolve();
  assert.deepEqual(partials, ['before cancel']);
  assert.equal(timings[0].status, 'cancelled');
});

void test('rejects invalid image bytes without silently converting or invoking DSH', async () => {
  const bridge = new FakeDshBridge();
  const imageMessage: ChatCompletionInput['messages'][number] = {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,secret' } },
    ],
  };

  await assert.rejects(
    requestDshCompletion(config, { messages: [imageMessage] }, bridge),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('PNG/JPEG') &&
      error.message.includes('图片'),
  );
  assert.equal(bridge.requests.length, 0);
});

void test('reports a clear Chinese error and never falls back without a desktop bridge', async () => {
  const timings: ChatCompletionTiming[] = [];

  await assert.rejects(
    requestDshCompletion(
      config,
      { messages, onTiming: (value) => timings.push(value) },
      null,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('桌面') &&
      error.message.includes('DSH'),
  );
  assert.equal(timings.length, 1);
  assert.equal(timings[0].status, 'failure');
});

void test('keeps timing safe and reports final content as first content when no progress arrives', async () => {
  const bridge = new FakeDshBridge();
  const timings: ChatCompletionTiming[] = [];
  const result = await requestDshCompletion(
    config,
    {
      messages,
      onTiming: (value) => {
        timings.push(value);
        throw new Error('diagnostic listener failure');
      },
    },
    bridge,
  );

  assert.equal(result.content, 'answer');
  assert.equal(timings.length, 1);
  assert.equal(timings[0].status, 'success');
  assert.equal(timings[0].headersMs, null);
  assert.notEqual(timings[0].firstContentMs, null);
  assert.equal(timings[0].outputChars, 'answer'.length);
  assert.ok(timings[0].totalMs >= timings[0].firstContentMs!);
  assert.equal(Object.hasOwn(timings[0], 'content'), false);
  assert.equal(JSON.stringify(timings[0]).includes(config.apiKey), false);
  assert.equal(JSON.stringify(timings[0]).includes('private prompt'), false);
});

void test('sanitizes runDsh errors without leaking key or prompt', async () => {
  const bridge = new FakeDshBridge();
  bridge.runImpl = async () => {
    throw new Error(`provider rejected ${config.apiKey} ${privatePrompt}`);
  };
  const timings: ChatCompletionTiming[] = [];

  await assert.rejects(
    requestDshCompletion(
      config,
      { messages, onTiming: (value) => timings.push(value) },
      bridge,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('DSH') &&
      !error.message.includes(config.apiKey) &&
      !error.message.includes(privatePrompt),
  );
  assert.equal(timings[0].status, 'failure');
  assert.equal(timings[0].outputChars, 0);
});
