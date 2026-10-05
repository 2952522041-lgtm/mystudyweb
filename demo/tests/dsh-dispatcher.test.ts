import assert from 'node:assert/strict';
import test from 'node:test';

import { DshDispatcher } from '../electron/dsh-dispatcher.ts';
import type {
  DshCompletionRequest,
  DshCompletionResult,
  DshProgress,
} from '../electron/dsh-types.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface RunCall {
  owner: number;
  request: DshCompletionRequest;
  progress: (value: DshProgress) => void;
  result: Deferred<DshCompletionResult>;
}

class FakeManager {
  readonly calls: RunCall[] = [];
  readonly cancelCalls: Array<{ owner: number; requestId: string }> = [];
  closeCalls = 0;
  rejectOnCancel = false;

  run(
    owner: number,
    value: unknown,
    progress: (value: DshProgress) => void,
  ): Promise<DshCompletionResult> {
    const result = deferred<DshCompletionResult>();
    const request = value as DshCompletionRequest;
    this.calls.push({ owner, request, progress, result });
    return result.promise;
  }

  cancel(owner: number, requestId: string): void {
    this.cancelCalls.push({ owner, requestId });
    if (this.rejectOnCancel) {
      this.find(requestId).result.reject(new Error('fake cancellation'));
    }
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }

  find(requestId: string): RunCall {
    const call = [...this.calls]
      .reverse()
      .find((entry) => entry.request.requestId === requestId);
    assert.ok(call, `missing fake run ${requestId}`);
    return call;
  }

  resolve(requestId: string, result: DshCompletionResult): void {
    this.find(requestId).result.resolve(result);
  }

  reject(requestId: string, error = new Error('fake backend failure')): void {
    this.find(requestId).result.reject(error);
  }
}

interface Fixture {
  dispatcher: DshDispatcher;
  manager: FakeManager;
  jobs: Promise<unknown>[];
  run(
    owner: number,
    request: DshCompletionRequest,
    progress?: (value: DshProgress) => void,
  ): Promise<DshCompletionResult>;
  close(): Promise<void>;
}

function createFixture(): Fixture {
  const manager = new FakeManager();
  const dispatcher = new DshDispatcher('', manager);
  const jobs: Promise<unknown>[] = [];
  return {
    dispatcher,
    manager,
    jobs,
    run(owner, request, progress = () => {}): Promise<DshCompletionResult> {
      const job = dispatcher.run(owner, request, progress);
      jobs.push(job);
      return job;
    },
    async close(): Promise<void> {
      // Any test that leaves a running fake job behind must still be able to
      // cleanly close the dispatcher without a real worker process.
      manager.rejectOnCancel = true;
      const closing = dispatcher.close();
      await Promise.allSettled(jobs);
      await closing;
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('dispatcher test timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function assertPending<T>(promise: Promise<T>): Promise<void> {
  const state = await Promise.race([
    promise.then(() => 'resolved' as const, () => 'rejected' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ]);
  assert.equal(state, 'pending');
}

function request(
  requestId: string,
  semantic = requestId,
  overrides: Partial<DshCompletionRequest> = {},
): DshCompletionRequest {
  return {
    requestId,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'account-a-secret',
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: semantic }],
    maxTokens: 128,
    thinking: 'default',
    ...overrides,
  };
}

function largePngDataUrl(): string {
  // One shared payload keeps the fixture's live memory small while the
  // dispatcher still accounts for the serialized input on every request.
  const bytes = Buffer.alloc(5_500_000);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const complete = (content: string, finishReason: DshCompletionResult['finishReason'] = 'stop') => ({
  content,
  finishReason,
});

void test('limits active work to four and queues a fifth request without rejecting it', async () => {
  const fixture = createFixture();
  try {
    const jobs = Array.from({ length: 5 }, (_, index) =>
      fixture.run(1, request(`active-${index + 1}`, `active-${index + 1}`)),
    );
    await waitFor(() => fixture.manager.calls.length === 4);
    assert.deepEqual(
      fixture.manager.calls.map((call) => call.request.requestId),
      ['active-1', 'active-2', 'active-3', 'active-4'],
    );
    await assertPending(jobs[4]);

    for (let index = 1; index <= 4; index += 1) {
      fixture.manager.resolve(`active-${index}`, complete(`answer-${index}`));
    }
    await waitFor(() => fixture.manager.calls.length === 5);
    assert.equal(fixture.manager.calls[4].request.requestId, 'active-5');
    fixture.manager.resolve('active-5', complete('answer-5'));
    assert.deepEqual(
      await Promise.all(jobs),
      [1, 2, 3, 4, 5].map((index) => complete(`answer-${index}`)),
    );
  } finally {
    await fixture.close();
  }
});

void test('deduplicates identical semantic requests while returning the result to both callers', async () => {
  const fixture = createFixture();
  try {
    const first = fixture.run(10, request('duplicate-1', 'same semantic request'));
    const second = fixture.run(20, request('duplicate-2', 'same semantic request'));
    await waitFor(() => fixture.manager.calls.length === 1);
    fixture.manager.resolve('duplicate-1', complete('shared answer'));

    assert.deepEqual(await first, complete('shared answer'));
    assert.deepEqual(await second, complete('shared answer'));
    assert.equal(fixture.manager.calls.length, 1);
  } finally {
    await fixture.close();
  }
});

void test('does not reuse results across account keys or models', async () => {
  const fixture = createFixture();
  try {
    const first = fixture.run(
      1,
      request('account-a', 'same semantic request', {
        apiKey: 'account-a-secret',
        model: 'deepseek-flash',
      }),
    );
    const second = fixture.run(
      1,
      request('account-b', 'same semantic request', {
        apiKey: 'account-b-secret',
        model: 'deepseek-flash',
      }),
    );
    const third = fixture.run(
      1,
      request('model-b', 'same semantic request', {
        apiKey: 'account-a-secret',
        model: 'deepseek-v4-pro',
      }),
    );
    await waitFor(() => fixture.manager.calls.length === 3);
    fixture.manager.resolve('account-a', complete('answer-a'));
    fixture.manager.resolve('account-b', complete('answer-b'));
    fixture.manager.resolve('model-b', complete('answer-model-b'));
    assert.deepEqual(await Promise.all([first, second, third]), [
      complete('answer-a'),
      complete('answer-b'),
      complete('answer-model-b'),
    ]);
    assert.equal(fixture.manager.calls.length, 3);
  } finally {
    await fixture.close();
  }
});

void test('queued cancellation is isolated by owner and leaves another queued request intact', async () => {
  const fixture = createFixture();
  try {
    const active = Array.from({ length: 4 }, (_, index) =>
      fixture.run(1, request(`owner-active-${index}`, `owner-active-${index}`)),
    );
    const cancelled = fixture.run(101, request('queued-cancelled', 'queued-cancelled'));
    const survivor = fixture.run(202, request('queued-survivor', 'queued-survivor'));
    await waitFor(() => fixture.manager.calls.length === 4);

    fixture.dispatcher.cancel(202, 'queued-cancelled');
    await assertPending(cancelled);
    assert.deepEqual(fixture.manager.cancelCalls, []);
    fixture.dispatcher.cancel(101, 'queued-cancelled');
    await assert.rejects(cancelled, /排队任务已取消/);
    await assertPending(survivor);

    fixture.manager.resolve('owner-active-0', complete('released slot'));
    await waitFor(() => fixture.manager.calls.length === 5);
    assert.equal(fixture.manager.calls.at(-1)?.request.requestId, 'queued-survivor');
    fixture.manager.resolve('queued-survivor', complete('survived'));
    for (let index = 1; index < 4; index += 1) {
      fixture.manager.resolve(`owner-active-${index}`, complete(`active-${index}`));
    }
    await Promise.allSettled(active);
    assert.deepEqual(await survivor, complete('survived'));
  } finally {
    await fixture.close();
  }
});

void test('cancelling one running owner does not cancel an independent queued request', async () => {
  const fixture = createFixture();
  try {
    const running = fixture.run(7, request('running-owner', 'running-owner'));
    const fillers = Array.from({ length: 3 }, (_, index) =>
      fixture.run(8, request(`filler-${index}`, `filler-${index}`)),
    );
    const queued = fixture.run(9, request('independent-queued', 'independent-queued'));
    await waitFor(() => fixture.manager.calls.length === 4);

    fixture.dispatcher.cancel(7, 'running-owner');
    assert.deepEqual(fixture.manager.cancelCalls, [
      { owner: 7, requestId: 'running-owner' },
    ]);
    await assertPending(queued);
    fixture.manager.reject('running-owner');
    await assert.rejects(running, /DSH:cancelled/);
    await waitFor(() => fixture.manager.calls.length === 5);
    assert.equal(fixture.manager.calls.at(-1)?.request.requestId, 'independent-queued');
    fixture.manager.resolve('independent-queued', complete('queued answer'));
    for (let index = 0; index < 3; index += 1) {
      fixture.manager.resolve(`filler-${index}`, complete(`filler-${index}`));
    }
    await Promise.all(fillers);
    assert.deepEqual(await queued, complete('queued answer'));
  } finally {
    await fixture.close();
  }
});

void test('failed and length results are never reused by semantic duplicates', async () => {
  for (const mode of ['failed', 'length'] as const) {
    const fixture = createFixture();
    try {
      const first = fixture.run(1, request(`${mode}-first`, 'retryable semantic request'));
      const second = fixture.run(2, request(`${mode}-second`, 'retryable semantic request'));
      await waitFor(() => fixture.manager.calls.length === 1);

      if (mode === 'failed') {
        fixture.manager.reject(`${mode}-first`);
        await assert.rejects(first, /任务未完成/);
      } else {
        fixture.manager.resolve(`${mode}-first`, complete('truncated', 'length'));
        assert.deepEqual(await first, complete('truncated', 'length'));
      }
      await waitFor(() => fixture.manager.calls.length === 2);
      fixture.manager.resolve(`${mode}-second`, complete(`${mode}-fresh`));
      assert.deepEqual(await second, complete(`${mode}-fresh`));
      assert.equal(fixture.manager.calls.length, 2);
    } finally {
      await fixture.close();
    }
  }
});

void test('close rejects queued work and never starts a new task', async () => {
  const fixture = createFixture();
  try {
    const active = Array.from({ length: 4 }, (_, index) =>
      fixture.run(1, request(`close-active-${index}`, `close-active-${index}`)),
    );
    const queued = fixture.run(1, request('close-queued', 'close-queued'));
    await waitFor(() => fixture.manager.calls.length === 4);

    const queuedRejection = assert.rejects(queued, /排队任务已取消/);
    await fixture.close();
    await queuedRejection;
    assert.equal(fixture.manager.closeCalls, 1);
    assert.equal(fixture.manager.calls.length, 4);
    await Promise.allSettled(active);
    await assert.rejects(
      fixture.dispatcher.run(1, request('after-close', 'after-close'), () => {}),
      /正在关闭/,
    );
    assert.equal(fixture.manager.calls.length, 4);
  } finally {
    // close() is idempotent for the test fixture's fake manager; this also
    // protects the test from leaving a timer behind after an assertion fails.
    if (fixture.manager.closeCalls === 0) await fixture.close();
  }
});

void test('caps total pending input at 64MB and permits a new request after release', async () => {
  const fixture = createFixture();
  try {
    const imageUrl = largePngDataUrl();
    const imageRequest = (id: string, index: number) =>
      request(id, `memory-${index}`, {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `memory-${index}` },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      });
    const accepted = Array.from({ length: 8 }, (_, index) =>
      fixture.run(1, imageRequest(`memory-${index}`, index)),
    );
    await waitFor(() => fixture.manager.calls.length === 4);

    const rejected = fixture.run(1, imageRequest('memory-rejected', 8));
    await assert.rejects(rejected, /等待数据过多/);
    assert.equal(fixture.manager.calls.length, 4);

    fixture.dispatcher.cancel(1, 'memory-7');
    await assert.rejects(accepted[7], /排队任务已取消/);
    const retried = fixture.run(1, imageRequest('memory-rejected', 8));
    await assertPending(retried);
    assert.equal(fixture.manager.calls.length, 4);
  } finally {
    await fixture.close();
  }
});

void test('a completed requestId can be explicitly regenerated with a fresh backend call', async () => {
  const fixture = createFixture();
  try {
    const first = fixture.run(1, request('regenerate', 'same semantic request'));
    await waitFor(() => fixture.manager.calls.length === 1);
    fixture.manager.resolve('regenerate', complete('first generation'));
    assert.deepEqual(await first, complete('first generation'));

    const regenerated = fixture.run(1, request('regenerate', 'same semantic request'));
    const regeneratedOutcome = regenerated.then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    const observed = await Promise.race([
      regeneratedOutcome,
      waitFor(() => fixture.manager.calls.length === 2, 250).then(
        () => ({ kind: 'started' as const }),
      ),
    ]);
    if (observed.kind === 'rejected') {
      assert.fail(
        `completed requestId could not be regenerated: ${String(observed.error)}`,
      );
    }
    if (observed.kind === 'started') {
      fixture.manager.resolve('regenerate', complete('second generation'));
      assert.deepEqual(await regeneratedOutcome, {
        kind: 'resolved',
        value: complete('second generation'),
      });
    } else {
      assert.deepEqual(observed.value, complete('second generation'));
    }
    assert.equal(fixture.manager.calls.length, 2);
  } finally {
    await fixture.close();
  }
});

void test('reserves interactive capacity during a background import', async () => {
  const fixture = createFixture();
  try {
    for (let index = 0; index < 5; index++) void fixture.run(1, request(`bg-${index}`, `bg-${index}`, { task: 'background' }));
    await waitFor(() => fixture.manager.calls.length === 3);
    const interactive = fixture.run(2, request('page-now', 'page-now', { task: 'interactive' }));
    await waitFor(() => fixture.manager.calls.length === 4);
    assert.equal(fixture.manager.calls[3].request.requestId, 'page-now');
    fixture.manager.resolve('page-now', complete('ready'));
    await interactive;
    assert.equal(fixture.manager.calls.length, 4);
  } finally { await fixture.close(); }
});

void test('prioritizes interactive work and lets waiting prefetch run after eight interactive starts', async () => {
  const fixture = createFixture();
  try {
    for (let index = 0; index < 4; index++) void fixture.run(1, request(`busy-${index}`));
    await waitFor(() => fixture.manager.calls.length === 4);
    void fixture.run(1, request('prefetch', 'prefetch', { task: 'prefetch' }));
    for (let index = 0; index < 8; index++) void fixture.run(2, request(`now-${index}`));
    const completionOrder = ['busy-0', 'busy-1', 'busy-2', 'busy-3', 'now-0'];
    for (let index = 0; index < completionOrder.length; index++) {
      fixture.manager.resolve(completionOrder[index], complete('done'));
      await waitFor(() => fixture.manager.calls.length === 5 + index);
      assert.equal(fixture.manager.calls.at(-1)?.request.requestId, index < 4 ? `now-${index}` : 'prefetch');
    }
  } finally { await fixture.close(); }
});

void test('status observers cannot fail a request and structured worker errors survive dispatch', async () => {
  const fixture = createFixture();
  try {
    const job = fixture.run(1, request('diagnostic-error'), () => { throw new Error('UI observer failed'); });
    await waitFor(() => fixture.manager.calls.length === 1);
    fixture.manager.reject('diagnostic-error', new Error('[DSH:authentication] secret-provider-text'));
    await assert.rejects(job, error => error instanceof Error && /authentication/.test(error.message) && !/secret-provider-text/.test(error.message));
  } finally { await fixture.close(); }
});

void test('immediate close cancels work before yielding to the next microtask', async () => {
  const fixture = createFixture();
  const job = fixture.run(1, request('close-immediately'));
  await fixture.close();
  assert.equal(fixture.manager.calls.length, 1);
  assert.deepEqual(fixture.manager.cancelCalls, [{ owner: 1, requestId: 'close-immediately' }]);
  assert.equal((await Promise.allSettled([job]))[0].status, 'rejected');
});

void test('queue timeout has its own safe code and never cancels an active worker', async context => {
  const fixture = createFixture();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (let index = 0; index < 4; index++) void fixture.run(1, request(`timeout-active-${index}`));
    const queued = fixture.run(2, request('timeout-queued'));
    const failure = assert.rejects(queued, error => error instanceof Error && /DSH:queue_timeout/.test(error.message));
    context.mock.timers.tick(180_000);
    await failure;
    assert.deepEqual(fixture.manager.cancelCalls, []);
  } finally { context.mock.timers.reset(); await fixture.close(); }
});
