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
    'paragraphs',
    'updatedAt',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (
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
  > & { promptVersion?: number },
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
    paragraphs: [...cached.paragraphs],
    updatedAt: cached.updatedAt,
  };
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
