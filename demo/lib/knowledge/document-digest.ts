import { loadPdfjs } from '../pdfjs.ts';
import { itemsFromPdfJs, normalizePage } from '../pdf-text.ts';
import { sha256Hex, stableDocumentId } from '../course-storage/file-utils.ts';
import { pageNeedsOcr } from '../ocr.ts';
import { renderPageImage } from '../page-vision.ts';
import { mapWithConcurrency } from '../async-pool.ts';
import { pdfTextCache, type PdfTextCache } from '../pdf-text-cache.ts';
import type { PageImageInput } from '../chat.ts';
import type {
  DigestConcept,
  DigestSection,
  DocumentDigest,
  SourceReference,
} from '../course-storage/types.ts';

const SENTENCE_BOUNDARY = /(?<=[。！？.!?])\s+/;

function cleanLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function summarize(text: string, length = 260): string {
  const sentences = cleanLine(text).split(SENTENCE_BOUNDARY).filter(Boolean);
  const selected: string[] = [];
  let size = 0;
  for (const sentence of sentences) {
    selected.push(sentence);
    size += sentence.length;
    if (size >= length || selected.length >= 3) break;
  }
  return selected.join(' ').slice(0, length) || '本页没有可提取的连续文字。';
}

function headingCandidates(text: string): string[] {
  return text
    .split('\n')
    .map(cleanLine)
    .filter(
      (line) =>
        line.length >= 3 &&
        line.length <= 70 &&
        !/^[\d\s.,;:()[\]{}-]+$/.test(line),
    )
    .slice(0, 5);
}

function normalizeConceptKey(label: string): string {
  return label
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 60);
}

export function createDocumentDigest(input: {
  fingerprint: string;
  fileName: string;
  pages: string[];
  now?: string;
}): DocumentDigest {
  const documentId = stableDocumentId(input.fingerprint);
  const updatedAt = input.now ?? new Date().toISOString();
  const sections: DigestSection[] = input.pages.map((text, index) => ({
    id: `${documentId}-section-${index + 1}`,
    title: headingCandidates(text)[0] ?? `第 ${index + 1} 页`,
    summary: summarize(text),
    pageStart: index + 1,
    pageEnd: index + 1,
  }));

  const seen = new Set<string>();
  const concepts: DigestConcept[] = [];
  for (let index = 0; index < input.pages.length; index += 1) {
    for (const heading of headingCandidates(input.pages[index])) {
      const key = normalizeConceptKey(heading);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const source: SourceReference = {
        documentId,
        fileName: input.fileName,
        pageStart: index + 1,
        type: 'pdf',
      };
      concepts.push({
        id: `${documentId}-concept-${concepts.length + 1}`,
        label: heading,
        description: sections[index].summary,
        sources: [source],
      });
      if (concepts.length >= 16) break;
    }
    if (concepts.length >= 16) break;
  }

  if (concepts.length === 0) {
    concepts.push({
      id: `${documentId}-concept-1`,
      label: input.fileName.replace(/\.pdf$/i, ''),
      description: sections[0]?.summary ?? '暂无可提取内容。',
      sources: [
        {
          documentId,
          fileName: input.fileName,
          pageStart: 1,
          type: 'pdf',
        },
      ],
    });
  }

  return {
    schemaVersion: 1,
    documentId,
    fingerprint: input.fingerprint,
    title: input.fileName.replace(/\.pdf$/i, ''),
    overview: summarize(input.pages.slice(0, 5).join(' '), 520),
    sections,
    concepts,
    relations: concepts.slice(1).map((concept, index) => ({
      from: concepts[index].id,
      to: concept.id,
      label: '关联',
    })),
    unresolvedQuestions: [],
    sourcePages: input.pages.map((_, index) => index + 1),
    promptVersion: 'local-structure-v1',
    updatedAt,
  };
}

export interface ExtractedPdfPages {
  fingerprint: string;
  fileName: string;
  pageCount: number;
  /** 1 起始页码的页面文字（已按需 OCR）。 */
  pages: string[];
}

/** Parse only the PDF container/page tree: no page extraction, rendering or AI. */
export async function inspectPdf(file: File, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('导入已取消。');
  const buffer = await file.arrayBuffer();
  const fingerprint = await sha256Hex(buffer);
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({data:new Uint8Array(buffer)});
  const cancel = () => { void task.destroy(); };
  signal?.addEventListener('abort', cancel, {once:true});
  try {
    if (signal?.aborted) throw new Error('导入已取消。');
    const pdf = await task.promise;
    if (signal?.aborted) throw new Error('导入已取消。');
    return {fingerprint, pageCount:pdf.numPages};
  } finally { signal?.removeEventListener('abort', cancel); await task.destroy(); }
}

// Two concurrent OCR requests keep the vision provider responsive while
// cutting the all-pages serial wait substantially for scanned documents.
const DEFAULT_PAGE_CONCURRENCY = 2;
const MAX_PAGE_CONCURRENCY = 2;
const PDF_EXTRACTION_CANCELLED = 'PDF 文字提取已取消。';

interface ExtractPdfPagesOptions {
  /** Local content search may index sparse/scanned PDFs without invoking OCR. */
  allowEmptyText?: boolean;
  textCache?: PdfTextCache;
  signal?: AbortSignal;
  onProgress?: (
    page: number,
    pageCount: number,
    stage: 'extracting' | 'ocr',
  ) => void;
  /** Maximum number of pages that may be extracted/OCR'd at once. */
  pageConcurrency?: number;
  recognizePage?: (input: {
    fingerprint: string;
    pageNumber: number;
    pageImage: PageImageInput;
    signal?: AbortSignal;
  }) => Promise<string>;
}

function validatePageConcurrency(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError('pageConcurrency must be a positive integer');
  }
  return Math.min(value, MAX_PAGE_CONCURRENCY);
}

function throwIfPageExtractionCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error(PDF_EXTRACTION_CANCELLED);
}

/** 用 PDF.js 提取每页文字；缺文字层的页面交给视觉模型 OCR。 */
export async function extractPdfPages(
  file: File,
  options: ExtractPdfPagesOptions = {},
): Promise<ExtractedPdfPages> {
  if (options.signal?.aborted) {
    throw new Error(PDF_EXTRACTION_CANCELLED);
  }
  const pageConcurrency = validatePageConcurrency(
    options.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY,
  );
  const buffer = await file.arrayBuffer();
  const fingerprint = await sha256Hex(buffer);
  if (options.signal?.aborted) {
    throw new Error(PDF_EXTRACTION_CANCELLED);
  }
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)) })
    .promise;

  // mapWithConcurrency intentionally returns the source order, while the
  // worker reports progress as individual pages finish. A private controller
  // lets us preserve the historical cancellation error instead of exposing
  // the browser's AbortError/DOMException from the caller's signal.
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error(PDF_EXTRACTION_CANCELLED));
  if (options.signal) {
    if (options.signal.aborted) cancel();
    else options.signal.addEventListener('abort', cancel, { once: true });
  }

  try {
    const pageNumbers = Array.from(
      { length: pdf.numPages },
      (_, index) => index + 1,
    );
    const pages = await mapWithConcurrency(
      pageNumbers,
      pageConcurrency,
      async (pageNumber, _index, signal) => {
        throwIfPageExtractionCancelled(signal);
        const cache = options.textCache ?? pdfTextCache;
        const cachedText = await cache.get(fingerprint,pageNumber);
        throwIfPageExtractionCancelled(signal);
        if (cachedText !== undefined && (!pageNeedsOcr(cachedText) || !options.recognizePage)) {
          options.onProgress?.(pageNumber,pdf.numPages,'extracting');
          return cachedText;
        }
        const page = await pdf.getPage(pageNumber);
        try {
          throwIfPageExtractionCancelled(signal);
          const viewport = page.getViewport({ scale: 1 });
          const content = cachedText === undefined ? await page.getTextContent() : null;
          throwIfPageExtractionCancelled(signal);
          let text = cachedText ?? normalizePage(
            itemsFromPdfJs(
              content!.items as Array<{
                str?: string;
                transform?: number[];
                width?: number;
                height?: number;
              }>,
              viewport.height,
            ),
          ).text;
          if (cachedText === undefined) await cache.set(fingerprint,pageNumber,text);
          throwIfPageExtractionCancelled(signal);
          if (pageNeedsOcr(text) && options.recognizePage) {
            options.onProgress?.(pageNumber, pdf.numPages, 'ocr');
            const pageImage = await renderPageImage(pdf, pageNumber, {
              signal,
              maxDimension: 2200,
              maxPixels: 4_000_000,
            });
            throwIfPageExtractionCancelled(signal);
            text = await options.recognizePage({
              fingerprint,
              pageNumber,
              pageImage,
              signal,
            });
            throwIfPageExtractionCancelled(signal);
          } else {
            options.onProgress?.(pageNumber, pdf.numPages, 'extracting');
          }
          return text;
        } finally {
          page.cleanup();
        }
      },
      { signal: cancellation.signal },
    );
    throwIfPageExtractionCancelled(options.signal);
    if (!options.allowEmptyText && pages.join('').replace(/\s+/g, '').length < 20) {
      throw new Error(
        options.recognizePage
          ? 'OCR 没有识别到足够文字，请检查页面清晰度或更换视觉模型。'
          : '这份 PDF 没有文字层。请先配置 AI 答疑的视觉模型，再使用扫描件 OCR 导入。',
      );
    }
    return { fingerprint, fileName: file.name, pageCount: pages.length, pages };
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await pdf.cleanup();
  }
}

export async function extractDocumentDigest(
  file: File,
  options: {
    onProgress?: (
      page: number,
      pageCount: number,
      stage: 'extracting' | 'ocr',
    ) => void;
    recognizePage?: (input: {
      fingerprint: string;
      pageNumber: number;
      pageImage: PageImageInput;
      signal?: AbortSignal;
    }) => Promise<string>;
    pageConcurrency?: number;
  } = {},
): Promise<DocumentDigest> {
  const extracted = await extractPdfPages(file, options);
  return createDocumentDigest({
    fingerprint: extracted.fingerprint,
    fileName: file.name,
    pages: extracted.pages,
  });
}
