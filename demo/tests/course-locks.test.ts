import assert from 'node:assert/strict';
import test from 'node:test';
import { CourseLocks } from '../electron/course-locks.ts';

void test('course locks serialize renderer owners FIFO while independent courses proceed', async () => {
  const locks = new CourseLocks();
  const first = await locks.acquire(1, '课程 A');
  const order: number[] = [];
  const second = locks.acquire(2, '课程 A').then(token => { order.push(2); return token; });
  const third = locks.acquire(3, '课程 A').then(token => { order.push(3); return token; });
  const independent = await locks.acquire(2, '课程 B');
  assert.deepEqual(order, []);
  assert.throws(() => locks.release(2, first), /不属于/);
  locks.release(1, first);
  const secondToken = await second;
  assert.deepEqual(order, [2]);
  locks.release(2, secondToken);
  locks.release(3, await third);
  locks.release(2, independent);
  assert.deepEqual(order, [2, 3]);
  await locks.close();
});

void test('navigation revokes pending and held leases, but waits for in-flight filesystem writes', async () => {
  const locks = new CourseLocks();
  await locks.acquire(1, '课程');
  let finish!: () => void;
  const operation = locks.run(1, '课程', () => new Promise<void>(resolve => { finish = resolve; }));
  const deadQueued = locks.acquire(1, '课程');
  const rejected = assert.rejects(deadQueued, /重新加载/);
  let nextStarted = false;
  const next = locks.acquire(2, '课程').then(token => { nextStarted = true; return token; });
  locks.releaseOwner(1);
  await rejected;
  await Promise.resolve();
  assert.equal(nextStarted, false);
  finish(); await operation;
  locks.release(2, await next);
  assert.equal(nextStarted, true);
  await locks.close();
});

void test('standalone writes release on failure, unsafe directories fail, and waiting is bounded', async () => {
  const locks = new CourseLocks(10);
  await assert.rejects(locks.run(1, '课程', async () => { throw new Error('disk failed'); }), /disk failed/);
  const token = await locks.acquire(2, '课程');
  await assert.rejects(locks.acquire(3, '课程'), /超时/);
  assert.throws(() => locks.acquire(1, '../outside'), /非法/);
  locks.release(2, token);
  await locks.close();
  await assert.rejects(locks.acquire(1, '课程'), /关闭/);
});
