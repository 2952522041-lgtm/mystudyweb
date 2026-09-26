import type { CachedTranslation } from './reader-cache.ts';
import { sha256Hex } from './pdf-text.ts';
import { PROMPT_VERSION } from './translation.ts';
import type { CourseStorage } from './course-storage/types.ts';

export const SHARED_TRANSLATION_SCHEMA_VERSION = 1 as const;
export const SHARED_TRANSLATION_MAX_BYTES = 512 * 1024;
const MAX_PARAGRAPHS = 200;
const MAX_PARAGRAPH_LENGTH = 20_000;
const MAX_TOTAL_TEXT_LENGTH = 200_000;
const MAX_DOCUMENT_ID_LENGTH = 256;
const MAX_FINGERPRINT_LENGTH = 256;
const MAX_HASH_LENGTH = 128;
const MAX_LANGUAGE_LENGTH = 128;
const MAX_PROVIDER_LENGTH = 128;
const MAX_MODEL_LENGTH = 256;

export interface SharedTranslationRecord {
  schemaVersion: typeof SHARED_TRANSLATION_SCHEMA_VERSION;
  documentId: string;
  fingerprint: string;
  pageNumber: number;
  sourceHash: string;
  targetLanguage: string;
  provider: string;
  model: string;
  promptVersion: number;
  glossaryFingerprint?: string;
  paragraphs: string[];
  updatedAt: string;
}

export type SharedTranslationInput = Omit<
  SharedTranslationRecord,
  'schemaVersion'
>;

const HASH_PATTERN = /^[a-f0-9]{64}$/i;

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum
  );
}

/**
 * The published format is deliberately a closed, presentation-only schema.
 * Unknown fields are rejected so source text, OCR payloads, credentials, and
 * chat metadata cannot accidentally become part of the LAN-facing contract.
 */
export function validateSharedTranslation(
  value: unknown,
  expected?: { documentId?: string; fingerprint?: string; pageCount?: number },
): SharedTranslationRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion',
    'documentId',
    'fingerprint',
    'pageNumber',
    'sourceHash',
    'targetLanguage',
    'provider',
    'model',
    'promptVersion',
    'glossaryFingerprint',
    'paragraphs',
    'updatedAt',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (
    (record.glossaryFingerprint !== undefined && record.glossaryFingerprint !== '' &&
      (typeof record.glossaryFingerprint !== 'string' || !HASH_PATTERN.test(record.glossaryFingerprint))) ||
    record.schemaVersion !== SHARED_TRANSLATION_SCHEMA_VERSION ||
    !boundedString(record.documentId, MAX_DOCUMENT_ID_LENGTH) ||
    !boundedString(record.fingerprint, MAX_FINGERPRINT_LENGTH) ||
    !boundedString(record.sourceHash, MAX_HASH_LENGTH) ||
    !HASH_PATTERN.test(record.sourceHash) ||
    !boundedString(record.targetLanguage, MAX_LANGUAGE_LENGTH) ||
    !boundedString(record.provider, MAX_PROVIDER_LENGTH) ||
    !boundedString(record.model, MAX_MODEL_LENGTH) ||
    typeof record.pageNumber !== 'number' ||
    !Number.isInteger(record.pageNumber) ||
    record.pageNumber < 1 ||
    (expected?.pageCount !== undefined &&
      record.pageNumber > expected.pageCount) ||
    typeof record.promptVersion !== 'number' ||
    !Number.isInteger(record.promptVersion) ||
    record.promptVersion < 1 ||
    record.promptVersion > 10_000 ||
    !Array.isArray(record.paragraphs) ||
    record.paragraphs.length === 0 ||
    record.paragraphs.length > MAX_PARAGRAPHS ||
    !boundedString(record.updatedAt, 64) ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    return null;
  }
  if (
    expected?.documentId !== undefined &&
    record.documentId !== expected.documentId
  ) {
    return null;
  }
  if (
    expected?.fingerprint !== undefined &&
    record.fingerprint !== expected.fingerprint
  ) {
    return null;
  }
  let totalLength = 0;
  for (const paragraph of record.paragraphs) {
    if (!boundedString(paragraph, MAX_PARAGRAPH_LENGTH)) return null;
    totalLength += paragraph.length;
    if (totalLength > MAX_TOTAL_TEXT_LENGTH) return null;
  }
  return {
    schemaVersion: SHARED_TRANSLATION_SCHEMA_VERSION,
    documentId: record.documentId,
    fingerprint: record.fingerprint,
    pageNumber: record.pageNumber,
    sourceHash: record.sourceHash,
    targetLanguage: record.targetLanguage,
    provider: record.provider,
    model: record.model,
    promptVersion: record.promptVersion,
    ...(record.glossaryFingerprint ? { glossaryFingerprint: record.glossaryFingerprint as string } : {}),
    paragraphs: [...record.paragraphs],
    updatedAt: record.updatedAt,
  };
}

export function sharedTranslationFromCache(
  cached: Pick<
    CachedTranslation,
    | 'fingerprint'
    | 'pageNumber'
    | 'sourceHash'
    | 'paragraphs'
    | 'targetLanguage'
    | 'provider'
    | 'model'
    | 'updatedAt'
  > & { promptVersion?: number; glossaryFingerprint?: string },
  documentId: string,
): SharedTranslationRecord {
  return {
    schemaVersion: SHARED_TRANSLATION_SCHEMA_VERSION,
    documentId,
    fingerprint: cached.fingerprint,
    pageNumber: cached.pageNumber,
    sourceHash: cached.sourceHash,
    targetLanguage: cached.targetLanguage,
    provider: cached.provider,
    model: cached.model,
    promptVersion: cached.promptVersion ?? PROMPT_VERSION,
    ...(cached.glossaryFingerprint ? { glossaryFingerprint: cached.glossaryFingerprint } : {}),
    paragraphs: [...cached.paragraphs],
    updatedAt: cached.updatedAt,
  };
}

/**
 * Picks the newest published record a reader may restore without re-extracting
 * the page. The prompt version is part of the match: after a prompt change,
 * records produced under the old prompt must not keep serving stale text.
 */
export function findRestorableSharedTranslation(
  records: SharedTranslationRecord[],
  criteria: {
    fingerprint: string;
    pageNumber: number;
    targetLanguage: string;
    promptVersion?: number;
    glossaryFingerprint?: string;
  },
): SharedTranslationRecord | undefined {
  const promptVersion = criteria.promptVersion ?? PROMPT_VERSION;
  return records
    .filter(
      (record) =>
        record.fingerprint === criteria.fingerprint &&
        record.pageNumber === criteria.pageNumber &&
        record.targetLanguage === criteria.targetLanguage &&
        record.promptVersion === promptVersion &&
        (record.glossaryFingerprint ?? '') === (criteria.glossaryFingerprint ?? ''),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** 将课程目录记录转换成阅读器可消费的缓存形状，但不写回 IndexedDB。 */
export function cachedTranslationFromShared(
  record: SharedTranslationRecord,
): CachedTranslation {
  return {
    key: '',
    fingerprint: record.fingerprint,
    pageNumber: record.pageNumber,
    sourceHash: record.sourceHash,
    paragraphs: [...record.paragraphs],
    targetLanguage: record.targetLanguage,
    provider: record.provider,
    model: record.model,
    updatedAt: record.updatedAt,
    promptVersion: record.promptVersion,
    ...(record.glossaryFingerprint ? { glossaryFingerprint: record.glossaryFingerprint as string } : {}),
  };
}

/** 将刚落盘的译文加入当前阅读会话，按完整配置身份幂等去重。 */
export function upsertSharedTranslation(
  records: SharedTranslationRecord[],
  cached: CachedTranslation,
  documentId: string,
): SharedTranslationRecord[] {
  const record = sharedTranslationFromCache(cached, documentId);
  const identity = sharedTranslationIdentity(record);
  return [
    record,
    ...records.filter(
      (existing) => sharedTranslationIdentity(existing) !== identity,
    ),
  ];
}

export function sharedTranslationIdentity(
  record: SharedTranslationRecord,
): string {
  return JSON.stringify([
    record.documentId,
    record.fingerprint,
    record.pageNumber,
    record.targetLanguage,
    record.sourceHash,
    record.provider,
    record.model,
    record.promptVersion,
    ...(record.glossaryFingerprint ? [record.glossaryFingerprint] : []),
  ]);
}

export async function sharedTranslationFileName(
  record: SharedTranslationRecord,
): Promise<string> {
  return `${await sha256Hex(sharedTranslationIdentity(record))}.json`;
}

export function encodeSharedTranslation(
  record: SharedTranslationRecord,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record, null, 2));
}

export async function publishCachedTranslation(
  storage: Pick<CourseStorage, 'publishTranslation'>,
  cached: CachedTranslation,
  documentId: string,
): Promise<boolean> {
  if (
    !storage.publishTranslation ||
    cached.provider === 'mock' ||
    cached.paragraphs.length === 0
  ) {
    return false;
  }
  await storage.publishTranslation(
    documentId,
    sharedTranslationFromCache(cached, documentId),
  );
  return true;
}

export interface TranslationPublicationResult {
  status: 'saved' | 'skipped' | 'failed';
  error?: string;
}

/**
 * Persists before the reader marks a translation ready. The caller keeps the
 * local cache result when this reports a failure, so closing the app after a
 * successful local translation never turns into data loss.
 */
export async function publishCachedTranslationForReader(
  storage: Pick<CourseStorage, 'publishTranslation'> | undefined,
  cached: CachedTranslation,
  documentId: string,
): Promise<TranslationPublicationResult> {
  if (!storage?.publishTranslation || cached.provider === 'mock') {
    return { status: 'skipped' };
  }
  try {
    await publishCachedTranslation(storage, cached, documentId);
    return { status: 'saved' };
  } catch (error) {
    return {
      status: 'failed',
      error:
        error instanceof Error
          ? error.message
          : '保存到课程目录失败，请检查课程文件夹后重试。',
    };
  }
}
