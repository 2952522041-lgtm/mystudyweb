import type { CourseBundle, DigestSection } from './course-storage/types.ts';

export interface CourseSearchHit {
  id: string;
  kind: 'knowledge' | 'note' | 'document' | 'page';
  title: string;
  excerpt: string;
  documentId?: string;
  page?: number;
  nodeId?: string;
  line?: number;
}

export interface CourseContentSearchInput {
  bundle: CourseBundle;
  notes?: string;
  pages?: Array<{ documentId: string; pages: string[] }>;
  query: string;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EXCERPT_LIMIT = 180;
const EXCERPT_LEAD = 60;

function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function compact(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function splitTerms(query: string): string[] {
  const normalized = fold(query).trim();
  if (!normalized) return [];
  return normalized.split(/\s+/u).filter((term) => term.length > 0);
}

function includesAll(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}

function buildExcerpt(body: string, terms: string[]): string {
  const display = compact(body);
  if (!display || display.length <= EXCERPT_LIMIT) return display;
  const lower = display.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return display.slice(0, EXCERPT_LIMIT).trim();
  const start = Math.min(
    Math.max(0, index - EXCERPT_LEAD),
    display.length - EXCERPT_LIMIT,
  );
  return display.slice(start, start + EXCERPT_LIMIT).trim();
}

interface NoteParagraph {
  line: number;
  title: string;
  text: string;
}

function noteParagraphs(content: string): NoteParagraph[] {
  const paragraphs: NoteParagraph[] = [];
  let start = -1;
  let buffered: string[] = [];
  const flush = () => {
    if (start < 0) return;
    const text = buffered
      .map((line) => line.trim())
      .join(' ')
      .trim();
    if (text) paragraphs.push({ line: start, title: buffered[0].trim(), text });
    start = -1;
    buffered = [];
  };
  const lines = content.split(/\r\n|[\n\r\u2028\u2029]/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      flush();
      continue;
    }
    if (start < 0) start = index + 1;
    buffered.push(line);
  }
  flush();
  return paragraphs;
}

function sectionBody(section: DigestSection): string {
  const parts: string[] = [];
  if (typeof section.summary === 'string') parts.push(section.summary);
  if (Array.isArray(section.points)) {
    for (const point of section.points) {
      if (point && typeof point.text === 'string') parts.push(point.text);
    }
  }
  return parts.join(' ').trim();
}

function pageCountOf(pageCount: number): number {
  if (typeof pageCount !== 'number' || !Number.isFinite(pageCount)) return 0;
  return pageCount > 0 ? Math.floor(pageCount) : 0;
}

function validPage(pageStart: number, pageCount: number): number | undefined {
  if (!Number.isInteger(pageStart)) return undefined;
  if (pageStart < 1 || pageStart > pageCount) return undefined;
  return pageStart;
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isFinite(limit))
    return DEFAULT_LIMIT;
  const value = Math.floor(limit);
  if (value < 0) return 0;
  return Math.min(value, MAX_LIMIT);
}

export function searchCourseContent(
  input: CourseContentSearchInput,
): CourseSearchHit[] {
  const terms = splitTerms(input.query);
  if (terms.length === 0) return [];

  const limit = resolveLimit(input.limit);
  const hits: CourseSearchHit[] = [];
  const seen = new Set<string>();
  const add = (hit: CourseSearchHit) => {
    if (seen.has(hit.id) || hits.length >= limit) return;
    seen.add(hit.id);
    hits.push(hit);
  };

  const documents = input.bundle.manifest.documents ?? [];
  const documentsById = new Map(
    documents.map((document) => [document.id, document]),
  );

  for (const document of documents) {
    if (!includesAll(fold(document.fileName), terms)) continue;
    add({
      id: `document:${document.id}`,
      kind: 'document',
      title: document.fileName,
      excerpt: buildExcerpt(document.fileName, terms),
      documentId: document.id,
    });
  }

  const nodes = input.bundle.knowledge.nodes ?? [];
  for (const node of nodes) {
    const description = node.description ?? '';
    if (!includesAll(`${fold(node.label)} ${fold(description)}`, terms))
      continue;
    add({
      id: `knowledge:${node.id}`,
      kind: 'knowledge',
      title: node.label,
      excerpt: buildExcerpt(description, terms),
      nodeId: node.id,
    });
  }

  const digests = input.bundle.digests ?? {};
  for (const key of Object.keys(digests)) {
    const digest = digests[key];
    if (!digest) continue;
    const documentId = digest.documentId || key;
    const document = documentsById.get(documentId);
    if (!document) continue;
    if (includesAll(`${fold(digest.title)} ${fold(digest.overview)}`, terms)) {
      add({
        id: `digest:${documentId}`,
        kind: 'document',
        title: digest.title,
        excerpt: buildExcerpt(digest.overview, terms),
        documentId,
      });
    }
    const pageCount = pageCountOf(document.pageCount);
    const sections = digest.sections ?? [];
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      const page = validPage(section.pageStart, pageCount);
      if (page === undefined) continue;
      const body = sectionBody(section);
      if (!includesAll(`${fold(section.title)} ${fold(body)}`, terms)) continue;
      add({
        id: `digest:${documentId}:section:${section.id || index}`,
        kind: 'page',
        title: section.title,
        excerpt: buildExcerpt(body, terms),
        documentId,
        page,
      });
    }
  }

  if (input.notes) {
    for (const paragraph of noteParagraphs(input.notes)) {
      if (
        !includesAll(`${fold(paragraph.title)} ${fold(paragraph.text)}`, terms)
      )
        continue;
      add({
        id: `note:${paragraph.line}`,
        kind: 'note',
        title: paragraph.title,
        excerpt: buildExcerpt(paragraph.text, terms),
        line: paragraph.line,
      });
    }
  }

  for (const entry of input.pages ?? []) {
    const document = documentsById.get(entry.documentId);
    if (!document) continue;
    const pageCount = pageCountOf(document.pageCount);
    const pageTexts = Array.isArray(entry.pages) ? entry.pages : [];
    for (let index = 0; index < pageTexts.length; index += 1) {
      const page = index + 1;
      if (page > pageCount) continue;
      const text = pageTexts[index];
      if (typeof text !== 'string') continue;
      if (!includesAll(`${fold(document.fileName)} ${fold(text)}`, terms))
        continue;
      add({
        id: `page:${document.id}:${page}`,
        kind: 'page',
        title: document.fileName,
        excerpt: buildExcerpt(text, terms),
        documentId: document.id,
        page,
      });
    }
  }

  return hits;
}
