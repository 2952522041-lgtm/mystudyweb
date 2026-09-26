import { validateServiceBaseUrl } from './service-settings.ts';
import { sha256Hex } from './pdf-text.ts';
import {
  cachedTranslationFromShared,
  type SharedTranslationRecord,
} from './shared-translation.ts';
import {
  createMockTranslationProvider,
  createOpenAICompatibleProvider,
  PROMPT_VERSION,
  translateWithRetry,
  translationCacheKey,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResult,
} from './translation.ts';

export interface KVStore<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export function createMemoryStore<V>(): KVStore<V> {
  const map = new Map<string, V>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
  };
}

/** Browser-only IndexedDB-backed store; used for translations and progress. */
export function createIndexedDBStore<V>(
  databaseName: string,
  storeName: string,
): KVStore<V> {
  const openDatabase = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB open failed'));
    });

  const withStore = async <T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const database = await openDatabase();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error('IndexedDB request failed'));
      });
    } finally {
      database.close();
    }
  };

  return {
    async get(key) {
      return withStore<V | undefined>(
        'readonly',
        (store) => store.get(key) as IDBRequest<V | undefined>,
      );
    },
    async set(key, value) {
      await withStore(
        'readwrite',
        (store) => store.put(value, key) as IDBRequest<unknown>,
      );
    },
    async delete(key) {
      await withStore(
        'readwrite',
        (store) => store.delete(key) as unknown as IDBRequest<unknown>,
      );
    },
    async keys() {
      const keys = await withStore<IDBValidKey[]>('readonly', (store) =>
        store.getAllKeys(),
      );
      return keys.map(String);
    },
  };
}

export interface CachedTranslation {
  key: string;
  fingerprint: string;
  pageNumber: number;
  sourceHash: string;
  paragraphs: string[];
  targetLanguage: string;
  provider: string;
  model: string;
  updatedAt: string;
  /** Added after the original IndexedDB format; old records default to v4. */
  promptVersion?: number;
}

export interface TranslationCache {
  lookup(parts: {
    fingerprint: string;
    pageNumber: number;
    sourceHash: string;
    targetLanguage: string;
    provider: string;
    model: string;
  }): Promise<CachedTranslation | undefined>;
  save(input: CachedTranslation): Promise<void>;
  list(): Promise<CachedTranslation[]>;
}

/**
 * Finds an exact reader cache entry without requiring page text extraction.
 * The PDF fingerprint fixes the source document, so this also works for
 * scanned pages where extracting text would otherwise require OCR.
 */
export async function findCachedPageTranslation(input: {
  cache: TranslationCache;
  fingerprint: string;
  pageNumber: number;
  targetLanguage: string;
  provider: string;
  model: string;
}): Promise<CachedTranslation | undefined> {
  const entries = await input.cache.list();
  return entries
    .filter(
      (entry) =>
        entry.fingerprint === input.fingerprint &&
        entry.pageNumber === input.pageNumber &&
        entry.targetLanguage === input.targetLanguage &&
        entry.provider === input.provider &&
        entry.model === input.model &&
        entry.promptVersion === PROMPT_VERSION,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function isCachedTranslation(value: unknown): value is CachedTranslation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CachedTranslation>;
  return (
    typeof candidate.key === 'string' &&
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.pageNumber === 'number' &&
    typeof candidate.sourceHash === 'string' &&
    Array.isArray(candidate.paragraphs) &&
    candidate.paragraphs.every((paragraph) => typeof paragraph === 'string') &&
    typeof candidate.targetLanguage === 'string' &&
    typeof candidate.provider === 'string' &&
    typeof candidate.model === 'string' &&
    typeof candidate.updatedAt === 'string'
  );
}

/**
 * The IndexedDB storage key includes provider, model, and prompt version, so
 * exact local hits remain settings-specific. Published course records are a
 * separate fallback and are intentionally allowed to survive model changes.
 * Failed pages are never persisted, so a temporary fault cannot stick.
 */
export function createTranslationCache(
  store: KVStore<CachedTranslation>,
): TranslationCache {
  const storageKey = (parts: {
    fingerprint: string;
    pageNumber: number;
    sourceHash: string;
    targetLanguage: string;
    provider: string;
    model: string;
  }) =>
    `${parts.fingerprint}:${parts.pageNumber}:${parts.sourceHash}:${parts.targetLanguage}:${parts.provider}:${parts.model}:v${PROMPT_VERSION}`;

  return {
    async lookup(parts) {
      const entry = await store.get(storageKey(parts));
      return isCachedTranslation(entry) && entry.promptVersion === PROMPT_VERSION ? entry : undefined;
    },
    async save(input) {
      const key = storageKey(input);
      await store.set(key, { ...input, promptVersion: input.promptVersion ?? PROMPT_VERSION, key });
    },
    async list() {
      const values = await Promise.all(
        (await store.keys()).map((key) => store.get(key)),
      );
      return values.filter(isCachedTranslation);
    },
  };
}

export interface DocumentProgress {
  fingerprint: string;
  fileName: string;
  pageCount: number;
  lastPage: number;
  zoom: number;
  targetLanguage: string;
  updatedAt: string;
}

export function createProgressStore(store: KVStore<DocumentProgress>) {
  return {
    async load(fingerprint: string): Promise<DocumentProgress | undefined> {
      return store.get(`progress:${fingerprint}`);
    },
    async save(progress: DocumentProgress): Promise<void> {
      await store.set(`progress:${progress.fingerprint}`, progress);
    },
  };
}

export function computeFileFingerprint(buffer: ArrayBuffer): Promise<string> {
  return sha256Hex(buffer);
}

export function createReaderService(options?: {
  cacheStore?: KVStore<CachedTranslation>;
  progressStore?: KVStore<DocumentProgress>;
}) {
  const cache = createTranslationCache(
    options?.cacheStore ?? createIndexedDBStore('pdf-reader', 'kv'),
  );
  const progress = createProgressStore(
    options?.progressStore ?? createIndexedDBStore('pdf-reader', 'kv'),
  );
  return { cache, progress };
}

export interface PageTranslationOutcome {
  status: 'cached' | 'complete';
  source: 'indexeddb' | 'course' | 'generated';
  result: TranslationResult;
  cacheEntry: CachedTranslation;
}

/**
 * Resolves one page: cache first, then a single provider call whose result is
 * written to cache. If the exact IndexedDB key misses, a validated course
 * directory record for the same document/page/language is used before any
 * provider call. Callers handle provider errors and cancellation. A
 * caller-requested retranslation passes bypassCache to ignore both caches.
 */
export async function resolvePageTranslation(input: {
  provider: TranslationProvider;
  cache: TranslationCache;
  fingerprint: string;
  request: TranslationRequest;
  signal?: AbortSignal;
  bypassCache?: boolean;
  publishedTranslations?: SharedTranslationRecord[];
  onPartial?: (paragraphs: string[]) => void;
}): Promise<PageTranslationOutcome> {
  const {
    provider,
    cache,
    fingerprint,
    request,
    signal,
    bypassCache,
    publishedTranslations,
    onPartial,
  } = input;
  const sourceHash = await sha256Hex(request.text);
  if (!bypassCache) {
    const hit = await cache.lookup({
      fingerprint,
      pageNumber: request.pageNumber,
      sourceHash,
      targetLanguage: request.targetLanguage,
      provider: provider.id,
      model: provider.model,
    });
    if (hit) {
      return {
        status: 'cached',
        source: 'indexeddb',
        result: {
          paragraphs: hit.paragraphs,
          provider: hit.provider,
          model: hit.model,
        },
        cacheEntry: hit,
      };
    }
  }

  if (!bypassCache) {
    const published = publishedTranslations
      ?.filter(
        (record) =>
          record.fingerprint === fingerprint &&
          record.pageNumber === request.pageNumber &&
          record.targetLanguage === request.targetLanguage &&
          record.sourceHash === sourceHash &&
          record.promptVersion === PROMPT_VERSION,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (published) {
      const cacheEntry = cachedTranslationFromShared(published);
      return {
        status: 'cached',
        source: 'course',
        result: {
          paragraphs: cacheEntry.paragraphs,
          provider: cacheEntry.provider,
          model: cacheEntry.model,
        },
        cacheEntry,
      };
    }
  }

  const result = await translateWithRetry(provider, request, {
    signal,
    onPartial,
  });
  signal?.throwIfAborted();
  const cacheEntry: CachedTranslation = {
    key: translationCacheKey({
      sourceHash,
      targetLanguage: request.targetLanguage,
      provider: result.provider,
      model: result.model,
      promptVersion: PROMPT_VERSION,
    }),
    fingerprint,
    pageNumber: request.pageNumber,
    sourceHash,
    paragraphs: result.paragraphs,
    targetLanguage: request.targetLanguage,
    provider: result.provider,
    model: result.model,
    updatedAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
  };
  await cache.save(cacheEntry);
  return { status: 'complete', source: 'generated', result, cacheEntry };
}

export interface ReaderSettings {
  providerMode: 'mock' | 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  apiKeys: Partial<Record<ReaderApiKeyProfileId, string>>;
  model: string;
  disableThinking: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  providerMode: 'mock',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  apiKeys: {},
  model: 'glm-4.7-flashx',
  disableThinking: true,
};

export const TRANSLATION_PRESETS = {
  glmFast: {
    label: '智谱 · 稳定极速',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flashx',
  },
  deepseek: {
    label: 'DeepSeek · 高性价比',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
} as const;

export type TranslationPresetId = keyof typeof TRANSLATION_PRESETS;
export type ReaderApiKeyProfileId = TranslationPresetId | 'custom';

export function readerApiKeyProfileId(
  settings: Pick<ReaderSettings, 'baseUrl' | 'model'>,
): ReaderApiKeyProfileId {
  const baseUrl = settings.baseUrl.replace(/\/$/, '');
  const match = (
    Object.entries(TRANSLATION_PRESETS) as Array<
      [TranslationPresetId, (typeof TRANSLATION_PRESETS)[TranslationPresetId]]
    >
  ).find(
    ([, preset]) =>
      preset.baseUrl.replace(/\/$/, '') === baseUrl &&
      preset.model === settings.model,
  );
  return match?.[0] ?? 'custom';
}

export function updateReaderApiKey(
  settings: ReaderSettings,
  apiKey: string,
): ReaderSettings {
  const profileId = readerApiKeyProfileId(settings);
  return {
    ...settings,
    apiKey,
    apiKeys: { ...settings.apiKeys, [profileId]: apiKey },
  };
}

export function applyTranslationPreset(
  settings: ReaderSettings,
  presetId: TranslationPresetId,
): ReaderSettings {
  const preset = TRANSLATION_PRESETS[presetId];
  const currentProfileId = readerApiKeyProfileId(settings);
  const apiKeys = { ...settings.apiKeys, [currentProfileId]: settings.apiKey };
  return {
    ...settings,
    providerMode: 'openai-compatible',
    baseUrl: preset.baseUrl,
    apiKey: apiKeys[presetId] ?? '',
    apiKeys,
    model: preset.model,
    disableThinking: true,
  };
}

export function readerServiceHost(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.host
      : null;
  } catch {
    return null;
  }
}

export function validateReaderSettings(
  settings: ReaderSettings,
): string | null {
  if (settings.providerMode === 'mock') return null;
  const addressError = validateServiceBaseUrl(settings.baseUrl);
  if (addressError) return addressError;
  if (settings.apiKey.trim().length === 0) return '请输入 API Key。';
  if (settings.model.trim().length === 0) return '请输入模型名称。';
  return null;
}

const SETTINGS_STORAGE_KEY = 'pdf-reader-settings';

export function loadReaderSettings(
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): ReaderSettings {
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    const settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...parsed.apiKeys },
    };
    if (parsed.apiKeys === undefined && settings.apiKey.length > 0) {
      settings.apiKeys = { [readerApiKeyProfileId(settings)]: settings.apiKey };
    }
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveReaderSettings(
  settings: ReaderSettings,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): void {
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function createProviderForSettings(
  settings: ReaderSettings,
): TranslationProvider {
  if (
    settings.providerMode === 'openai-compatible' &&
    settings.apiKey.trim().length > 0
  ) {
    return createOpenAICompatibleProvider({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey.trim(),
      model: settings.model,
      disableThinking: settings.disableThinking,
    });
  }
  return createMockTranslationProvider();
}

export function usingRemoteProvider(settings: ReaderSettings): boolean {
  return (
    settings.providerMode === 'openai-compatible' &&
    settings.apiKey.trim().length > 0
  );
}
