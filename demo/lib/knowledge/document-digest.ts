import { loadPdfjs } from '../pdfjs.ts';
import { itemsFromPdfJs, normalizePage } from '../pdf-text.ts';
import { sha256Hex, stableDocumentId } from '../course-storage/file-utils.ts';
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

export async function extractDocumentDigest(
  file: File,
  onProgress?: (page: number, pageCount: number) => void,
): Promise<DocumentDigest> {
  const buffer = await file.arrayBuffer();
  const fingerprint = await sha256Hex(buffer);
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)) })
    .promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push(
        normalizePage(
          itemsFromPdfJs(
            content.items as Array<{
              str?: string;
              transform?: number[];
              width?: number;
              height?: number;
            }>,
            viewport.height,
          ),
        ).text,
      );
      onProgress?.(pageNumber, pdf.numPages);
      page.cleanup();
    }
  } finally {
    await pdf.cleanup();
  }
  if (pages.join('').replace(/\s+/g, '').length < 20) {
    throw new Error(
      '这份 PDF 没有足够的可提取文字，当前课程知识库暂不支持扫描版 PDF。',
    );
  }
  return createDocumentDigest({ fingerprint, fileName: file.name, pages });
}
