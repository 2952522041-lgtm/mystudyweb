import { sha256Hex } from './pdf-text.ts';
import {
  createMockTranslationProvider,
  createOpenAICompatibleProvider,
  PROMPT_VERSION,
  translationCacheKey,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResult,
} from './translation.ts';

export interface KVStore<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  delete(key: string): Promise<void>;
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
  };
}

/** Browser-only IndexedDB-backed store; used for translations and progress. */
export function createIndexedDBStore<V>(databaseName: string, storeName: string): KVStore<V> {
  const openDatabase = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
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
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      });
    } finally {
      database.close();
    }
  };

  return {
    async get(key) {
      return withStore<V | undefined>('readonly', (store) => store.get(key) as IDBRequest<V | undefined>);
    },
    async set(key, value) {
      await withStore('readwrite', (store) => store.put(value, key) as IDBRequest<unknown>);
    },
    async delete(key) {
      await withStore('readwrite', (store) => store.delete(key) as unknown as IDBRequest<unknown>);
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
}

/**
 * The storage key includes provider, model, and prompt version (per the
 * technical solution's cache-key rule), so switching any of them can never
 * surface translations produced under the previous settings. Failed pages are
 * never persisted, so a temporary fault cannot stick.
 */
export function createTranslationCache(store: KVStore<CachedTranslation>): TranslationCache {
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
      return store.get(storageKey(parts));
    },
    async save(input) {
      const key = storageKey(input);
      await store.set(key, { ...input, key });
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
  const cache = createTranslationCache(options?.cacheStore ?? createIndexedDBStore('pdf-reader', 'kv'));
  const progress = createProgressStore(options?.progressStore ?? createIndexedDBStore('pdf-reader', 'kv'));
  return { cache, progress };
}

export interface PageTranslationOutcome {
  status: 'cached' | 'complete';
  result: TranslationResult;
}

/**
 * Resolves one page: cache first, then a single provider call whose result is
 * written to cache. Callers handle provider errors and cancellation. A
 * caller-requested retranslation passes bypassCache to ignore an existing
 * cache entry and overwrite it with a fresh result.
 */
export async function resolvePageTranslation(input: {
  provider: TranslationProvider;
  cache: TranslationCache;
  fingerprint: string;
  request: TranslationRequest;
  signal?: AbortSignal;
  bypassCache?: boolean;
  onPartial?: (paragraphs: string[]) => void;
}): Promise<PageTranslationOutcome> {
  const { provider, cache, fingerprint, request, signal, bypassCache, onPartial } = input;
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
        result: {
          paragraphs: hit.paragraphs,
          provider: hit.provider,
          model: hit.model,
        },
      };
    }
  }

  const result = await provider.translate(request, { signal, onPartial });
  await cache.save({
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
  });
  return { status: 'complete', result };
}

export interface ReaderSettings {
  providerMode: 'mock' | 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  model: string;
  disableThinking: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  providerMode: 'mock',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  disableThinking: false,
};

const SETTINGS_STORAGE_KEY = 'pdf-reader-settings';

export function loadReaderSettings(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): ReaderSettings {
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<ReaderSettings>) };
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

export function createProviderForSettings(settings: ReaderSettings): TranslationProvider {
  if (settings.providerMode === 'openai-compatible' && settings.apiKey.trim().length > 0) {
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
  return settings.providerMode === 'openai-compatible' && settings.apiKey.trim().length > 0;
}
