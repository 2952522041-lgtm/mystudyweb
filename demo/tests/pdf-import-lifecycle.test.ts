import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfImportLifecycle } from '../lib/pdf-import-lifecycle.ts';

function resource() {
  const task = { calls: 0, async destroy() { this.calls++; } };
  return Object.assign(task, { loadingTask: task });
}

void test('new generations discard late loads and dispose the pending task once', () => {
  const lifecycle = createPdfImportLifecycle();
  const old = lifecycle.begin(); const task = resource(); old.ownTask(task);
  const latest = lifecycle.begin(); const doc = resource(); latest.ownTask(resource()); latest.resolved(doc);
  assert.equal(old.isCurrent(), false);
  assert.equal(old.resolved(resource()), false);
  assert.equal(old.commit(resource()), false);
  old.finish();
  assert.equal(task.calls, 1);
  assert.equal(latest.commit(doc), true);
  latest.finish();
  assert.equal(doc.calls, 0);
  lifecycle.dispose(); lifecycle.dispose();
  assert.equal(doc.calls, 1);
});

void test('superseded parsing and failed imports release proxies but preserve the displayed PDF', () => {
  const lifecycle = createPdfImportLifecycle();
  const first = lifecycle.begin(); const visible = resource(); first.resolved(visible); first.commit(visible); first.finish();
  const parsing = lifecycle.begin(); const discarded = resource(); parsing.resolved(discarded);
  const failure = lifecycle.begin(); const failed = resource(); failure.resolved(failed); failure.finish();
  assert.equal(discarded.calls, 1);
  assert.equal(failed.calls, 1);
  assert.equal(visible.calls, 0);
  assert.equal(parsing.isCurrent(), false);
  const replacement = lifecycle.begin(); const next = resource(); replacement.resolved(next); replacement.commit(next);
  assert.equal(visible.calls, 1);
  lifecycle.dispose();
  assert.equal(next.calls, 1);
});

void test('unmount invalidates pre-load work and disposes tasks registered after cancellation', () => {
  const lifecycle = createPdfImportLifecycle(); const job = lifecycle.begin(); lifecycle.dispose();
  const late = resource(); assert.equal(job.ownTask(late), false);
  assert.equal(job.isCurrent(), false); assert.equal(late.calls, 1);
});
