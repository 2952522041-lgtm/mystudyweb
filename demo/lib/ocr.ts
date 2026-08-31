import {
  createChatProviderForSettings,
  type ChatSettings,
} from './chat-cache.ts';
import type { PageImageInput } from './chat.ts';
import { createIndexedDBStore, type KVStore } from './reader-cache.ts';

export const OCR_PROMPT_VERSION = 1;
export const OCR_MIN_TEXT_LENGTH = 24;

export interface OcrRequest {
  fingerprint: string;
  pageNumber: number;
  pageImage: PageImageInput;
}

export interface OcrResult {
  text: string;
  provider: string;
  model: string;
}

export interface OcrProvider {
  id: string;
  model: string;
  recognize(request: OcrRequest, signal?: AbortSignal): Promise<OcrResult>;
}

export interface CachedOcr extends OcrResult {
  fingerprint: string;
  pageNumber: number;
  promptVersion: number;
  updatedAt: string;
}

export interface OcrCache {
  lookup(parts: {
    fingerprint: string;
    pageNumber: number;
    provider: string;
    model: string;
  }): Promise<CachedOcr | undefined>;
  save(value: CachedOcr): Promise<void>;
}

const OCR_INSTRUCTION = [
  'Perform OCR on the attached PDF page image.',
  'Transcribe every readable printed or handwritten line in natural reading order.',
  'Preserve the original language, headings, lists, labels, numbers, and table structure.',
  'Write mathematical expressions as LaTeX using $...$ or $$...$$.',
  'Do not translate, summarize, explain, solve, or correct the document.',
  'For an unreadable fragment, write [无法辨认].',
  'Return only the transcription without a preface or code fence.',
].join('\n');

function cacheKey(parts: {
  fingerprint: string;
  pageNumber: number;
  provider: string;
  model: string;
}): string {
  return [
    'ocr',
    parts.fingerprint,
    parts.pageNumber,
    encodeURIComponent(parts.provider),
    encodeURIComponent(parts.model),
    `v${OCR_PROMPT_VERSION}`,
  ].join(':');
}

export function pageNeedsOcr(text: string): boolean {
  return text.replace(/\s+/g, '').length < OCR_MIN_TEXT_LENGTH;
}

export function normalizeOcrText(text: string): string {
  return text
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^(?:OCR\s*(?:结果|transcription)|识别结果)\s*[:：]\s*/i, '')
    .trim();
}

export function createOcrCache(store: KVStore<CachedOcr>): OcrCache {
  return {
    lookup(parts) {
      return store.get(cacheKey(parts));
    },
    save(value) {
      return store.set(cacheKey(value), value);
    },
  };
}

export function createOcrService(store?: KVStore<CachedOcr>): OcrCache {
  return createOcrCache(
    store ?? createIndexedDBStore<CachedOcr>('pdf-reader', 'kv'),
  );
}

export function createOcrProviderForSettings(
  settings: ChatSettings,
  fetchImpl?: typeof fetch,
): OcrProvider {
  const chatProvider = createChatProviderForSettings(settings, fetchImpl);
  const serviceId = settings.baseUrl.trim().replace(/\/$/, '');
  return {
    id: `openai-compatible-vision:${serviceId}`,
    model: chatProvider.model,
    async recognize(request, signal) {
      const result = await chatProvider.answer(
        {
          fingerprint: request.fingerprint,
          pageNumber: request.pageNumber,
          pageText: '',
          pageImage: request.pageImage,
          messages: [],
          question: OCR_INSTRUCTION,
        },
        { signal },
      );
      const text = normalizeOcrText(result.content);
      if (!text) throw new Error('视觉模型没有返回可用的 OCR 文字。');
      return {
        text,
        provider: `openai-compatible-vision:${serviceId}`,
        model: result.model,
      };
    },
  };
}

export async function resolvePageOcr(input: {
  provider: OcrProvider;
  cache: OcrCache;
  request: OcrRequest;
  signal?: AbortSignal;
  bypassCache?: boolean;
}): Promise<{ status: 'cached' | 'complete'; result: OcrResult }> {
  const { provider, cache, request, signal, bypassCache } = input;
  if (!bypassCache) {
    const hit = await cache.lookup({
      fingerprint: request.fingerprint,
      pageNumber: request.pageNumber,
      provider: provider.id,
      model: provider.model,
    });
    if (hit) return { status: 'cached', result: hit };
  }

  const result = await provider.recognize(request, signal);
  await cache.save({
    ...result,
    fingerprint: request.fingerprint,
    pageNumber: request.pageNumber,
    promptVersion: OCR_PROMPT_VERSION,
    updatedAt: new Date().toISOString(),
  });
  return { status: 'complete', result };
}
