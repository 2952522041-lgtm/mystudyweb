import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DshManager } from '../electron/dsh-manager.ts';

const FAKE_WORKER = `
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [runtimeRoot, taskRoot] = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const mode = request.messages[0]?.content;

await writeFile(
  path.join(runtimeRoot, 'task-' + request.requestId + '.txt'),
  taskRoot,
);

function send(frame) {
  return new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(frame) + '\\n', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

if (mode === 'structured-error') {
  await send({ type: 'error', code: 'authentication', message: 'private-key private-body' });
  process.exitCode = 1;
} else if (mode === 'ready-success') {
  await send({ type: 'ready' });
  await send({ type: 'result', content: 'complete answer', finishReason: 'stop' });
} else if (mode === 'success') {
  await send({ type: 'progress', content: 'partial answer' });
  await send({ type: 'result', content: 'complete answer', finishReason: 'stop' });
} else if (mode === 'length') {
  await send({ type: 'progress', content: 'partial answer' });
  await send({ type: 'result', content: 'truncated answer', finishReason: 'length' });
} else if (mode === 'nonzero') {
  await send({ type: 'progress', content: 'partial before failure' });
  process.exitCode = 2;
} else if (mode === 'unfinal') {
  await send({ type: 'progress', content: 'partial without final' });
} else if (mode === 'invalid-final') {
  await send({ type: 'result', content: 'invalid', finishReason: 'unknown' });
} else if (mode === 'wait') {
  await send({ type: 'progress', content: 'waiting' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await send({ type: 'progress', content: 'still waiting' });
  await new Promise((resolve) => setTimeout(resolve, 10_000));
} else {
  throw new Error('unknown fake-worker mode');
}
`;

type Fixture = {
  root: string;
  runtimeRoot: string;
  manager: DshManager;
  active: Array<Promise<unknown>>;
  track<T>(promise: Promise<T>): Promise<T>;
};

async function createFixture(timeoutMs = 1_000): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-dsh-test-'));
  const workerPath = path.join(root, 'fake-worker.mjs');
  const runtimeRoot = path.join(root, 'runtime');
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(workerPath, FAKE_WORKER, { mode: 0o600 });

  const active: Array<Promise<unknown>> = [];
  const manager = new DshManager(
    workerPath,
    runtimeRoot,
    process.execPath,
    timeoutMs,
  );
  return {
    root,
    runtimeRoot,
    manager,
    active,
    track<T>(promise: Promise<T>): Promise<T> {
      active.push(promise);
      return promise;
    },
  };
}

async function disposeFixture(fixture: Fixture): Promise<void> {
  await fixture.manager.close();
  // The manager owns no aggregate promise; settle tracked runs before
  // removing the fixture directory used by fake workers.
  await Promise.allSettled(fixture.active);
  await rm(fixture.root, { recursive: true, force: true });
}

function request(requestId: string, mode: string) {
  return {
    requestId,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-key',
    model: 'deepseek-flash',
    messages: [{ role: 'user' as const, content: mode }],
    maxTokens: 128,
    thinking: 'default' as const,
  };
}

function progressCollector() {
  const values: Array<{ requestId: string; content: string }> = [];
  return {
    values,
    onProgress: (value: { requestId: string; content: string }) =>
      values.push(value),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('timed out waiting for fake worker');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function assertRejectsWithin<T>(
  promise: Promise<T>,
  timeoutMs = 1_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('manager promise did not settle')),
      timeoutMs,
    );
    promise.then(
      () => {
        clearTimeout(timer);
        reject(new Error('manager promise unexpectedly resolved'));
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve(error);
      },
    );
  });
}

void test('runs a fake worker, forwards progress, and returns the final result', async () => {
  const fixture = await createFixture();
  try {
    const progress = progressCollector();
    const result = await fixture.track(
      fixture.manager.run(
        7,
        request('success-1', 'success'),
        progress.onProgress,
      ),
    );
    assert.deepEqual(result, {
      content: 'complete answer',
      finishReason: 'stop',
    });
    assert.deepEqual(progress.values, [
      { requestId: 'success-1', content: 'partial answer' },
    ]);
  } finally {
    await disposeFixture(fixture);
  }
});

void test('worker readiness emits startup/execution timings and errors retain only allowlisted codes', async () => {
  const fixture = await createFixture();
  try {
    const status: Array<import('../electron/dsh-types.ts').DshProgress> = [];
    await fixture.track(fixture.manager.run(7, request('timing', 'ready-success'), value => status.push(value)));
    assert.equal(status[0].status?.phase, 'running');
    assert.ok(status[0].status!.startupMs! >= 0);
    assert.equal(status[1].status?.phase, 'completed');
    assert.ok(status[1].status!.executionMs! >= 0);
    await assert.rejects(fixture.track(fixture.manager.run(7, request('safe-error', 'structured-error'), () => {})), error => error instanceof Error && /authentication/.test(error.message) && !/private/.test(error.message));
  } finally { await disposeFixture(fixture); }
});

void test('rejects a nonzero exit and an unfinalized worker without returning partial output', async () => {
  const fixture = await createFixture();
  try {
    for (const [requestId, mode] of [
      ['nonzero-1', 'nonzero'],
      ['unfinal-1', 'unfinal'],
    ] as const) {
      const progress = progressCollector();
      const run = fixture.track(
        fixture.manager.run(7, request(requestId, mode), progress.onProgress),
      );
      const error = await assertRejectsWithin(run);
      assert.ok(error instanceof Error);
      assert.deepEqual(progress.values, [
        {
          requestId,
          content:
            mode === 'nonzero'
              ? 'partial before failure'
              : 'partial without final',
        },
      ]);
    }
  } finally {
    await disposeFixture(fixture);
  }
});

void test('cancel only cancels a matching owner', async () => {
  const fixture = await createFixture();
  try {
    const progress = progressCollector();
    const run = fixture.track(
      fixture.manager.run(11, request('owner-1', 'wait'), progress.onProgress),
    );
    await waitFor(() => progress.values.length === 1);

    fixture.manager.cancel(12, 'owner-1');
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.deepEqual(progress.values, [
      { requestId: 'owner-1', content: 'waiting' },
      { requestId: 'owner-1', content: 'still waiting' },
    ]);

    fixture.manager.cancel(11, 'owner-1');
    const error = await assertRejectsWithin(run);
    assert.ok(error instanceof Error);
    assert.match(error.message, /DSH/);
  } finally {
    await disposeFixture(fixture);
  }
});

void test('cancelOwner cancels every request owned by the destroyed renderer', async () => {
  const fixture = await createFixture();
  try {
    const first = progressCollector();
    const second = progressCollector();
    const firstRun = fixture.track(
      fixture.manager.run(
        21,
        request('owner-group-1', 'wait'),
        first.onProgress,
      ),
    );
    const secondRun = fixture.track(
      fixture.manager.run(
        21,
        request('owner-group-2', 'wait'),
        second.onProgress,
      ),
    );
    await waitFor(
      () => first.values.length === 1 && second.values.length === 1,
    );

    fixture.manager.cancelOwner(21);
    const results = await Promise.allSettled([firstRun, secondRun]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'rejected');
  } finally {
    await disposeFixture(fixture);
  }
});

void test('times out a worker and bounds the run promise', async () => {
  const fixture = await createFixture(35);
  try {
    const progress = progressCollector();
    const run = fixture.track(
      fixture.manager.run(
        31,
        request('timeout-1', 'wait'),
        progress.onProgress,
      ),
    );
    await waitFor(() => progress.values.length === 1);
    const error = await assertRejectsWithin(run, 800);
    assert.ok(error instanceof Error);
    assert.match(error.message, /DSH/);
  } finally {
    await disposeFixture(fixture);
  }
});

void test('rejects duplicate request IDs while the first request is active', async () => {
  const fixture = await createFixture();
  try {
    const progress = progressCollector();
    const first = fixture.track(
      fixture.manager.run(
        41,
        request('duplicate-1', 'wait'),
        progress.onProgress,
      ),
    );
    await waitFor(() => progress.values.length === 1);

    await assert.rejects(
      fixture.manager.run(
        42,
        request('duplicate-1', 'success'),
        () => undefined,
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes('重复'),
    );
    fixture.manager.cancel(41, 'duplicate-1');
    await assertRejectsWithin(first);
  } finally {
    await disposeFixture(fixture);
  }
});

void test('enforces the four-request concurrency limit', async () => {
  const fixture = await createFixture();
  try {
    const progress = [0, 1, 2, 3].map(() => progressCollector());
    const runs = progress.map((collector, index) =>
      fixture.track(
        fixture.manager.run(
          51,
          request(`concurrent-${index}`, 'wait'),
          collector.onProgress,
        ),
      ),
    );
    await waitFor(() =>
      progress.every((collector) => collector.values.length === 1),
    );

    await assert.rejects(
      fixture.manager.run(
        52,
        request('concurrent-overflow', 'success'),
        () => undefined,
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes('其他任务'),
    );
    fixture.manager.cancelAll();
    const results = await Promise.allSettled(runs);
    assert.ok(results.every((result) => result.status === 'rejected'));
  } finally {
    await disposeFixture(fixture);
  }
});

void test('removes the per-request temporary directory after completion', async () => {
  const fixture = await createFixture();
  try {
    const progress = progressCollector();
    await fixture.track(
      fixture.manager.run(
        61,
        request('cleanup-1', 'success'),
        progress.onProgress,
      ),
    );
    const taskRoot = await readFile(
      path.join(fixture.runtimeRoot, 'task-cleanup-1.txt'),
      'utf8',
    );
    await assert.rejects(access(taskRoot));
  } finally {
    await disposeFixture(fixture);
  }
});
