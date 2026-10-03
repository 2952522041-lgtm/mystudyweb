import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReadingStateStore, ReadingStateConflictError, type ReadingStateInput } from '../electron/reading-state-store.ts';

void test('reading state upgrades old records, persists complete views, and keeps legacy writers compatible', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-reading-state-'));
  const now = '2026-10-02T01:00:00.000Z';
  try {
    const store = new ReadingStateStore(root, () => Date.parse(now));
    const first = await store.put('course', 'document', { page: 2, zoom: 100, expectedVersion: 0 });
    assert.deepEqual(first, { page: 2, zoom: 100, version: 1, updatedAt: now });
    const complete = await store.put('course', 'document', { page: 2, zoom: 110, expectedVersion: 1, pageFraction: .42, rightMode: 'chat', pdfPanelPercent: 62 });
    assert.deepEqual(await new ReadingStateStore(root).get('course', 'document'), complete);
    const legacyZoom = await store.put('course', 'document', { page: 2, zoom: 120, expectedVersion: 2 });
    assert.equal(legacyZoom.pageFraction, .42);
    assert.equal(legacyZoom.rightMode, 'chat');
    assert.equal(legacyZoom.pdfPanelPercent, 62);
    const legacyPage = await store.put('course', 'document', { page: 3, zoom: 120, expectedVersion: 3 });
    assert.equal(legacyPage.pageFraction, 0, 'a new page must not inherit the previous page offset');
    assert.equal(legacyPage.rightMode, 'chat');
    const boundary = await store.put('course', 'document', { page: 3, zoom: 120, expectedVersion: 4, pageFraction: 1, pdfPanelPercent: 70, rightMode: 'mindmap' });
    assert.equal(boundary.pageFraction, 1);
    assert.equal(boundary.pdfPanelPercent, 70);
    const lower = await store.put('course', 'document', { page: 3, zoom: 120, expectedVersion: 5, pageFraction: 0, pdfPanelPercent: 40 });
    assert.equal(lower.pdfPanelPercent, 40);
  } finally { await rm(root, { recursive: true, force: true }); }
});

void test('reading view validation rejects invalid optional values before touching existing records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-reading-state-'));
  try {
    const store = new ReadingStateStore(root);
    const saved = await store.put('course', 'document', { page: 2, zoom: 100, expectedVersion: 0, pageFraction: .25, rightMode: 'summary', pdfPanelPercent: 60 });
    const invalid = [
      { pageFraction: -.01 }, { pageFraction: 1.01 }, { pageFraction: NaN }, { pageFraction: Infinity }, { pageFraction: '0.2' },
      { pdfPanelPercent: 39 }, { pdfPanelPercent: 71 }, { pdfPanelPercent: NaN }, { pdfPanelPercent: '55' },
      { rightMode: 'settings' }, { rightMode: null }, { page: 0 }, { zoom: 201 }, { expectedVersion: -1 },
    ];
    for (const extra of invalid) {
      await assert.rejects(store.put('course', 'document', { page: 2, zoom: 100, expectedVersion: 1, ...extra } as ReadingStateInput), /不合法/);
      assert.deepEqual(await store.get('course', 'document'), saved);
    }
    const recordPath = path.join(root, 'shared-reading-state.json');
    const persisted = JSON.parse(await readFile(recordPath, 'utf8'));
    persisted.states[0].pageFraction = 7;
    await writeFile(recordPath, JSON.stringify(persisted));
    await assert.rejects(store.get('course', 'document'), /损坏/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

void test('concurrent reading-view writes keep one winner and include its full view in conflicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-reading-state-'));
  try {
    const store = new ReadingStateStore(root);
    const results = await Promise.allSettled([
      store.put('course', 'document', { page: 2, zoom: 100, expectedVersion: 0, pageFraction: .4, rightMode: 'chat', pdfPanelPercent: 62 }),
      store.put('course', 'document', { page: 4, zoom: 90, expectedVersion: 0, pageFraction: .8, rightMode: 'summary', pdfPanelPercent: 50 }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ReadingStateConflictError);
    assert.deepEqual(rejected.reason.current, await store.get('course', 'document'));
    assert.ok(rejected.reason.current);
    assert.equal(rejected.reason.current.pageFraction, .4);
    assert.equal(rejected.reason.current.pdfPanelPercent, 62);
    assert.equal(rejected.reason.current.rightMode, 'chat');
  } finally { await rm(root, { recursive: true, force: true }); }
});
