import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DshDispatcher } from '../electron/dsh-dispatcher.ts';
import { DshError, classifyDshProviderError } from '../electron/dsh-errors.ts';
import {
  DshHistory,
  sanitizeDshRecord,
  type DshRunRecord,
} from '../electron/dsh-history.ts';
import type {
  DshCompletionRequest,
  DshProgress,
} from '../electron/dsh-types.ts';

const request: DshCompletionRequest = {
  requestId: 'run-test',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'private-test-key',
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: 'private source text' }],
  maxTokens: 128,
  thinking: 'disabled',
  task: 'background',
  retryTransient: true,
};

void test('one opt-in transient retry shares execution deadline and records sanitized timing', async () => {
  const calls: DshCompletionRequest[] = [],
    records: DshRunRecord[] = [],
    statuses: DshProgress[] = [];
  const manager = {
    run: async (
      _owner: number,
      req: DshCompletionRequest,
      progress: (value: DshProgress) => void,
    ) => {
      calls.push(req);
      progress({
        requestId: req.requestId,
        content: '',
        status: {
          phase: 'running',
          task: 'background',
          startupMs: 1,
          retries: 0,
        },
      });
      if (calls.length === 1) throw new DshError('network');
      return { content: 'ok', finishReason: 'stop' as const };
    },
    cancel: () => {},
    close: async () => {},
  };
  const dispatcher = new DshDispatcher('', manager, {
    retryDelayMs: 2,
    onRecord: (r) => records.push(r),
  });
  assert.equal(
    (await dispatcher.run(1, request, (v) => statuses.push(v))).content,
    'ok',
  );
  await dispatcher.close();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].timeoutMs! <= calls[0].timeoutMs!);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'completed');
  assert.equal(records[0].retries, 1);
  assert.ok(statuses.some((v) => v.status?.retries === 1));
  assert.ok(!JSON.stringify(records).includes('private'));
});

void test('authentication, quota, timeout, partial output, and non-opted calls never auto retry', async () => {
  for (const [code, partial, opted] of [
    ['authentication', false, true],
    ['rate_limit', false, true],
    ['timeout', false, true],
    ['network', true, true],
    ['network', false, false],
  ] as const) {
    let calls = 0;
    const dispatcher = new DshDispatcher(
      '',
      {
        run: async (
          _owner: number,
          req: DshCompletionRequest,
          progress: (v: DshProgress) => void,
        ) => {
          calls++;
          if (partial)
            progress({ requestId: req.requestId, content: 'partial' });
          throw new DshError(code);
        },
        cancel: () => {},
        close: async () => {},
      },
      { retryDelayMs: 0 },
    );
    await assert.rejects(
      dispatcher.run(1, { ...request, retryTransient: opted }, () => {}),
    );
    await dispatcher.close();
    assert.equal(calls, 1);
  }
  assert.equal(classifyDshProviderError({ status: 503 }).code, 'service_busy');
  assert.equal(
    classifyDshProviderError({ status: 429, code: 'QUOTA' }).code,
    'rate_limit',
  );
});

void test('cancel during retry delay stops the second request and records cancellation', async () => {
  let calls = 0;
  const records: DshRunRecord[] = [];
  const dispatcher = new DshDispatcher(
    '',
    {
      run: async () => {
        calls++;
        throw new DshError('service_busy');
      },
      cancel: () => {},
      close: async () => {},
    },
    { retryDelayMs: 5000, onRecord: (r) => records.push(r) },
  );
  const run = dispatcher.run(1, request, (status) => {
    if (status.status?.retries === 1) dispatcher.cancel(1, request.requestId);
  });
  await assert.rejects(run, /DSH:cancelled/);
  await dispatcher.close();
  assert.equal(calls, 1);
  assert.equal(records[0].status, 'cancelled');
});

void test('persistent history survives reload, bounds records and drops unapproved fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yeyu-history-'));
  const file = path.join(dir, 'runs.json');
  try {
    const history = new DshHistory(file, 2);
    const record: DshRunRecord = {
      id: 'a',
      model: 'deepseek-flash',
      task: 'background',
      status: 'completed',
      startedAt: new Date().toISOString(),
      queueMs: 1,
      startupMs: 2,
      executionMs: 3,
      totalMs: 6,
      retries: 0,
    };
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        history.append({ ...record, id, apiKey: 'private' } as DshRunRecord),
      ),
    );
    assert.deepEqual(
      (await new DshHistory(file, 2).list()).map((r) => r.id),
      ['c', 'b'],
    );
    assert.ok(!(await readFile(file, 'utf8')).includes('private'));
    assert.equal(sanitizeDshRecord({ ...record, id: '../../secret' }), null);
    await writeFile(file, 'not-json');
    assert.deepEqual(await new DshHistory(file).list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
