import assert from 'node:assert/strict';
import test from 'node:test';

import { mapWithConcurrency } from '../lib/async-pool.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

void test('mapWithConcurrency respects the concurrency limit and preserves order', async () => {
  const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
  const started: number[] = [];
  const firstBatchReady = deferred();
  const thirdStarted = deferred();
  const fourthStarted = deferred();
  let active = 0;
  let maximumActive = 0;

  const resultPromise = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
    started.push(item);
    if (started.length === 2) firstBatchReady.resolve();
    if (started.length === 3) thirdStarted.resolve();
    if (started.length === 4) fourthStarted.resolve();
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (item < gates.length) {
      const value = await gates[item].promise;
      active -= 1;
      return value;
    }
    active -= 1;
    return item * 10;
  });

  await firstBatchReady.promise;
  assert.deepEqual(started, [0, 1]);
  assert.equal(maximumActive, 2);

  gates[1].resolve(10);
  await thirdStarted.promise;
  assert.deepEqual(started, [0, 1, 2]);

  gates[0].resolve(0);
  await fourthStarted.promise;
  assert.deepEqual(started, [0, 1, 2, 3]);

  gates[2].resolve(20);
  const result = await resultPromise;
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.deepEqual(result, [0, 10, 20, 30, 40]);
  assert.equal(maximumActive, 2);
});

void test('mapWithConcurrency rejects invalid concurrency before invoking the worker', async () => {
  let calls = 0;
  const worker = async () => {
    calls += 1;
    return 1;
  };

  for (const concurrency of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    await assert.rejects(
      mapWithConcurrency([1], concurrency, worker),
      RangeError,
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(await mapWithConcurrency([], 1, worker), []);
});

void test('external cancellation stops queued work and reaches every started worker', async () => {
  const cancellation = new AbortController();
  const started: number[] = [];
  const signals: AbortSignal[] = [];
  const firstBatchReady = deferred();
  const cleanup = [deferred(), deferred()];

  const resultPromise = mapWithConcurrency(
    [0, 1, 2, 3],
    2,
    async (item, _index, signal) => {
      started.push(item);
      if (started.length === 2) firstBatchReady.resolve();
      signals.push(signal);
      await cleanup[item].promise;
      return item;
    },
    { signal: cancellation.signal },
  );

  await firstBatchReady.promise;
  assert.deepEqual(started, [0, 1]);

  const reason = new Error('cancelled by caller');
  cancellation.abort(reason);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, true);
  assert.equal(signals[0].reason, reason);

  cleanup[0].resolve();
  cleanup[1].resolve();
  await assert.rejects(resultPromise, (error) => error === reason);
  assert.deepEqual(started, [0, 1]);
});

void test('the first worker failure stops queued work, preserves its error, and awaits cleanup', async () => {
  const cleanup = deferred();
  const started: number[] = [];
  const firstBatchReady = deferred();
  const secondWorkerAborted = deferred();
  const secondWorkerCleaned = deferred();
  const firstError = new Error('first failure');
  let settled = false;

  const resultPromise = mapWithConcurrency(
    [0, 1, 2, 3],
    2,
    async (item, _index, signal) => {
      started.push(item);
      if (started.length === 2) firstBatchReady.resolve();
      if (item === 0) {
        throw firstError;
      }
      if (signal.aborted) {
        secondWorkerAborted.resolve();
      } else {
        signal.addEventListener('abort', () => secondWorkerAborted.resolve(), {
          once: true,
        });
      }
      await cleanup.promise;
      secondWorkerCleaned.resolve();
      return item;
    },
  ).finally(() => {
    settled = true;
  });

  await firstBatchReady.promise;
  await secondWorkerAborted.promise;
  assert.deepEqual(started, [0, 1]);
  assert.equal(settled, false);

  cleanup.resolve();
  await secondWorkerCleaned.promise;

  await assert.rejects(resultPromise, (error) => error === firstError);
  assert.equal(settled, true);
  assert.deepEqual(started, [0, 1]);
});

void test('an already-aborted external signal starts no work', async () => {
  const cancellation = new AbortController();
  const reason = new Error('already cancelled');
  cancellation.abort(reason);
  let calls = 0;

  await assert.rejects(
    mapWithConcurrency(
      [1, 2],
      1,
      async () => {
        calls += 1;
        return 1;
      },
      { signal: cancellation.signal },
    ),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
});
