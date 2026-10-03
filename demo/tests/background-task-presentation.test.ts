import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTaskDuration,
  summarizeTaskCounts,
  type TaskCounts,
} from '../lib/background-task-presentation.ts';

void test('formatTaskDuration: invalid inputs render as an em dash', () => {
  assert.equal(formatTaskDuration(Number.NaN), '—');
  assert.equal(formatTaskDuration(Number.POSITIVE_INFINITY), '—');
  assert.equal(formatTaskDuration(Number.NEGATIVE_INFINITY), '—');
  assert.equal(formatTaskDuration(-1), '—');
  assert.equal(formatTaskDuration(-1000), '—');
  assert.equal(formatTaskDuration(-0.5), '—');
});

void test('formatTaskDuration: sub-second range', () => {
  assert.equal(formatTaskDuration(0), '不足 1 秒');
  assert.equal(formatTaskDuration(1), '不足 1 秒');
  assert.equal(formatTaskDuration(999), '不足 1 秒');
  assert.equal(formatTaskDuration(999.9), '不足 1 秒');
  assert.equal(formatTaskDuration(-0), '不足 1 秒');
});

void test('formatTaskDuration: seconds range', () => {
  assert.equal(formatTaskDuration(1000), '1 秒');
  assert.equal(formatTaskDuration(1500), '1 秒');
  assert.equal(formatTaskDuration(59_999), '59 秒');
});

void test('formatTaskDuration: minutes range pads seconds to two digits', () => {
  assert.equal(formatTaskDuration(60_000), '1 分 00 秒');
  assert.equal(formatTaskDuration(61_000), '1 分 01 秒');
  assert.equal(formatTaskDuration(119_000), '1 分 59 秒');
  assert.equal(formatTaskDuration(3_599_999), '59 分 59 秒');
});

void test('formatTaskDuration: hours range pads minutes to two digits', () => {
  assert.equal(formatTaskDuration(3_600_000), '1 小时 00 分');
  assert.equal(formatTaskDuration(3_660_000), '1 小时 01 分');
  assert.equal(formatTaskDuration(7_260_000), '2 小时 01 分');
  assert.equal(formatTaskDuration(86_399_999), '23 小时 59 分');
  assert.equal(formatTaskDuration(360_000_000), '100 小时 00 分');
});

void test('summarizeTaskCounts: empty input yields all zeros', () => {
  assert.deepEqual(summarizeTaskCounts([]), {
    running: 0,
    queued: 0,
    paused: 0,
    failed: 0,
    cancelled: 0,
    completed: 0,
    total: 0,
  });
});

void test('summarizeTaskCounts: mixed tasks count only known statuses', () => {
  const tasks = [
    { status: 'running' },
    { status: 'running' },
    { status: 'queued' },
    { status: 'paused' },
    { status: 'failed' },
    { status: 'cancelled' },
    { status: 'completed' },
    { status: 'completed' },
    { status: 'completed' },
    { status: 'unknown' },
    { status: 'RUNNING' },
    { status: '' },
  ];

  const expected: TaskCounts = {
    running: 2,
    queued: 1,
    paused: 1,
    failed: 1,
    cancelled: 1,
    completed: 3,
    total: 9,
  };
  assert.deepEqual(summarizeTaskCounts(tasks), expected);
});

void test('summarizeTaskCounts: does not mutate frozen input', () => {
  const first = Object.freeze({ status: 'running' });
  const second = Object.freeze({ status: 'completed' });
  const tasks = Object.freeze([
    first,
    second,
    Object.freeze({ status: 'bogus' }),
  ]);

  const snapshot = tasks.map((task) => ({ ...task }));
  const result = summarizeTaskCounts(tasks);

  assert.deepEqual(result, {
    running: 1,
    queued: 0,
    paused: 0,
    failed: 0,
    cancelled: 0,
    completed: 1,
    total: 2,
  });
  assert.deepEqual(
    tasks.map((task) => ({ ...task })),
    snapshot,
  );
  assert.ok(Object.isFrozen(tasks));
});

void test('summarizeTaskCounts: extra properties are tolerated and ignored', () => {
  const tasks = [
    { status: 'queued', id: 1, title: 'a' },
    { status: 'queued', id: 2, title: 'b' },
    { status: 'failed', id: 3, title: 'c' },
  ];

  assert.deepEqual(summarizeTaskCounts(tasks), {
    running: 0,
    queued: 2,
    paused: 0,
    failed: 1,
    cancelled: 0,
    completed: 0,
    total: 3,
  });
});
