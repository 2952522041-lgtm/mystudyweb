import { splitPageIntoSegments } from './knowledge/pdf-chunks.ts';
import { extractPageText } from './page-vision.ts';
import type { PDFDocumentProxy } from './pdfjs.ts';
import type { ChatMessage } from './chat.ts';

export interface DocumentChatChunk { pageNumber: number; text: string }

export function buildDocumentChatChunks(pages: string[]): DocumentChatChunk[] {
  return pages.flatMap((text, index) =>
    splitPageIntoSegments(index + 1, text, 2400).map(({ pageNumber, text }) => ({ pageNumber, text })),
  );
}

function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? [];
  return new Set(words.flatMap((word) => /\p{Script=Han}/u.test(word)
    ? Array.from({ length: Math.max(1, word.length - 1) }, (_, i) => word.slice(i, i + 2))
    : [word]));
}

/** Local keyword retrieval. Recent user questions help resolve follow-ups; PDF text never requests tools. */
export function retrieveDocumentChunks(chunks: DocumentChatChunk[], question: string, history: ChatMessage[] = [], limit = 5): DocumentChatChunk[] {
  const query = terms(question);
  const previous = terms(history.filter((m) => m.role === 'user' && m.allowWebSearch !== false).slice(-2).map((m) => m.content).join(' '));
  const tokens = chunks.map((chunk) => terms(chunk.text));
  const frequency = new Map<string, number>();
  for (const set of tokens) for (const term of set) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  // Explicit page references are still bounded to real pages in this PDF.
  const requested = new Set<number>();
  for (const match of question.matchAll(/(?:第\s*|pages?\s*)(\d+)\s*(?:(?:[-–到至]|、|和)\s*(\d+))?\s*页?/gi)) {
    const start = Number(match[1]);
    const end = Math.min(Number(match[2] ?? start), start + 20);
    for (let page = start; page <= end; page++) requested.add(page);
  }
  return chunks.map((chunk, index) => {
    let score = requested.has(chunk.pageNumber) ? 100 : 0;
    for (const term of tokens[index]) {
      const weight = Math.log(1 + chunks.length / (frequency.get(term) ?? 1));
      score += query.has(term) ? weight : previous.has(term) ? weight * 0.2 : 0;
    }
    return { chunk, score, index };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map(({ chunk }) => chunk);
}

const indexes = new WeakMap<PDFDocumentProxy, DocumentChatChunk[]>();
export async function readDocumentChatIndex(doc: PDFDocumentProxy, signal: AbortSignal): Promise<DocumentChatChunk[]> {
  signal.throwIfAborted();
  const cached = indexes.get(doc);
  if (cached) return cached;
  const pages: string[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    signal.throwIfAborted();
    pages.push(await extractPageText(doc, page));
  }
  signal.throwIfAborted();
  const chunks = buildDocumentChatChunks(pages);
  indexes.set(doc, chunks);
  return chunks;
}

export function formatDocumentChatContext(chunks: DocumentChatChunk[]): string {
  // JSON encoding prevents PDF markup from manufacturing page boundary tags.
  return `<document-excerpts>\n${JSON.stringify(chunks)}\n</document-excerpts>`;
}
