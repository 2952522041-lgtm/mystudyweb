import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTranslationPreset,
  createMemoryStore,
  createProgressStore,
  createTranslationCache,
  DEFAULT_SETTINGS,
  findCachedPageTranslation,
  loadReaderSettings,
  readerServiceHost,
  resolvePageTranslation,
  saveReaderSettings,
  updateReaderApiKey,
  usingRemoteProvider,
  validateReaderSettings,
  type CachedTranslation,
  type DocumentProgress,
} from '../lib/reader-cache.ts';
import { sha256Hex } from '../lib/pdf-text.ts';
import {
  publishCachedTranslationForReader,
  sharedTranslationFromCache,
  upsertSharedTranslation,
} from '../lib/shared-translation.ts';
import {
  createMockTranslationProvider,
  createOpenAICompatibleProvider,
  PROMPT_VERSION,
  TranslationError,
  type TranslationRequest,
} from '../lib/translation.ts';

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
  assert.equal(
    await cache.lookup({ ...parts, targetLanguage: '日本語' }),
    undefined,
  );
  assert.equal(
    await cache.lookup({
      ...parts,
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
    }),
    undefined,
  );
});

void test('resolvePageTranslation returns cached results without calling the provider', async () => {
  const cache = createTranslationCache(createMemoryStore<CachedTranslation>());
  const provider = createMockTranslationProvider();
  const request = {
    text: 'One.\n\nTwo.',
    sourceLanguage: 'auto',
    targetLanguage: '简体中文',
    pageNumber: 2,
  };
  const fingerprint = 'fp';

  const first = await resolvePageTranslation({
    provider,
    cache,
    fingerprint,
    request,
  });
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
  const second = await resolvePageTranslation({
    provider: countingProvider,
    cache,
    fingerprint,
    request,
  });
  assert.equal(second.status, 'cached');
  assert.equal(providerCalls, 0);
  assert.deepEqual(second.result.paragraphs, first.result.paragraphs);
  assert.equal(second.cacheEntry.fingerprint, fingerprint);
  assert.equal(second.cacheEntry.pageNumber, request.pageNumber);
  assert.equal((await cache.list()).length, 1);
});

void test('resolvePageTranslation never reuses cache across languages', async () => {
  const cache = createTranslationCache(createMemoryStore<CachedTranslation>());
  const provider = createMockTranslationProvider();
  const fingerprint = 'fp';
  await resolvePageTranslation({
    provider,
    cache,
    fingerprint,
    request: {
      text: 'One.',
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      pageNumber: 1,
    },
  });
  const otherLanguage = await resolvePageTranslation({
    provider,
    cache,
    fingerprint,
    request: {
      text: 'One.',
      sourceLanguage: 'auto',
      targetLanguage: '日本語',
      pageNumber: 1,
    },
  });
  assert.equal(otherLanguage.status, 'complete');
});

void test('course translations restore across cache resets and model changes without AI', async () => {
  const text = 'A persisted page.';
  const fingerprint = 'fp-persisted';
  const sourceHash = await sha256Hex(text);
  const cached = {
    key: '',
    fingerprint,
    pageNumber: 4,
    sourceHash,
    paragraphs: ['已保存的中文译文。'],
    targetLanguage: '简体中文',
    provider: 'old-provider',
    model: 'old-model',
    updatedAt: '2026-09-11T01:00:00.000Z',
  } satisfies CachedTranslation;
  const japanese = sharedTranslationFromCache(
    {
      ...cached,
      targetLanguage: '日本語',
      paragraphs: ['保存済みの日本語訳。'],
    },
    'course-document',
  );
  const chinese = sharedTranslationFromCache(cached, 'course-document');
  let providerCalls = 0;
  const changedProvider = {
    id: 'new-provider',
    model: 'new-model',
    async translate() {
      providerCalls += 1;
      throw new Error('不应调用翻译服务');
    },
  };

  // A fresh cache models an application restart with an empty IndexedDB.
  const afterRestart = await resolvePageTranslation({
    provider: changedProvider,
    cache: createTranslationCache(createMemoryStore<CachedTranslation>()),
    fingerprint,
    request: {
      text,
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      pageNumber: 4,
    },
    publishedTranslations: [chinese, japanese],
  });
  assert.equal(afterRestart.source, 'course');
  assert.equal(afterRestart.result.model, 'old-model');
  assert.deepEqual(afterRestart.result.paragraphs, ['已保存的中文译文。']);
  assert.equal(providerCalls, 0);

  const switchedLanguage = await resolvePageTranslation({
    provider: changedProvider,
    cache: createTranslationCache(createMemoryStore<CachedTranslation>()),
    fingerprint,
    request: {
      text,
      sourceLanguage: 'auto',
      targetLanguage: '日本語',
      pageNumber: 4,
    },
    publishedTranslations: [chinese, japanese],
  });
  assert.equal(switchedLanguage.source, 'course');
  assert.deepEqual(switchedLanguage.result.paragraphs, [
    '保存済みの日本語訳。',
  ]);
  assert.equal(providerCalls, 0);

  // The exact current-provider IndexedDB entry remains higher priority than
  // the older course-directory record.
  const exactCache =
    createTranslationCache(createMemoryStore<CachedTranslation>());
  await exactCache.save({
    ...cached,
    provider: 'new-provider',
    model: 'new-model',
    paragraphs: ['本机精确缓存。'],
  });
  const exact = await resolvePageTranslation({
    provider: changedProvider,
    cache: exactCache,
    fingerprint,
    request: {
      text,
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      pageNumber: 4,
    },
    publishedTranslations: [chinese],
  });
  assert.equal(exact.source, 'indexeddb');
  assert.deepEqual(exact.result.paragraphs, ['本机精确缓存。']);
  assert.equal(providerCalls, 0);
});

void test('bypassCache actively retranslates instead of using course persistence', async () => {
  const text = 'Retranslate this page.';
  const sourceHash = await sha256Hex(text);
  let calls = 0;
  const provider = {
    id: 'current-provider',
    model: 'current-model',
    async translate() {
      calls += 1;
      return {
        paragraphs: ['主动重新生成的译文。'],
        provider: 'current-provider',
        model: 'current-model',
      };
    },
  };
  const result = await resolvePageTranslation({
    provider,
    cache: createTranslationCache(createMemoryStore<CachedTranslation>()),
    fingerprint: 'fp-retranslate',
    request: {
      text,
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      pageNumber: 1,
    },
    bypassCache: true,
    publishedTranslations: [
      sharedTranslationFromCache(
        {
          fingerprint: 'fp-retranslate',
          pageNumber: 1,
          sourceHash,
          paragraphs: ['旧课程译文。'],
          targetLanguage: '简体中文',
          provider: 'old-provider',
          model: 'old-model',
          updatedAt: '2026-09-11T01:00:00.000Z',
        },
        'course-document',
      ),
    ],
  });
  assert.equal(result.source, 'generated');
  assert.equal(calls, 1);
  assert.deepEqual(result.result.paragraphs, ['主动重新生成的译文。']);
});

void test('course records from an older prompt version are not restored', async () => {
  const text = 'R = Rotz(φ)Roty(θ)Rotz(ψ)';
  const sourceHash = await sha256Hex(text);
  let calls = 0;
  const provider = {
    id: 'current-provider',
    model: 'current-model',
    async translate() {
      calls += 1;
      return {
        paragraphs: ['R = Rotz(φ)Roty(θ)Rotz(ψ)（修复后的译文）'],
        provider: 'current-provider',
        model: 'current-model',
      };
    },
  };
  const stale = sharedTranslationFromCache(
    {
      fingerprint: 'fp-stale-prompt',
      pageNumber: 1,
      sourceHash,
      // Pre-fix translation lost the Greek letters; its prompt is outdated.
      paragraphs: ['R = Rotz()Roty()Rotz()'],
      targetLanguage: '简体中文',
      provider: 'old-provider',
      model: 'old-model',
      updatedAt: '2026-09-20T01:00:00.000Z',
      promptVersion: PROMPT_VERSION - 1,
    },
    'course-document',
  );
  const result = await resolvePageTranslation({
    provider,
    cache: createTranslationCache(createMemoryStore<CachedTranslation>()),
    fingerprint: 'fp-stale-prompt',
    request: {
      text,
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      pageNumber: 1,
    },
    publishedTranslations: [stale],
  });
  assert.equal(result.source, 'generated');
  assert.equal(calls, 1);
  assert.match(result.result.paragraphs[0] ?? '', /φ/);
});

void test('translation completion waits for publication and keeps local result on save failure', async () => {
  const cached = {
    key: '',
    fingerprint: 'fp-save-order',
    pageNumber: 1,
    sourceHash: 'a'.repeat(64),
    paragraphs: ['本地译文仍然可用。'],
    targetLanguage: '简体中文',
    provider: 'provider',
    model: 'model',
    updatedAt: new Date().toISOString(),
  } satisfies CachedTranslation;
  let release!: () => void;
  let diskSaved = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publication = publishCachedTranslationForReader(
    {
      publishTranslation: async () => {
        await gate;
        diskSaved = true;
      },
    },
    cached,
    'document',
  );
  await Promise.resolve();
  assert.equal(diskSaved, false);
  release();
  assert.deepEqual(await publication, { status: 'saved' });
  assert.equal(diskSaved, true);

  const failed = await publishCachedTranslationForReader(
    {
      publishTranslation: async () => {
        throw new Error('磁盘暂时不可写');
      },
    },
    cached,
    'document',
  );
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /磁盘暂时不可写/);
  assert.deepEqual(cached.paragraphs, ['本地译文仍然可用。']);
});

void test('findCachedPageTranslation returns the exact current model cache', async () => {
  const cache = createTranslationCache(createMemoryStore<CachedTranslation>());
  await cache.save({
    key: '',
    fingerprint: 'fp-exact',
    pageNumber: 2,
    sourceHash: 'b'.repeat(64),
    paragraphs: ['精确缓存'],
    targetLanguage: '简体中文',
    provider: 'provider',
    model: 'model',
    updatedAt: new Date().toISOString(),
  });
  assert.equal(
    (
      await findCachedPageTranslation({
        cache,
        fingerprint: 'fp-exact',
        pageNumber: 2,
        targetLanguage: '简体中文',
        provider: 'provider',
        model: 'model',
      })
    )?.paragraphs[0],
    '精确缓存',
  );
});

void test('a newly published translation remains available after model changes', () => {
  const oldRecord = sharedTranslationFromCache(
    {
      fingerprint: 'fp-model-change',
      pageNumber: 1,
      sourceHash: 'c'.repeat(64),
      paragraphs: ['旧模型译文'],
      targetLanguage: '简体中文',
      provider: 'provider',
      model: 'old-model',
      updatedAt: '2026-09-11T01:00:00.000Z',
    },
    'document',
  );
  const newEntry = {
    key: '',
    fingerprint: oldRecord.fingerprint,
    pageNumber: oldRecord.pageNumber,
    sourceHash: oldRecord.sourceHash,
    paragraphs: ['重新翻译后的译文'],
    targetLanguage: oldRecord.targetLanguage,
    provider: oldRecord.provider,
    model: 'new-model',
    updatedAt: '2026-09-11T02:00:00.000Z',
  } satisfies CachedTranslation;
  const records = upsertSharedTranslation([oldRecord], newEntry, 'document');
  assert.equal(records.length, 2);
  assert.equal(records[0]?.model, 'new-model');
  assert.equal(records[1]?.model, 'old-model');
  assert.deepEqual(records[0]?.paragraphs, ['重新翻译后的译文']);

  const repeated = upsertSharedTranslation(records, newEntry, 'document');
  assert.equal(repeated.length, 2);
  assert.equal(repeated[0]?.model, 'new-model');
});

void test('bypassCache forces a fresh provider call and overwrites the cache', async () => {
  const cache = createTranslationCache(createMemoryStore<CachedTranslation>());
  let call = 0;
  const provider = {
    id: 'mock',
    model: 'demo',
    async translate(request: TranslationRequest) {
      call += 1;
      return createMockTranslationProvider().translate(request);
    },
  };
  const fingerprint = 'fp';
  const request = {
    text: 'One.',
    sourceLanguage: 'auto',
    targetLanguage: '简体中文',
    pageNumber: 1,
  };

  await resolvePageTranslation({ provider, cache, fingerprint, request });
  const bypassed = await resolvePageTranslation({
    provider,
    cache,
    fingerprint,
    request,
    bypassCache: true,
  });
  assert.equal(bypassed.status, 'complete');
  assert.equal(call, 2);

  // the fresh result replaced the old cache entry
  const after = await resolvePageTranslation({
    provider,
    cache,
    fingerprint,
    request,
  });
  assert.equal(after.status, 'cached');
  assert.equal(call, 2);
});

void test('page translation retries transient provider failures before caching', async () => {
  const cache = createTranslationCache(createMemoryStore<CachedTranslation>());
  let calls = 0;
  const provider = {
    id: 'retry-provider',
    model: 'retry-model',
    async translate() {
      calls += 1;
      if (calls < 3) throw new TranslationError('server', 'temporary');
      return {
        paragraphs: ['完成'],
        provider: 'retry-provider',
        model: 'retry-model',
      };
    },
  };
  const result = await resolvePageTranslation({
    provider,
    cache,
    fingerprint: 'fp-retry',
    request: {
      text: 'Retry this page.',
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      pageNumber: 1,
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(calls, 3);
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
  saveReaderSettings(
    updateReaderApiKey(
      { ...DEFAULT_SETTINGS, providerMode: 'openai-compatible' },
      'sk-test',
    ),
    storage,
  );
  assert.equal(loadReaderSettings(storage).apiKey, 'sk-test');

  backing.set('pdf-reader-settings', '{not json');
  assert.deepEqual(loadReaderSettings(storage), DEFAULT_SETTINGS);
});

void test('remote provider is only active with a configured key', () => {
  assert.equal(usingRemoteProvider(DEFAULT_SETTINGS), false);
  assert.equal(
    usingRemoteProvider({
      ...DEFAULT_SETTINGS,
      providerMode: 'openai-compatible',
    }),
    false,
  );
  assert.equal(
    usingRemoteProvider({
      ...DEFAULT_SETTINGS,
      providerMode: 'openai-compatible',
      apiKey: 'sk-test',
    }),
    true,
  );
});

void test('recommended presets select current non-thinking translation models', () => {
  assert.equal(DEFAULT_SETTINGS.model, 'glm-4.7-flashx');
  const glmFast = applyTranslationPreset(DEFAULT_SETTINGS, 'glmFast');
  assert.equal(glmFast.model, 'glm-4.7-flashx');
  assert.equal(glmFast.disableThinking, true);
  const deepseek = applyTranslationPreset(DEFAULT_SETTINGS, 'deepseek');
  assert.equal(deepseek.model, 'deepseek-v4-flash');
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com');
});

void test('recommended presets retain independent API keys', () => {
  let settings = applyTranslationPreset(DEFAULT_SETTINGS, 'glmFast');
  settings = updateReaderApiKey(settings, 'glm-fast-key');
  settings = applyTranslationPreset(settings, 'deepseek');
  assert.equal(settings.apiKey, '');
  settings = updateReaderApiKey(settings, 'deepseek-key');

  settings = applyTranslationPreset(settings, 'glmFast');
  assert.equal(settings.apiKey, 'glm-fast-key');
  settings = applyTranslationPreset(settings, 'deepseek');
  assert.equal(settings.apiKey, 'deepseek-key');
});

void test('legacy settings migrate their API key to the active preset only', () => {
  const storage = {
    getItem: () =>
      JSON.stringify({
        providerMode: 'openai-compatible',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'legacy-fast-key',
        model: 'glm-4.7-flashx',
        disableThinking: true,
      }),
    setItem: () => {},
  } satisfies Pick<Storage, 'getItem' | 'setItem'>;

  let settings = loadReaderSettings(storage);
  settings = applyTranslationPreset(settings, 'deepseek');
  assert.equal(settings.apiKey, '');
  settings = applyTranslationPreset(settings, 'glmFast');
  assert.equal(settings.apiKey, 'legacy-fast-key');
});

void test('reader settings validate URLs, keys, and model names safely', () => {
  assert.equal(
    readerServiceHost('https://api.deepseek.com'),
    'api.deepseek.com',
  );
  assert.equal(readerServiceHost('not a url'), null);
  assert.match(
    validateReaderSettings({
      ...DEFAULT_SETTINGS,
      providerMode: 'openai-compatible',
    }) ?? '',
    /API Key/,
  );
  assert.match(
    validateReaderSettings({
      ...DEFAULT_SETTINGS,
      providerMode: 'openai-compatible',
      baseUrl: 'invalid',
      apiKey: 'key',
    }) ?? '',
    /接口地址/,
  );
  assert.equal(
    validateReaderSettings({
      ...DEFAULT_SETTINGS,
      providerMode: 'openai-compatible',
      apiKey: 'key',
    }),
    null,
  );
});

void test('old or malformed local cache entries are readable but cannot masquerade as current output', async () => {
  const store = createMemoryStore<CachedTranslation>();
  const cache = createTranslationCache(store);
  const parts = {fingerprint:'legacy', pageNumber:1,sourceHash:'hash',targetLanguage:'zh',provider:'mock',model:'demo'};
  const key = `legacy:1:hash:zh:mock:demo:v${PROMPT_VERSION}`;
  const entry = {...parts,key,paragraphs:['$x^2$ ℃ Ω'],updatedAt:'2026-09-26'};
  for (const version of [undefined, PROMPT_VERSION - 1]) {
    await store.set(key, {...entry,promptVersion:version});
    assert.equal(await cache.lookup(parts), undefined);
    assert.equal(await findCachedPageTranslation({cache,...parts}), undefined);
    assert.equal((await cache.list()).length, 1);
  }
  await store.set(key, {...entry,paragraphs:[null] as unknown as string[]});
  assert.deepEqual(await cache.list(), []);
  assert.equal(await cache.lookup(parts), undefined);
});

void test('protected scientific output round trips through cache; corrupt model output is never saved', async () => {
  const cache = createTranslationCache(createMemoryStore<CachedTranslation>());
  const request = {text:'$x^2$ H_2O α β γ θ μ Ω ≈ ≤ ≥ ± × ÷ → ∑ ∫ ∂ m/s² N·m ℃ - – —',sourceLanguage:'auto',targetLanguage:'zh',pageNumber:1};
  let corrupt = false;
  let calls = 0;
  const provider = createOpenAICompatibleProvider({baseUrl:'https://mock.test',apiKey:'test',model:'mock',
    fetchImpl:(async (_url, init) => {
      calls++;
      const text = JSON.parse(init?.body as string).messages[1].content.split('\n---\n')[1];
      const event = JSON.stringify({choices:[{delta:{content:corrupt ? 'lost math' : text},finish_reason:'stop'}]});
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`);
    }) as typeof fetch});
  const input = {cache,request,provider,fingerprint:'scientific'};
  const first = await resolvePageTranslation(input);
  const second = await resolvePageTranslation(input);
  assert.deepEqual(first.result.paragraphs, [request.text]);
  assert.deepEqual(second.result.paragraphs, first.result.paragraphs);
  assert.equal(second.status, 'cached');
  assert.equal(calls, 1);
  corrupt = true;
  await assert.rejects(resolvePageTranslation({...input,bypassCache:true}), /校验失败/);
  assert.equal(calls, 3);
  assert.deepEqual((await cache.list())[0].paragraphs, [request.text]);
});

void test('v6 cache remains listable while v7 batched translations use the unchanged versioned key format', async () => {
  const store = createMemoryStore<CachedTranslation>();
  const cache = createTranslationCache(store);
  const request = { text: 'One.\n\nTwo.', sourceLanguage: 'auto', targetLanguage: 'zh', pageNumber: 1 };
  const sourceHash = await sha256Hex(request.text);
  const oldKey = `batch-legacy:1:${sourceHash}:zh:mock:demo:v6`;
  await store.set(oldKey, { key: oldKey, fingerprint: 'batch-legacy', pageNumber: 1, sourceHash,
    targetLanguage: 'zh', provider: 'mock', model: 'demo', promptVersion: 6, paragraphs: ['旧译文'], updatedAt: '2026-09-26' });
  const input = { cache, request, fingerprint: 'batch-legacy', provider: createMockTranslationProvider() };
  const result = await resolvePageTranslation(input);
  assert.equal(result.status, 'complete');
  assert.equal(result.cacheEntry.promptVersion, 7);
  assert.equal((await resolvePageTranslation(input)).status, 'cached');
  assert.equal((await cache.list()).length, 2);
  assert.deepEqual((await store.get(oldKey))?.paragraphs, ['旧译文']);
});

void test('cancellation after provider completion does not save a page cache', async () => {
  const cache = createTranslationCache(createMemoryStore<CachedTranslation>());
  const controller = new AbortController();
  const provider = { id: 'mock', model: 'cancelled', async translate() {
    controller.abort();
    return { paragraphs: ['late'], provider: 'mock', model: 'cancelled' };
  } };
  await assert.rejects(resolvePageTranslation({ provider, cache, fingerprint: 'cancelled', signal: controller.signal,
    request: { text: 'One.\n\nTwo.', sourceLanguage: 'auto', targetLanguage: 'zh', pageNumber: 1 } }), { name: 'AbortError' });
  assert.deepEqual(await cache.list(), []);
});
