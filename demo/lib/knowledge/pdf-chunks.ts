/**
 * 按 PDF 页面边界把全文切分为适合模型上下文的分块。
 * 纯函数：输入 1 起始页码的页面文字数组，输出带页码标签的分块列表。
 */

export const PDF_CHUNK_MAX_CHARS = 12000;
export const PDF_PAGE_MAX_CHARS = 12000;

const PARAGRAPH_BREAK = /\n/g;
const SENTENCE_BREAK = /(?<=[。！？.!?])\s+/g;

export interface PageSegment {
  pageNumber: number;
  /** 页内分段序号；单页能放下时为 0。 */
  part: number;
  partCount: number;
  text: string;
}

export interface PdfChunk {
  index: number;
  segments?: PageSegment[];
  pageStart: number;
  pageEnd: number;
  pages: number[];
  charCount: number;
  /** 含 <page number="N"> 标签的完整分块文本。 */
  text: string;
}

function splitAtBoundary(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const minCut = Math.floor(limit * 0.5);
  const window = text.slice(0, limit + 1);
  let cut = -1;
  for (const pattern of [PARAGRAPH_BREAK, SENTENCE_BREAK]) {
    for (const match of window.matchAll(pattern)) {
      const index = match.index + match[0].length;
      if (index >= minCut && index <= limit) cut = index;
    }
    if (cut > 0) return cut;
  }
  // Never split a UTF-16 surrogate pair (emoji and supplementary CJK characters).
  return /[\uD800-\uDBFF]/.test(text[limit - 1]) && /[\uDC00-\uDFFF]/.test(text[limit])
    ? limit - 1 : limit;
}

/** 单页超过上限时在段落或句子边界继续拆分；正常页保持完整。 */
export function splitPageIntoSegments(
  pageNumber: number,
  text: string,
  maxChars = PDF_PAGE_MAX_CHARS,
): PageSegment[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) throw new RangeError('分块长度至少为 2。');
  const segments: PageSegment[] = [];
  let remaining = text;
  for (let part = 0; remaining.length > 0; part += 1) {
    const cut = splitAtBoundary(remaining, maxChars);
    segments.push({
      pageNumber,
      part,
      partCount: 0,
      text: remaining.slice(0, cut).trim(),
    });
    remaining = remaining.slice(cut).trim();
    if (remaining.length === 0) break;

  }
  for (const segment of segments) segment.partCount = segments.length;
  return segments.filter((segment) => segment.text.length > 0);
}

function pageTag(segment: PageSegment): string {
  const suffix = segment.partCount > 1 ? `（第 ${segment.part + 1} 部分）` : '';
  return `<page number="${segment.pageNumber}"${suffix ? ` part="${segment.part + 1}"` : ''}>\n${segment.text}\n</page>`;
}

/** 把页面段落按顺序打包成约 8000–12000 字符的分块；所有页面都会被覆盖。 */
export function buildPdfChunks(
  pages: string[],
  options?: { maxChunkChars?: number },
): PdfChunk[] {
  const maxChunkChars = options?.maxChunkChars ?? PDF_CHUNK_MAX_CHARS;
  const segments = pages.flatMap((text, index) =>
    splitPageIntoSegments(index + 1, text, Math.min(PDF_PAGE_MAX_CHARS, maxChunkChars)),
  );

  return packSegments(segments, maxChunkChars);
}

function packSegments(segments: PageSegment[], maxChunkChars: number): PdfChunk[] {
  const chunks: PdfChunk[] = [];
  let current: PageSegment[] = [];
  let currentChars = 0;
  let taggedChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const pageNumbers = [...new Set(current.map((s) => s.pageNumber))];
    chunks.push({
      index: chunks.length,
      segments: current,
      pageStart: pageNumbers[0]!,
      pageEnd: pageNumbers[pageNumbers.length - 1]!,
      pages: pageNumbers,
      charCount: currentChars,
      text: current.map(pageTag).join('\n'),
    });
    current = [];
    currentChars = 0;
    taggedChars = 0;
  };

  for (const segment of segments) {
    if (current.length > 0 && taggedChars + pageTag(segment).length + 1 > maxChunkChars) {
      flush();
    }
    current.push(segment);
    currentChars += segment.text.length;
    taggedChars += pageTag(segment).length + 1;
    if (currentChars >= maxChunkChars) flush();
  }
  flush();
  return chunks;
}

/** Repartition only the failed chunk; page identities survive page-internal splits. */
export function splitPdfChunk(chunk: PdfChunk): PdfChunk[] {
  if (!chunk.segments?.length) return [];
  const limit = Math.max(2, Math.floor(chunk.charCount / 2));
  const segments = chunk.segments.flatMap(segment =>
    splitPageIntoSegments(segment.pageNumber, segment.text, limit));
  return packSegments(segments, limit);
}
