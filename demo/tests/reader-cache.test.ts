import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryStore,
  createProgressStore,
  createTranslationCache,
  DEFAULT_SETTINGS,
  loadReaderSettings,
  resolvePageTranslation,
  saveReaderSettings,
  usingRemoteProvider,
  type CachedTranslation,
  type DocumentProgress,
} from '../lib/reader-cache.ts';
import { createMockTranslationProvider } from '../lib/translation.ts';

void test('translation cache stores and retrieves by document, page, language, and provider', async () => {
  const cache = createTranslationCache(createMemoryStore<CachedTranslation>());
  const parts = {
    fingerprint: 'fp1',
    pageNumber: 3,
    sourceHash: 'hash3',
    targetLanguage: '简体中文',
    provider: 'mock',
    model: 'demo',
  };
  assert.equal(await cache.lookup(parts), undefined);
  await cache.save({
    key: '',
    fingerprint: parts.fingerprint,
    pageNumber: parts.pageNumber,
    sourceHash: parts.sourceHash,
    paragraphs: ['段落一', '段落二'],
    targetLanguage: parts.targetLanguage,
    provider: parts.provider,
    model: parts.model,
    updatedAt: new Date().toISOString(),
  });
  const hit = await cache.lookup(parts);
  assert.equal(hit?.paragraphs.length, 2);
  assert.equal(await cache.lookup({ ...parts, targetLanguage: '日本語' }), undefined);
  assert.equal(
    await cache.lookup({ ...parts, provider: 'openai-compatible', model: 'gpt-4o-mini' }),
    undefined,
  );
});

void test('resolvePageTranslation returns cached results without calling the provider', async () => {
  const cache = createTranslationCache(createMemoryStore<CachedTranslation>());
  const provider = createMockTranslationProvider();
  const request = { text: 'One.\n\nTwo.', sourceLanguage: 'auto', targetLanguage: '简体中文', pageNumber: 2 };
  const fingerprint = 'fp';

  const first = await resolvePageTranslation({ provider, cache, fingerprint, request });
  assert.equal(first.status, 'complete');

  let providerCalls = 0;
  const countingProvider = {
    id: provider.id,
    model: provider.model,
    async translate() {
      providerCalls += 1;
      return provider.translate(request);
    },
  };
  const second = await resolvePageTranslation({ provider: countingProvider, cache, fingerprint, request });
  assert.equal(second.status, 'cached');
  assert.equal(providerCalls, 0);
  assert.deepEqual(second.result.paragraphs, first.result.paragraphs);
});

void test('resolvePageTranslation never reuses cache across languages', async () => {
  const cache = createTranslationCache(createMemoryStore<CachedTranslation>());
  const provider = createMockTranslationProvider();
  const fingerprint = 'fp';
  await resolvePageTranslation({
    provider,
    cache,
    fingerprint,
    request: { text: 'One.', sourceLanguage: 'auto', targetLanguage: '简体中文', pageNumber: 1 },
  });
  const otherLanguage = await resolvePageTranslation({
    provider,
    cache,
    fingerprint,
    request: { text: 'One.', sourceLanguage: 'auto', targetLanguage: '日本語', pageNumber: 1 },
  });
  assert.equal(otherLanguage.status, 'complete');
});

void test('progress store round-trips reading position per document', async () => {
  const progress = createProgressStore(createMemoryStore<DocumentProgress>());
  assert.equal(await progress.load('fp1'), undefined);
  await progress.save({
    fingerprint: 'fp1',
    fileName: 'book.pdf',
    pageCount: 120,
    lastPage: 42,
    zoom: 110,
    targetLanguage: '简体中文',
    updatedAt: new Date().toISOString(),
  });
  const loaded = await progress.load('fp1');
  assert.equal(loaded?.lastPage, 42);
  assert.equal(loaded?.zoom, 110);
});

void test('reader settings fall back to defaults on missing or corrupt data', () => {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
  } satisfies Pick<Storage, 'getItem' | 'setItem'>;

  assert.deepEqual(loadReaderSettings(storage), DEFAULT_SETTINGS);
  saveReaderSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', providerMode: 'openai-compatible' }, storage);
  assert.equal(loadReaderSettings(storage).apiKey, 'sk-test');

  backing.set('pdf-reader-settings', '{not json');
  assert.deepEqual(loadReaderSettings(storage), DEFAULT_SETTINGS);
});

void test('remote provider is only active with a configured key', () => {
  assert.equal(usingRemoteProvider(DEFAULT_SETTINGS), false);
  assert.equal(
    usingRemoteProvider({ ...DEFAULT_SETTINGS, providerMode: 'openai-compatible' }),
    false,
  );
  assert.equal(
    usingRemoteProvider({ ...DEFAULT_SETTINGS, providerMode: 'openai-compatible', apiKey: 'sk-test' }),
    true,
  );
});
