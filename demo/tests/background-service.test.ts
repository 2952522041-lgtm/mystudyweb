import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundService, assertDesktopRole } from '../electron/background-service.ts';
import { sanitizeBackgroundSnapshot, type BackgroundCommand, type BackgroundSnapshot } from '../electron/background-types.ts';

function fixture(overrides: { maxRestarts?: number; startupTimeoutMs?: number; commandTimeoutMs?: number } = {}) {
  const hosts: Array<{ owner: number; commands: BackgroundCommand[]; destroyed: boolean; fail(): void }> = [];
  const snapshots: BackgroundSnapshot[] = [];
  const released: number[] = [];
  const service = new BackgroundService({
    ...overrides, restartDelayMs: 1,
    create: failure => {
      const host = { owner: hosts.length + 10, commands: [] as BackgroundCommand[], destroyed: false, fail() { failure(this.owner); } };
      hosts.push(host);
      return { owner: host.owner, load: async () => {}, send: command => host.commands.push(command), destroy: () => { host.destroyed = true; } };
    }, broadcast: value => snapshots.push(value), releaseOwner: owner => released.push(owner),
  });
  return { service, hosts, snapshots, released };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 500;
  while (!predicate()) { if (Date.now() >= end) throw new Error('condition timeout'); await new Promise(resolve => setTimeout(resolve, 2)); }
}
const ready: BackgroundSnapshot = { tasks: [], executor: 'desktop', available: true };

void test('worker stays unavailable until publishing; main-window reload does not stop worker', async () => {
  const { service, hosts } = fixture();
  try {
    service.start();
    assert.equal(service.getSnapshot().available, false);
    await assert.rejects(service.control(1, { action: 'pause-queued' }), /尚未就绪/);
    assert.throws(() => service.publish(1, ready), /只有后台/);
    service.publish(hosts[0].owner, ready);
    const pending = service.control(1, { action: 'pause-queued', apiKey: 'private' });
    assert.deepEqual(Object.keys(hosts[0].commands[0]).sort(), ['action', 'id']);
    const result = assert.rejects(pending, /重新加载/);
    service.cancelOwner(1);
    await result;
    assert.equal(hosts[0].destroyed, false);
    assert.equal(service.getSnapshot().available, true);
    const next = service.control(2, { action: 'resume-paused' });
    service.respond(hosts[0].owner, { id: hosts[0].commands[1].id });
    await next;
  } finally { service.close(); }
});

void test('worker crashes reject commands, release ownership, and restart only up to the bound', async () => {
  const { service, hosts, released } = fixture({ maxRestarts: 2 });
  try {
    service.start(); service.publish(hosts[0].owner, ready);
    const command = service.control(1, { action: 'retry-failed' });
    const failure = assert.rejects(command, /已中断/);
    hosts[0].fail(); await failure;
    assert.equal(service.getSnapshot().available, false);
    assert.deepEqual(released, [10]);
    await until(() => hosts.length === 2);
    assert.throws(() => service.publish(10, ready), /只有后台/);
    hosts[1].fail(); await until(() => hosts.length === 3);
    hosts[2].fail();
    assert.match(service.getSnapshot().error!, /自动恢复已停止/);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(hosts.length, 3);
    assert.ok(hosts.every(host => host.destroyed));
  } finally { service.close(); }
});

void test('worker startup and command waits are bounded, failed snapshots stay unavailable', async () => {
  const { service, hosts } = fixture({ maxRestarts: 0, startupTimeoutMs: 10, commandTimeoutMs: 10 });
  try {
    service.start();
    await until(() => hosts[0].destroyed);
    assert.equal(service.getSnapshot().available, false);
  } finally { service.close(); }
  const next = fixture({ commandTimeoutMs: 10 });
  try {
    next.service.start();
    next.service.publish(10, { ...ready, available: false, error: 'private error body' });
    assert.equal(next.service.getSnapshot().available, false);
    assert.doesNotMatch(JSON.stringify(next.service.getSnapshot()), /private/);
    next.service.publish(10, ready);
    await assert.rejects(next.service.control(1, { action: 'retry-failed' }), /未及时响应/);
  } finally { next.service.close(); }
});

void test('IPC authorization rejects other windows, wrong roles, cross-origin callers and subframes', () => {
  const windows = { main: 1, worker: 2 };
  for (const role of ['main', 'worker', 'either'] as const) {
    assert.throws(() => assertDesktopRole({ owner: 3, mainFrame: true, sameOrigin: true }, windows, role));
    assert.throws(() => assertDesktopRole({ owner: 1, mainFrame: false, sameOrigin: true }, windows, role));
    assert.throws(() => assertDesktopRole({ owner: 2, mainFrame: true, sameOrigin: false }, windows, role));
  }
  assert.throws(() => assertDesktopRole({ owner: 1, mainFrame: true, sameOrigin: true }, windows, 'worker'));
  assert.throws(() => assertDesktopRole({ owner: 2, mainFrame: true, sameOrigin: true }, windows, 'main'));
  assertDesktopRole({ owner: 1, mainFrame: true, sameOrigin: true }, windows, 'main');
  assertDesktopRole({ owner: 2, mainFrame: true, sameOrigin: true }, windows, 'worker');
});

void test('snapshot projection strips provider bodies and retains progress version and safe DSH errors', () => {
  const value = sanitizeBackgroundSnapshot({ ...ready, apiKey: 'private', tasks: [{ id: 'id', courseId: 'c', documentId: 'd', phase: 'document', status: 'failed', progressRevision: 4, error: '[DSH:authentication] private-key', message: 'private-body', sourceText: 'private-document' }] });
  assert.equal(value.tasks[0].progressRevision, 4);
  assert.match(value.tasks[0].error!, /鉴权失败/);
  assert.doesNotMatch(JSON.stringify(value), /private/);
});
