import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceWithinBudget } from '../lib/knowledge/hierarchical-synthesis.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function oversizedRecords() {
  return [0, 1, 2].map((index) => ({
    id: index,
    text: String(index).repeat(13000),
  }));
}

void test('reduces same-round batches with two workers and keeps their order', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const started: number[] = [];
  const firstBatchReady = deferred();
  const thirdStarted = deferred();
  let active = 0;
  let maximumActive = 0;

  const resultPromise = reduceWithinBudget({
    records: oversizedRecords(),
    layer: 'document',
    identity: 'document',
    report() {},
    reduce: async (records, identity) => {
      if (identity.endsWith('/final')) {
        return records.map((record) => (record as { batch: number }).batch);
      }
      const index = Number(identity.match(/batch-(\d+)$/)?.[1]);
      started.push(index);
      if (started.length === 2) firstBatchReady.resolve();
      if (started.length === 3) thirdStarted.resolve();
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gates[index]!.promise;
      active -= 1;
      return { batch: index };
    },
  });

  await firstBatchReady.promise;
  assert.deepEqual(started, [0, 1]);
  assert.equal(maximumActive, 2);

  gates[1]!.resolve();
  await thirdStarted.promise;
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(maximumActive, 2);

  gates[0]!.resolve();
  gates[2]!.resolve();
  assert.deepEqual(await resultPromise, [0, 1, 2]);
});

void test('the first same-round failure aborts active work, waits for cleanup, and skips queued batches', async () => {
  const cleanup = deferred();
  const firstBatchReady = deferred();
  const activeAborted = deferred();
  const activeCleaned = deferred();
  const started: number[] = [];
  const firstError = new Error('first synthesis failure');
  let settled = false;

  const resultPromise = reduceWithinBudget({
    records: oversizedRecords(),
    layer: 'document',
    identity: 'document',
    report() {},
    reduce: async (_records, identity, _intermediate, signal) => {
      if (identity.endsWith('/final')) return {};
      const index = Number(identity.match(/batch-(\d+)$/)?.[1]);
      started.push(index);
      if (started.length === 2) firstBatchReady.resolve();
      if (index === 0) throw firstError;
      if (signal?.aborted) {
        activeAborted.resolve();
      } else {
        signal?.addEventListener('abort', () => activeAborted.resolve(), {
          once: true,
        });
      }
      await cleanup.promise;
      activeCleaned.resolve();
      return { batch: index };
    },
  }).finally(() => {
    settled = true;
  });

  await firstBatchReady.promise;
  await activeAborted.promise;
  assert.deepEqual(started, [0, 1]);
  assert.equal(settled, false);

  cleanup.resolve();
  await activeCleaned.promise;
  await assert.rejects(resultPromise, (error) => error === firstError);
  assert.equal(settled, true);
  assert.deepEqual(started, [0, 1]);
});
