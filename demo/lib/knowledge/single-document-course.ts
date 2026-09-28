import type {
  AiCourseKnowledge,
  ConceptRelation,
  DigestConcept,
  DocumentDigest,
  SourceReference,
} from '../course-storage/types.ts';
import { DIGEST_SCHEMA_VERSION } from '../course-storage/types.ts';
import {
  hierarchyIssues,
  MINDMAP_MAX_CONCEPTS,
} from './mindmap-structure.ts';

/** Provenance for a course result that is an exact projection of one digest. */
export const SINGLE_DOCUMENT_REUSE_PROMPT_VERSION =
  'single-document-reuse-v1';

const RELATION_LABELS = new Set([
  '包含',
  '依赖',
  '导致',
  '对比',
  '组成',
  '应用',
  '冲突',
  '关联',
]);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

interface SourceContext {
  documentId: string;
  fileName?: string;
  pages: Set<number>;
  maxPage: number;
}

/**
 * Digest sources are application-owned provenance. A source from another
 * document, another file, or an unlisted page cannot safely be projected into
 * a course without asking the provider to rebuild the result.
 */
function validSource(value: unknown, context: SourceContext): value is SourceReference {
  if (!isRecord(value)) return false;
  if (
    !nonEmptyString(value.documentId) ||
    value.documentId !== context.documentId ||
    !nonEmptyString(value.fileName)
  ) {
    return false;
  }
  if (context.fileName !== undefined && value.fileName !== context.fileName) {
    return false;
  }

  const pageStart = value.pageStart;
  const pageEnd = value.pageEnd === undefined ? pageStart : value.pageEnd;
  if (!isInteger(pageStart) || !isInteger(pageEnd)) return false;
  if (
    pageStart < 1 ||
    pageEnd < pageStart ||
    pageEnd > context.maxPage ||
    !context.pages.has(pageStart) ||
    !context.pages.has(pageEnd)
  ) {
    return false;
  }

  if (value.type !== 'pdf') return false;
  context.fileName ??= value.fileName;
  return true;
}

function validPageRange(
  value: unknown,
  context: SourceContext,
): value is { pageStart: number; pageEnd: number } {
  if (!isRecord(value)) return false;
  const pageStart = value.pageStart;
  const pageEnd = value.pageEnd;
  if (!isInteger(pageStart) || !isInteger(pageEnd)) return false;
  return (
    pageStart >= 1 &&
    pageEnd >= pageStart &&
    pageEnd <= context.maxPage &&
    context.pages.has(pageStart) &&
    context.pages.has(pageEnd)
  );
}

function validDigestSections(
  digest: DocumentDigest,
  context: SourceContext,
): boolean {
  if (!Array.isArray(digest.sections) || digest.sections.length === 0) {
    return false;
  }
  for (const section of digest.sections) {
    if (
      !isRecord(section) ||
      !nonEmptyString(section.id) ||
      !nonEmptyString(section.title) ||
      !nonEmptyString(section.summary) ||
      !validPageRange(section, context)
    ) {
      return false;
    }
    if (section.points === undefined) continue;
    if (!Array.isArray(section.points)) return false;
    for (const point of section.points) {
      if (
        !isRecord(point) ||
        !nonEmptyString(point.text) ||
        !validPageRange(point, context)
      ) {
        return false;
      }
    }
  }
  return true;
}

function validConcepts(
  digest: DocumentDigest,
  context: SourceContext,
): digest is DocumentDigest & { concepts: DigestConcept[] } {
  if (
    !Array.isArray(digest.concepts) ||
    digest.concepts.length === 0 ||
    digest.concepts.length > MINDMAP_MAX_CONCEPTS
  ) {
    return false;
  }

  const ids = new Set<string>();
  for (const concept of digest.concepts) {
    if (
      !isRecord(concept) ||
      !nonEmptyString(concept.id) ||
      ids.has(concept.id) ||
      !nonEmptyString(concept.label) ||
      !nonEmptyString(concept.description) ||
      !Object.prototype.hasOwnProperty.call(concept, 'parentId') ||
      (concept.parentId !== null &&
        (!nonEmptyString(concept.parentId) || typeof concept.parentId !== 'string')) ||
      !Array.isArray(concept.sources) ||
      concept.sources.length === 0 ||
      concept.sources.some((source) => !validSource(source, context))
    ) {
      return false;
    }
    ids.add(concept.id);
  }

  return hierarchyIssues(digest.concepts, 1).length === 0;
}

function validRelations(
  digest: DocumentDigest,
): digest is DocumentDigest & { relations: ConceptRelation[] } {
  if (!Array.isArray(digest.relations)) return false;
  const ids = new Set(digest.concepts.map((concept) => concept.id));
  for (const relation of digest.relations) {
    if (
      !isRecord(relation) ||
      !nonEmptyString(relation.from) ||
      !nonEmptyString(relation.to) ||
      relation.from === relation.to ||
      !ids.has(relation.from) ||
      !ids.has(relation.to) ||
      !nonEmptyString(relation.label) ||
      !RELATION_LABELS.has(relation.label)
    ) {
      return false;
    }
    if (
      relation.label === '包含' &&
      digest.concepts.find((concept) => concept.id === relation.to)?.parentId !==
        relation.from
    ) {
      return false;
    }
  }
  return true;
}

function validEvidence(
  digest: DocumentDigest,
  context: SourceContext,
): boolean {
  if (digest.evidence === undefined) return true;
  if (!Array.isArray(digest.evidence)) return false;
  return digest.evidence.every(
    (item) =>
      isRecord(item) &&
      nonEmptyString(item.text) &&
      Array.isArray(item.sources) &&
      item.sources.length > 0 &&
      item.sources.every((source) => validSource(source, context)),
  );
}

function validDiagnostics(digest: DocumentDigest): boolean {
  if (digest.diagnostics === undefined) return true;
  if (!Array.isArray(digest.diagnostics)) return false;
  return digest.diagnostics.every((diagnostic) => {
    if (!isRecord(diagnostic)) return false;
    const requiredStrings = ['layer', 'action', 'identity', 'detail'];
    const requiredNumbers = [
      'inputBytes',
      'limit',
      'droppedItems',
      'droppedBytes',
    ];
    if (
      requiredStrings.some((key) => !nonEmptyString(diagnostic[key])) ||
      requiredNumbers.some(
        (key) =>
          typeof diagnostic[key] !== 'number' ||
          !Number.isFinite(diagnostic[key]),
      )
    ) {
      return false;
    }
    if (diagnostic.outputBytes !== undefined &&
        (typeof diagnostic.outputBytes !== 'number' ||
          !Number.isFinite(diagnostic.outputBytes))) {
      return false;
    }
    if (diagnostic.timing !== undefined) {
      if (!isRecord(diagnostic.timing)) return false;
      const timing = diagnostic.timing;
      if (
        (timing.headersMs !== null &&
          (typeof timing.headersMs !== 'number' ||
            !Number.isFinite(timing.headersMs))) ||
        (timing.firstContentMs !== null &&
          (typeof timing.firstContentMs !== 'number' ||
            !Number.isFinite(timing.firstContentMs))) ||
        typeof timing.totalMs !== 'number' ||
        !Number.isFinite(timing.totalMs) ||
        typeof timing.outputChars !== 'number' ||
        !Number.isFinite(timing.outputChars) ||
        !['success', 'failure', 'cancelled'].includes(String(timing.status))
      ) {
        return false;
      }
    }
    if (diagnostic.affected === undefined) return true;
    if (!Array.isArray(diagnostic.affected)) return false;
    return diagnostic.affected.every((item) => {
      if (!isRecord(item) || !nonEmptyString(item.preview)) return false;
      if (
        typeof item.bytes !== 'number' ||
        !Number.isFinite(item.bytes) ||
        !Array.isArray(item.sources)
      ) {
        return false;
      }
      return item.sources.every((source) => isRecord(source));
    });
  });
}

function cloneSource(source: SourceReference): SourceReference {
  return { ...source };
}

function cloneEvidence(
  evidence: NonNullable<DocumentDigest['evidence']>,
): NonNullable<AiCourseKnowledge['evidence']> {
  return evidence.map((item) => ({
    text: item.text,
    sources: item.sources.map(cloneSource),
  }));
}

function cloneDiagnostics(
  diagnostics: NonNullable<DocumentDigest['diagnostics']>,
): NonNullable<AiCourseKnowledge['diagnostics']> {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    ...(diagnostic.timing ? { timing: { ...diagnostic.timing } } : {}),
    ...(diagnostic.affected
      ? {
          affected: diagnostic.affected.map((item) => ({
            ...item,
            sources: item.sources.map(cloneSource),
          })),
        }
      : {}),
  }));
}

type ReusableDigest = DocumentDigest & {
  provider: string;
  model: string;
};

function validDigest(digest: DocumentDigest): digest is ReusableDigest {
  if (
    !isRecord(digest) ||
    digest.schemaVersion !== DIGEST_SCHEMA_VERSION ||
    !nonEmptyString(digest.documentId) ||
    !nonEmptyString(digest.fingerprint) ||
    !nonEmptyString(digest.title) ||
    !nonEmptyString(digest.overview) ||
    !nonEmptyString(digest.promptVersion) ||
    digest.promptVersion === 'local-structure-v1' ||
    !nonEmptyString(digest.provider) ||
    !nonEmptyString(digest.model) ||
    !nonEmptyString(digest.updatedAt) ||
    !Array.isArray(digest.sourcePages) ||
    digest.sourcePages.length === 0 ||
    !Array.isArray(digest.unresolvedQuestions) ||
    digest.unresolvedQuestions.some((question) => !nonEmptyString(question))
  ) {
    return false;
  }

  const pages = new Set<number>();
  for (const page of digest.sourcePages) {
    if (!isInteger(page) || page < 1 || pages.has(page)) return false;
    pages.add(page);
  }
  const context: SourceContext = {
    documentId: digest.documentId,
    pages,
    maxPage: Math.max(...pages),
  };

  return (
    validDigestSections(digest, context) &&
    validConcepts(digest, context) &&
    validRelations(digest) &&
    validEvidence(digest, context) &&
    validDiagnostics(digest)
  );
}

/**
 * Reuse a complete AI digest as the first course result for a one-document
 * course. Returning null deliberately leaves all other cases on the existing
 * provider path.
 */
export function courseKnowledgeFromSingleDigest(
  digests: DocumentDigest[],
  userNodeLabels: string[],
): AiCourseKnowledge | null {
  if (!Array.isArray(digests) || digests.length !== 1) return null;
  if (!Array.isArray(userNodeLabels) || userNodeLabels.length !== 0) return null;
  const digest = digests[0];
  if (!digest || !validDigest(digest)) return null;

  const nodes = digest.concepts.map((concept) => ({
    ...(concept.parentId === null ? { parentId: null } : { parentId: concept.parentId }),
    id: concept.id,
    label: concept.label,
    description: concept.description,
    sources: concept.sources.map(cloneSource),
  }));
  const result: AiCourseKnowledge = {
    ...(digest.evidence ? { evidence: cloneEvidence(digest.evidence) } : {}),
    ...(digest.diagnostics
      ? { diagnostics: cloneDiagnostics(digest.diagnostics) }
      : {}),
    theme: digest.overview,
    nodes,
    relations: digest.relations.map((relation) => ({ ...relation })),
    conflicts: [],
    unresolvedQuestions: [...digest.unresolvedQuestions],
    provider: digest.provider,
    model: digest.model,
    promptVersion: SINGLE_DOCUMENT_REUSE_PROMPT_VERSION,
  };
  return result;
}
