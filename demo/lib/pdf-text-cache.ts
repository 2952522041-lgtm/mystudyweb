import { createIndexedDBStore, type KVStore } from './reader-cache.ts';

export const PDF_TEXT_EXTRACTION_VERSION = 'pdf-text-v1';

export interface PdfTextCache {
  get(fingerprint: string, page: number): Promise<string | undefined>;
  set(fingerprint: string, page: number, text: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PdfTextCacheOptions {
  store?: KVStore<unknown>;
  maxBytes?: number;
  maxEntries?: number;
  now?: () => number;
}

interface PdfTextRecord {
  version: string;
  fingerprint: string;
  page: number;
  text: string;
  bytes: number;
  at: number;
}

interface AccountEntry {
  bytes: number;
  at: number;
}

interface StoreState {
  tail: Promise<unknown>;
  loaded: boolean;
  account: Map<string, AccountEntry>;
  totalBytes: number;
}

const KEY_PREFIX = 'pdf-text:';
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 2048;
const MAX_FINGERPRINT_LENGTH = 256;
const DEFAULT_STORE_LOCK_NAME = 'yeyu-pdf-text-cache:pages';

const encoder = new TextEncoder();
const storeStates = new WeakMap<object, StoreState>();

interface MinimalLockManager {
  request<R>(
    name: string,
    options: { mode: 'exclusive' | 'shared' },
    callback: () => Promise<R>,
  ): Promise<R>;
}

function defaultLockManager(): MinimalLockManager | undefined {
  const navigatorValue = (globalThis as { navigator?: unknown }).navigator;
  if (typeof navigatorValue !== 'object' || navigatorValue === null) {
    return undefined;
  }
  const locks = (navigatorValue as { locks?: unknown }).locks;
  if (typeof locks !== 'object' || locks === null) return undefined;
  if (typeof (locks as { request?: unknown }).request !== 'function') {
    return undefined;
  }
  return locks as MinimalLockManager;
}

/**
 * The default store is backed by a shared IndexedDB database, so independent
 * Electron windows must not enforce the byte/entry budget at the same time.
 * The lock name is fixed, so every window contends for the same lock. On a
 * lock failure the operation is abandoned rather than run unserialized.
 */
async function withDefaultStoreLock<T>(
  isDefaultStore: boolean,
  task: () => Promise<T>,
): Promise<T | undefined> {
  if (!isDefaultStore) return task();
  const locks = defaultLockManager();
  if (!locks) return task();
  try {
    return await locks.request(
      DEFAULT_STORE_LOCK_NAME,
      { mode: 'exclusive' },
      task,
    );
  } catch {
    return undefined;
  }
}

function stateFor(store: object): StoreState {
  let state = storeStates.get(store);
  if (!state) {
    state = {
      tail: Promise.resolve(),
      loaded: false,
      account: new Map(),
      totalBytes: 0,
    };
    storeStates.set(store, state);
  }
  return state;
}

function runExclusive<T>(store: object, task: () => Promise<T>): Promise<T> {
  const state = stateFor(store);
  const result = state.tail.then(task);
  state.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function storageKey(fingerprint: string, page: number): string {
  return `${KEY_PREFIX}${PDF_TEXT_EXTRACTION_VERSION}:${fingerprint}:${page}`;
}

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function assertFingerprint(fingerprint: string): void {
  if (
    typeof fingerprint !== 'string' ||
    fingerprint.length === 0 ||
    fingerprint.length > MAX_FINGERPRINT_LENGTH
  ) {
    throw new TypeError(
      `fingerprint must be a non-empty string of at most ${MAX_FINGERPRINT_LENGTH} characters`,
    );
  }
}

function assertPage(page: number): void {
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page <= 0) {
    throw new TypeError('page must be a positive safe integer');
  }
}

function assertLimit(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function parseRecord(value: unknown): PdfTextRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<PdfTextRecord>;
  if (record.version !== PDF_TEXT_EXTRACTION_VERSION) return null;
  if (
    typeof record.fingerprint !== 'string' ||
    record.fingerprint.length === 0 ||
    record.fingerprint.length > MAX_FINGERPRINT_LENGTH
  ) {
    return null;
  }
  if (
    typeof record.page !== 'number' ||
    !Number.isSafeInteger(record.page) ||
    record.page <= 0
  ) {
    return null;
  }
  if (typeof record.text !== 'string') return null;
  const at =
    typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0;
  return {
    version: PDF_TEXT_EXTRACTION_VERSION,
    fingerprint: record.fingerprint,
    page: record.page,
    text: record.text,
    bytes: utf8Length(record.text),
    at,
  };
}

function removeFromAccount(state: StoreState, key: string): void {
  const existing = state.account.get(key);
  if (!existing) return;
  state.account.delete(key);
  state.totalBytes -= existing.bytes;
}

/**
 * Rebuilds the whole accounting from the store and only swaps it in once the
 * scan completed. A failed read during the scan leaves the previous accounting
 * untouched but marks it unloaded, so partial data is never counted and no
 * entry is accumulated twice.
 */
async function scan(
  state: StoreState,
  store: KVStore<unknown>,
): Promise<boolean> {
  let keys: string[];
  try {
    keys = await store.keys();
  } catch {
    state.loaded = false;
    return false;
  }
  const records: Array<{ key: string; record: PdfTextRecord }> = [];
  for (const key of keys) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    let value: unknown;
    try {
      value = await store.get(key);
    } catch {
      state.loaded = false;
      return false;
    }
    const record = parseRecord(value);
    if (!record || storageKey(record.fingerprint, record.page) !== key) {
      try {
        await store.delete(key);
      } catch {
        state.loaded = false;
        return false;
      }
      continue;
    }
    records.push({ key, record });
  }
  records.sort((left, right) => left.record.at - right.record.at);
  const account = new Map<string, AccountEntry>();
  let totalBytes = 0;
  for (const entry of records) {
    account.set(entry.key, {
      bytes: entry.record.bytes,
      at: entry.record.at,
    });
    totalBytes += entry.record.bytes;
  }
  state.account = account;
  state.totalBytes = totalBytes;
  state.loaded = true;
  return true;
}

async function ensureAccounting(
  state: StoreState,
  store: KVStore<unknown>,
  force: boolean,
): Promise<boolean> {
  if (state.loaded && !force) return true;
  return scan(state, store);
}

export function createPdfTextCache(
  options?: PdfTextCacheOptions,
): PdfTextCache {
  assertLimit(options?.maxBytes, 'maxBytes');
  assertLimit(options?.maxEntries, 'maxEntries');
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const isDefaultStore = options?.store === undefined;
  const store =
    options?.store ??
    createIndexedDBStore<unknown>('yeyu-pdf-text-cache', 'pages');
  const now = options?.now ?? (() => Date.now());
  const state = stateFor(store);

  return {
    async get(fingerprint, page) {
      assertFingerprint(fingerprint);
      assertPage(page);
      return runExclusive(store, () =>
        withDefaultStoreLock(isDefaultStore, async () => {
          const key = storageKey(fingerprint, page);
          let value: unknown;
          try {
            value = await store.get(key);
          } catch {
            return undefined;
          }
          const record = parseRecord(value);
          if (
            !record ||
            record.fingerprint !== fingerprint ||
            record.page !== page
          ) {
            if (value !== undefined) {
              removeFromAccount(state, key);
              try {
                await store.delete(key);
              } catch {
                state.loaded = false;
              }
            }
            return undefined;
          }
          const at = now();
          if (state.loaded) {
            const previous = state.account.get(key);
            state.account.delete(key);
            state.account.set(key, { bytes: record.bytes, at });
            state.totalBytes += record.bytes - (previous?.bytes ?? 0);
          }
          try {
            await store.set(key, {
              version: PDF_TEXT_EXTRACTION_VERSION,
              fingerprint,
              page,
              text: record.text,
              bytes: record.bytes,
              at,
            });
          } catch {
            state.loaded = false;
          }
          return record.text;
        }),
      );
    },

    async set(fingerprint, page, text) {
      assertFingerprint(fingerprint);
      assertPage(page);
      if (typeof text !== 'string') {
        throw new TypeError('text must be a string');
      }
      await runExclusive(store, () =>
        withDefaultStoreLock(isDefaultStore, async () => {
          try {
            if (!(await ensureAccounting(state, store, isDefaultStore))) {
              return;
            }
            const key = storageKey(fingerprint, page);
            const bytes = utf8Length(text);
            const previous = state.account.get(key);

            if (bytes > maxBytes) {
              if (previous) {
                try {
                  await store.delete(key);
                } catch {
                  state.loaded = false;
                  return;
                }
                state.account.delete(key);
                state.totalBytes -= previous.bytes;
              }
              return;
            }

            state.account.delete(key);
            if (previous) state.totalBytes -= previous.bytes;

            while (
              state.account.size + 1 > maxEntries ||
              state.totalBytes + bytes > maxBytes
            ) {
              const victimKey = state.account.keys().next().value;
              if (victimKey === undefined) break;
              const victim = state.account.get(victimKey);
              try {
                await store.delete(victimKey);
              } catch {
                state.loaded = false;
                return;
              }
              state.account.delete(victimKey);
              if (victim) state.totalBytes -= victim.bytes;
            }

            const at = now();
            try {
              await store.set(key, {
                version: PDF_TEXT_EXTRACTION_VERSION,
                fingerprint,
                page,
                text,
                bytes,
                at,
              });
            } catch {
              state.loaded = false;
              return;
            }
            state.account.set(key, { bytes, at });
            state.totalBytes += bytes;
          } catch {
            state.loaded = false;
          }
        }),
      );
    },

    async clear() {
      await runExclusive(store, () =>
        withDefaultStoreLock(isDefaultStore, async () => {
          let failed = false;
          try {
            const keys = await store.keys();
            for (const key of keys) {
              if (!key.startsWith(KEY_PREFIX)) continue;
              try {
                await store.delete(key);
              } catch {
                failed = true;
                continue;
              }
              removeFromAccount(state, key);
            }
          } catch {
            state.loaded = false;
            return;
          }
          if (failed) {
            state.loaded = false;
            return;
          }
          state.account.clear();
          state.totalBytes = 0;
          state.loaded = true;
        }),
      );
    },
  };
}

export const pdfTextCache: PdfTextCache = createPdfTextCache();
