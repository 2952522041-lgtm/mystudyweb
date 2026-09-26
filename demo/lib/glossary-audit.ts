import {
  checkTerminology,
  type Glossary,
  type TermPassage,
} from './glossary.ts';
import type { CourseBundle } from './course-storage/types.ts';
import type { CachedTranslation } from './reader-cache.ts';

export function auditCourseTerminology(
  bundle: CourseBundle,
  glossary: Glossary,
  cache: CachedTranslation[],
  documentId?: string,
) {
  const passages: TermPassage[] = [];
  let translatedPages = 0;
  let sourceAlignedPages = 0;
  let totalPages = 0;
  for (const doc of bundle.manifest.documents.filter(
    (doc) => !documentId || doc.id === documentId,
  )) {
    totalPages += doc.pageCount;
    const latest = new Map<string, CachedTranslation>();
    for (const entry of cache
      .filter((entry) => entry.fingerprint === doc.fingerprint)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
      latest.set(`${entry.pageNumber}:${entry.targetLanguage}`, entry);
    }
    translatedPages += new Set(
      [...latest.values()].map((entry) => entry.pageNumber),
    ).size;
    const aligned = new Set<number>();
    for (const entry of latest.values()) {
      const sources = entry.sourceParagraphs;
      const validSources =
        Array.isArray(sources) &&
        sources.length === entry.paragraphs.length &&
        sources.every((text) => typeof text === 'string');
      if (validSources) aligned.add(entry.pageNumber);
      entry.paragraphs.forEach((text, index) =>
        passages.push({
          documentId: doc.id,
          fileName: doc.fileName,
          pageNumber: entry.pageNumber,
          paragraph: index + 1,
          kind: 'translation',
          text,
          source: validSources ? sources[index] : undefined,
        }),
      );
    }
    sourceAlignedPages += aligned.size;
    const digest = bundle.digests[doc.id];
    digest?.sections?.forEach((section, index) => {
      passages.push({
        documentId: doc.id,
        fileName: doc.fileName,
        pageNumber: section.pageStart,
        paragraph: index + 1,
        kind: 'digest',
        text: section.title + '\n' + section.summary,
      });
      section.points?.forEach((point, pointIndex) =>
        passages.push({
          documentId: doc.id,
          fileName: doc.fileName,
          pageNumber: point.pageStart,
          paragraph: pointIndex + 1,
          kind: 'digest',
          text: point.text,
        }),
      );
    });
    for (const concept of digest?.concepts ?? []) {
      for (const source of concept.sources)
        passages.push({
          documentId: doc.id,
          fileName: doc.fileName,
          pageNumber: source.pageStart,
          paragraph: 1,
          kind: 'digest',
          text: concept.label + '\n' + concept.description,
        });
    }
  }
  for (const node of bundle.knowledge.nodes) {
    for (const source of node.sources.filter(
      (source) => !documentId || source.documentId === documentId,
    )) {
      passages.push({
        documentId: source.documentId,
        fileName: source.fileName,
        pageNumber: source.pageStart,
        paragraph: 1,
        kind: 'knowledge',
        text: node.label + '\n' + node.description,
      });
    }
  }
  return {
    issues: checkTerminology(glossary, passages),
    passages: passages.length,
    totalPages,
    translatedPages,
    sourceAlignedPages,
  };
}
