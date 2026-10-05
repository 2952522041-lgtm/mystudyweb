import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPdfTextCache,
  pdfTextCache,
  PDF_TEXT_EXTRACTION_VERSION,
} from '../lib/pdf-text-cache.ts';
import { createMemoryStore, type KVStore } from '../lib/reader-cache.ts';

function clock(): () => number {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}

function delayedStore(delayMs: number): KVStore<unknown> {
  const base = createMemoryStore<unknown>();
  const wait = () =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  return {
    async get(key) {
      await wait();
      return base.get(key);
    },
    async set(key, value) {
      await wait();
      await base.set(key, value);
    },
    async delete(key) {
      await wait();
      await base.delete(key);
    },
    async keys() {
      await wait();
      return base.keys();
    },
  };
}

function controllableStore() {
  const base = createMemoryStore<unknown>();
  const failingGet = new Set<string>();
  const failingDelete = new Set<string>();
  const failingSet = new Set<string>();
  const store: KVStore<unknown> = {
    async get(key) {
      if (failingGet.has(key)) throw new Error('get failed');
      return base.get(key);
    },
    async set(key, value) {
      if (failingSet.has(key)) throw new Error('set failed');
      await base.set(key, value);
    },
    async delete(key) {
      if (failingDelete.has(key)) throw new Error('delete failed');
      await base.delete(key);
    },
    async keys() {
      return base.keys();
    },
  };
  return { store, failingGet, failingDelete, failingSet };
}

function cloneStore<V>(base: KVStore<V>): KVStore<V> {
  return {
    get: (key) => base.get(key),
    set: (key, value) => base.set(key, value),
    delete: (key) => base.delete(key),
    keys: () => base.keys(),
  };
}

void test('miss returns undefined and hit returns the cached text', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store });
  assert.equal(await cache.get('fingerprint-a', 1), undefined);
  await cache.set('fingerprint-a', 1, 'page one text');
  assert.equal(await cache.get('fingerprint-a', 1), 'page one text');
});

void test('unicode text round-trips', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store });
  const text = '中文段落 😀 café — ﬁnal';
  await cache.set('unicode-doc', 3, text);
  assert.equal(await cache.get('unicode-doc', 3), text);
});

void test('empty string is valid and distinct from a miss', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store, maxBytes: 16 });
  await cache.set('empty-doc', 1, '');
  assert.equal(await cache.get('empty-doc', 1), '');
  assert.equal(await cache.get('empty-doc', 2), undefined);
});

void test('documents and pages are separated', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store });
  await cache.set('doc-a', 1, 'a1');
  assert.equal(await cache.get('doc-a', 1), 'a1');
  assert.equal(await cache.get('doc-a', 2), undefined);
  assert.equal(await cache.get('doc-b', 1), undefined);
});

void test('records written for another extraction version are misses and removed', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store });
  await cache.set('version-doc', 1, 'current text');
  const [key] = await store.keys();
  assert.ok(key);
  const record = (await store.get(key)) as Record<string, unknown>;
  await store.set(key, { ...record, version: 'pdf-text-v0' });
  assert.equal(await cache.get('version-doc', 1), undefined);
  assert.equal((await store.keys()).includes(key), false);
});

void test('records whose key does not match their payload are misses and removed', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store });
  await cache.set('payload-doc', 1, 'text');
  const [key] = await store.keys();
  assert.ok(key);
  await store.set(key, {
    version: PDF_TEXT_EXTRACTION_VERSION,
    fingerprint: 'different-doc',
    page: 1,
    text: 'text',
    bytes: 4,
    at: 0,
  });
  assert.equal(await cache.get('payload-doc', 1), undefined);
  assert.equal((await store.keys()).includes(key), false);
});

void test('reads touch the least recently used order', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store, maxEntries: 2, now: clock() });
  await cache.set('lru-a', 1, 'A');
  await cache.set('lru-b', 1, 'B');
  assert.equal(await cache.get('lru-a', 1), 'A');
  await cache.set('lru-c', 1, 'C');
  assert.equal(await cache.get('lru-a', 1), 'A');
  assert.equal(await cache.get('lru-b', 1), undefined);
  assert.equal(await cache.get('lru-c', 1), 'C');
});

void test('a read persists recency for a later cache instance', async () => {
  const base = createMemoryStore<unknown>();
  const now = clock();
  const first = createPdfTextCache({
    store: cloneStore(base),
    maxEntries: 2,
    maxBytes: 1024,
    now,
  });
  await first.set('persist-a', 1, 'A');
  await first.set('persist-b', 1, 'B');
  assert.equal(await first.get('persist-a', 1), 'A');

  const second = createPdfTextCache({
    store: cloneStore(base),
    maxEntries: 2,
    maxBytes: 1024,
    now,
  });
  await second.set('persist-c', 1, 'C');

  const keys = await base.keys();
  assert.ok(keys.includes('pdf-text:pdf-text-v1:persist-a:1'));
  assert.equal(keys.includes('pdf-text:pdf-text-v1:persist-b:1'), false);
  assert.equal(await second.get('persist-a', 1), 'A');
});

void test('a failed recency touch still returns the cached text', async () => {
  const { store, failingSet } = controllableStore();
  const cache = createPdfTextCache({ store, maxEntries: 10, maxBytes: 1024 });
  await cache.set('touch-fail', 1, 'cached text');
  failingSet.add('pdf-text:pdf-text-v1:touch-fail:1');
  assert.equal(await cache.get('touch-fail', 1), 'cached text');
});

void test('entry count is bounded and evicts the oldest', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store, maxEntries: 2, maxBytes: 1024 });
  await cache.set('count-a', 1, 'A');
  await cache.set('count-b', 1, 'B');
  await cache.set('count-c', 1, 'C');
  assert.equal((await store.keys()).length, 2);
  assert.equal(await cache.get('count-a', 1), undefined);
  assert.equal(await cache.get('count-b', 1), 'B');
  assert.equal(await cache.get('count-c', 1), 'C');
});

void test('byte budget counts UTF-8 bytes', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store, maxBytes: 5, maxEntries: 100 });
  await cache.set('bytes-a', 1, 'éé');
  assert.equal(await cache.get('bytes-a', 1), 'éé');
  await cache.set('bytes-b', 1, 'zzz');
  assert.equal(await cache.get('bytes-a', 1), undefined);
  assert.equal(await cache.get('bytes-b', 1), 'zzz');
});

void test('an oversize entry is not cached and does not evict others', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store, maxBytes: 4, maxEntries: 100 });
  await cache.set('small', 1, '😀');
  assert.equal(await cache.get('small', 1), '😀');
  await cache.set('big', 1, '😀😀');
  assert.equal(await cache.get('big', 1), undefined);
  assert.equal(await cache.get('small', 1), '😀');
});

void test('replacement accounts for the old size', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store, maxBytes: 5, maxEntries: 100 });
  await cache.set('replace', 1, 'aaaa');
  await cache.set('replace', 1, 'a');
  await cache.set('neighbour', 1, 'bbbb');
  assert.equal(await cache.get('replace', 1), 'a');
  assert.equal(await cache.get('neighbour', 1), 'bbbb');
});

void test('replacement overwrites the previous value', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store });
  await cache.set('overwrite', 1, 'first');
  await cache.set('overwrite', 1, 'second');
  assert.equal(await cache.get('overwrite', 1), 'second');
  assert.equal((await store.keys()).length, 1);
});

void test('malformed records are misses and are removed', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store });
  await cache.set('corrupt-doc', 1, 'ok');
  const [key] = await store.keys();
  assert.ok(key);
  await store.set(key, { not: 'a record' });
  assert.equal(await cache.get('corrupt-doc', 1), undefined);
  assert.deepEqual(await store.keys(), []);
});

void test('malformed records present before the first access are removed', async () => {
  const store = createMemoryStore<unknown>();
  await store.set('pdf-text:pdf-text-v1:corrupt:1', { nope: true });
  const cache = createPdfTextCache({ store });
  assert.equal(await cache.get('corrupt', 1), undefined);
  assert.deepEqual(await store.keys(), []);
});

void test('persisted valid records are loaded and accounted for eviction', async () => {
  const store = createMemoryStore<unknown>();
  await store.set('pdf-text:pdf-text-v1:persisted:1', {
    version: PDF_TEXT_EXTRACTION_VERSION,
    fingerprint: 'persisted',
    page: 1,
    text: '1234',
    bytes: 4,
    at: 5,
  });
  const cache = createPdfTextCache({ store, maxBytes: 5, maxEntries: 100 });
  assert.equal(await cache.get('persisted', 1), '1234');
  await cache.set('incoming', 1, 'zz');
  assert.equal(await cache.get('persisted', 1), undefined);
  assert.equal(await cache.get('incoming', 1), 'zz');
});

void test('an unavailable store never fails get, set, or clear', async () => {
  const fail = () => Promise.reject(new Error('store unavailable'));
  const store: KVStore<unknown> = {
    get: fail,
    set: fail,
    delete: fail,
    keys: fail,
  };
  const cache = createPdfTextCache({ store });
  assert.equal(await cache.get('unavailable', 1), undefined);
  await cache.set('unavailable', 1, 'text');
  await cache.clear();
});

void test('simultaneous writes keep accounting and eviction consistent', async () => {
  const store = delayedStore(1);
  const cache = createPdfTextCache({ store, maxEntries: 5, maxBytes: 1024 });
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      cache.set(`concurrent-${index}`, 1, `value-${index}`),
    ),
  );
  const keys = await store.keys();
  assert.equal(keys.length, 5);
  assert.ok(keys.every((key) => key.startsWith('pdf-text:')));
  await cache.set('concurrent-extra', 1, 'value');
  assert.equal((await store.keys()).length, 5);
});

void test('simultaneous reads and writes stay consistent', async () => {
  const store = delayedStore(1);
  const cache = createPdfTextCache({ store, maxEntries: 4, maxBytes: 1024 });
  const writes = Array.from({ length: 12 }, (_, index) =>
    cache.set(`mixed-${index}`, 1, `mixed-value-${index}`),
  );
  const reads = Array.from({ length: 12 }, (_, index) =>
    cache.get(`mixed-${index}`, 1),
  );
  await Promise.all([...writes, ...reads]);
  const keys = await store.keys();
  assert.equal(keys.length, 4);
  assert.ok(keys.every((key) => key.startsWith('pdf-text:')));
});

void test('independent caches sharing a store serialize their accounting', async () => {
  const store = createMemoryStore<unknown>();
  const first = createPdfTextCache({ store, maxEntries: 2, maxBytes: 1024 });
  const second = createPdfTextCache({ store, maxEntries: 2, maxBytes: 1024 });
  await Promise.all([
    first.set('shared-a', 1, 'A'),
    second.set('shared-b', 1, 'B'),
    first.set('shared-c', 1, 'C'),
    second.set('shared-d', 1, 'D'),
  ]);
  const keys = await store.keys();
  assert.ok(keys.length <= 2);
  assert.ok(keys.every((key) => key.startsWith('pdf-text:')));
});

void test('a failed eviction delete stops the write and rebuilds accounting', async () => {
  const { store, failingDelete } = controllableStore();
  const cache = createPdfTextCache({ store, maxEntries: 1, maxBytes: 1024 });
  await cache.set('victim', 1, 'victim text');
  const victimKey = 'pdf-text:pdf-text-v1:victim:1';
  assert.deepEqual(await store.keys(), [victimKey]);

  failingDelete.add(victimKey);
  await cache.set('incoming', 1, 'incoming text');
  assert.deepEqual(await store.keys(), [victimKey]);
  assert.equal(await cache.get('incoming', 1), undefined);

  failingDelete.delete(victimKey);
  await cache.set('incoming', 1, 'incoming text');
  assert.deepEqual(await store.keys(), ['pdf-text:pdf-text-v1:incoming:1']);
  assert.equal(await cache.get('incoming', 1), 'incoming text');
  assert.equal(await cache.get('victim', 1), undefined);
});

void test('a failed get during the initial scan prevents over-budget writes', async () => {
  const { store, failingGet } = controllableStore();
  const oldKey = 'pdf-text:pdf-text-v1:old:1';
  await store.set(oldKey, {
    version: PDF_TEXT_EXTRACTION_VERSION,
    fingerprint: 'old',
    page: 1,
    text: '1234',
    bytes: 4,
    at: 1,
  });
  failingGet.add(oldKey);
  const cache = createPdfTextCache({ store, maxBytes: 5, maxEntries: 100 });
  await cache.set('incoming', 1, 'zzz');
  assert.deepEqual(await store.keys(), [oldKey]);
  assert.equal(await cache.get('incoming', 1), undefined);

  failingGet.delete(oldKey);
  await cache.set('incoming', 1, 'zzz');
  assert.deepEqual(await store.keys(), ['pdf-text:pdf-text-v1:incoming:1']);
  assert.equal(await cache.get('incoming', 1), 'zzz');
  assert.equal(await cache.get('old', 1), undefined);
});

void test('a failed corrupt-key cleanup aborts admission', async () => {
  const { store, failingDelete } = controllableStore();
  const corruptKey = 'pdf-text:pdf-text-v1:corrupt:1';
  await store.set(corruptKey, { nope: true });
  failingDelete.add(corruptKey);
  const cache = createPdfTextCache({ store, maxEntries: 10, maxBytes: 1024 });
  await cache.set('incoming', 1, 'text');
  assert.deepEqual(await store.keys(), [corruptKey]);
  assert.equal(await cache.get('incoming', 1), undefined);
});

void test('a partially failed clear is retryable instead of silently cleared', async () => {
  const { store, failingDelete } = controllableStore();
  const cache = createPdfTextCache({ store });
  await cache.set('clear-a', 1, 'A');
  await cache.set('clear-b', 1, 'B');
  const keyA = 'pdf-text:pdf-text-v1:clear-a:1';
  const keyB = 'pdf-text:pdf-text-v1:clear-b:1';
  failingDelete.add(keyB);
  await cache.clear();
  assert.equal(await store.get(keyA), undefined);
  assert.notEqual(await store.get(keyB), undefined);
  assert.equal(await cache.get('clear-b', 1), 'B');

  failingDelete.delete(keyB);
  await cache.clear();
  assert.deepEqual(await store.keys(), []);
  assert.equal(await cache.get('clear-b', 1), undefined);
});

void test('a pre-existing oversized store is trimmed before admitting new data', async () => {
  const { store } = controllableStore();
  for (let index = 0; index < 3; index += 1) {
    await store.set(`pdf-text:pdf-text-v1:old-${index}:1`, {
      version: PDF_TEXT_EXTRACTION_VERSION,
      fingerprint: `old-${index}`,
      page: 1,
      text: '0123456789',
      bytes: 10,
      at: index + 1,
    });
  }
  const cache = createPdfTextCache({ store, maxBytes: 25, maxEntries: 2 });
  await cache.set('fresh', 1, 'x');
  const keys = await store.keys();
  assert.ok(keys.length <= 2);
  assert.ok(keys.includes('pdf-text:pdf-text-v1:fresh:1'));
  let total = 0;
  for (const key of keys) {
    const record = (await store.get(key)) as { text: string };
    total += new TextEncoder().encode(record.text).length;
  }
  assert.ok(total <= 25);
});

void test('the default store serializes writes through navigator.locks', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const requested: string[] = [];
  const fakeNavigator = {
    locks: {
      request: async (
        name: string,
        _options: unknown,
        callback: () => Promise<unknown>,
      ): Promise<unknown> => {
        requested.push(name);
        return callback();
      },
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: fakeNavigator,
  });
  try {
    const cache = createPdfTextCache();
    await cache.set('lock-doc', 1, 'text');
    await cache.clear();
    assert.ok(requested.length >= 2);
    assert.equal(new Set(requested).size, 1);
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'navigator', original);
    }
  }
});

void test('clear preserves unrelated keys and keeps the cache usable', async () => {
  const store = createMemoryStore<unknown>();
  await store.set('progress:doc', 'keep me');
  await store.set('unrelated', { nested: true });
  const cache = createPdfTextCache({ store, maxEntries: 1 });
  await cache.set('clear-a', 1, 'A');
  await cache.set('clear-b', 1, 'B');
  await cache.clear();
  assert.equal(await store.get('progress:doc'), 'keep me');
  assert.deepEqual(await store.get('unrelated'), { nested: true });
  assert.equal(await cache.get('clear-b', 1), undefined);
  await cache.set('clear-c', 1, 'C');
  assert.equal(await cache.get('clear-c', 1), 'C');
  assert.equal(await store.get('progress:doc'), 'keep me');
});

void test('eviction never removes unrelated keys', async () => {
  const store = createMemoryStore<unknown>();
  await store.set('progress:doc', 'keep me');
  await store.set('unrelated', 'keep me too');
  const cache = createPdfTextCache({ store, maxEntries: 1 });
  await cache.set('evict-a', 1, 'A');
  await cache.set('evict-b', 1, 'B');
  assert.equal(await store.get('progress:doc'), 'keep me');
  assert.equal(await store.get('unrelated'), 'keep me too');
});

void test('invalid fingerprints and pages are rejected', async () => {
  const store = createMemoryStore<unknown>();
  const cache = createPdfTextCache({ store });
  await assert.rejects(() => cache.get('', 1), TypeError);
  await assert.rejects(() => cache.get('x'.repeat(257), 1), TypeError);
  await assert.rejects(() => cache.get('fp', 0), TypeError);
  await assert.rejects(() => cache.get('fp', -1), TypeError);
  await assert.rejects(() => cache.get('fp', 1.5), TypeError);
  await assert.rejects(() => cache.get('fp', Number.NaN), TypeError);
  await assert.rejects(
    () => cache.set('fp', 1, 42 as unknown as string),
    TypeError,
  );
  await assert.rejects(() => cache.set('', 1, 'text'), TypeError);
  await assert.rejects(() => cache.set('fp', 0, 'text'), TypeError);
});

void test('invalid numeric limits are rejected', () => {
  assert.throws(() => createPdfTextCache({ maxBytes: 0 }), RangeError);
  assert.throws(() => createPdfTextCache({ maxBytes: -1 }), RangeError);
  assert.throws(() => createPdfTextCache({ maxBytes: 1.5 }), RangeError);
  assert.throws(() => createPdfTextCache({ maxBytes: Number.NaN }), RangeError);
  assert.throws(() => createPdfTextCache({ maxEntries: 0 }), RangeError);
  assert.throws(() => createPdfTextCache({ maxEntries: -5 }), RangeError);
  assert.throws(() => createPdfTextCache({ maxEntries: 2.5 }), RangeError);
  assert.throws(
    () => createPdfTextCache({ maxEntries: Number.POSITIVE_INFINITY }),
    RangeError,
  );
});

void test('the shared instance exposes the cache surface', () => {
  assert.equal(PDF_TEXT_EXTRACTION_VERSION, 'pdf-text-v1');
  assert.equal(typeof pdfTextCache.get, 'function');
  assert.equal(typeof pdfTextCache.set, 'function');
  assert.equal(typeof pdfTextCache.clear, 'function');
});
