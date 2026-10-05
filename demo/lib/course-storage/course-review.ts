import { sha256Hex } from './file-utils.ts';
import { applyAiCourseKnowledge } from '../knowledge/course-merger.ts';
import type {
  AiCourseKnowledge,
  CourseBundle,
  CourseReview,
  DocumentProcessing,
} from './types.ts';

const INVALID_AI_KNOWLEDGE = '候选课程成果格式无效，无法进入审阅。';
const STALE_REVIEW = '课程已变更，请保留原成果并重新生成候选版本。';

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    result[key] = canonicalize(item);
  }
  return result;
}

function assertAiKnowledge(knowledge: AiCourseKnowledge): void {
  if (!knowledge || typeof knowledge !== 'object') {
    throw new Error(INVALID_AI_KNOWLEDGE);
  }
  const record = knowledge as unknown as Record<string, unknown>;
  for (const key of ['theme', 'provider', 'model', 'promptVersion']) {
    if (typeof record[key] !== 'string') throw new Error(INVALID_AI_KNOWLEDGE);
  }
  for (const key of [
    'nodes',
    'relations',
    'conflicts',
    'unresolvedQuestions',
  ]) {
    if (!Array.isArray(record[key])) throw new Error(INVALID_AI_KNOWLEDGE);
  }
}

function hasReviewShape(review: CourseReview): boolean {
  if (review.schemaVersion !== 1) {
    return false;
  }
  if (typeof review.id !== 'string' || review.id.length === 0) return false;
  if (typeof review.courseId !== 'string') return false;
  if (
    typeof review.baseSignature !== 'string' ||
    review.baseSignature.length === 0
  ) {
    return false;
  }
  if (!Array.isArray(review.documentIds) || review.documentIds.length === 0) {
    return false;
  }
  return review.documentIds.every(
    (id) => typeof id === 'string' && id.length > 0,
  );
}

export async function courseReviewSignature(
  bundle: CourseBundle,
  documentIds: string[],
): Promise<string> {
  const selected = new Set(documentIds);
  const documents = bundle.manifest.documents
    .filter((doc) => doc.includedInCourse || selected.has(doc.id))
    .map((doc) => ({
      id: doc.id,
      fingerprint: doc.fingerprint,
      includedInCourse: doc.includedInCourse,
      digest: bundle.digests[doc.id] ?? null,
    }))
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  const payload = canonicalize({ knowledge: bundle.knowledge, documents });
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return sha256Hex(bytes.buffer as ArrayBuffer);
}

export async function stageCourseReviewBundle(
  current: CourseBundle,
  ids: string[],
  knowledge: AiCourseKnowledge,
  options: { id?: string; now?: string } = {},
): Promise<CourseBundle> {
  const now = options.now ?? new Date().toISOString();
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('请选择至少一份资料生成候选课程成果。');
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('候选课程成果包含无效的资料标识。');
    }
    if (seen.has(id)) {
      throw new Error('候选课程成果包含重复的资料标识。');
    }
    seen.add(id);
  }
  const byId = new Map(current.manifest.documents.map((doc) => [doc.id, doc]));
  for (const id of ids) {
    if (!byId.has(id)) {
      throw new Error('候选课程成果引用了不存在的资料。');
    }
    const digest = current.digests[id];
    if (
      !digest ||
      typeof digest !== 'object' ||
      digest.documentId !== id ||
      typeof digest.fingerprint !== 'string' ||
      digest.fingerprint.length === 0 ||
      digest.fingerprint !== byId.get(id)!.fingerprint
    ) {
      throw new Error('所选资料缺少有效摘要，无法生成候选课程成果。');
    }
  }
  if (current.manifest.pendingReview) {
    throw new Error('已有待审阅的候选课程成果，请先处理。');
  }
  assertAiKnowledge(knowledge);
  const selected = new Set(ids);
  const documents = current.manifest.documents.map((doc) => {
    if (!selected.has(doc.id)) return { ...doc };
    const fallbackOptions = {
      generateSummary: doc.hasSummary,
      generateMindmap: doc.hasMindmap,
      mergeIntoCourse: true,
      includeConversationInsights: doc.includeConversationInsights,
    };
    const processing: DocumentProcessing = {
      ...(doc.processing ?? { options: fallbackOptions }),
      phase: 'course',
      status: 'review',
      runId: undefined,
      error: undefined,
      message: '候选课程成果已生成，等待审阅',
      updatedAt: now,
    };
    return { ...doc, processing };
  });
  const baseSignature = await courseReviewSignature(current, ids);
  return {
    ...current,
    manifest: {
      ...current.manifest,
      revision: current.manifest.revision + 1,
      updatedAt: now,
      documents,
      pendingReview: {
        schemaVersion: 1,
        id: options.id ?? crypto.randomUUID(),
        courseId: current.manifest.id,
        createdAt: now,
        documentIds: [...ids],
        baseSignature,
        knowledge: structuredClone(knowledge),
      },
    },
  };
}

export async function reviewIsCurrent(
  current: CourseBundle,
  review: CourseReview,
): Promise<boolean> {
  try {
    if (!review || typeof review !== 'object') return false;
    if (!hasReviewShape(review)) return false;
    if (review.courseId !== current.manifest.id) return false;
    // A later task supersedes this candidate even if it has not changed its
    // digest yet. Accepting must never clear a newly queued or paused task.
    if (
      review.documentIds.some(
        (id) =>
          current.manifest.documents.find((doc) => doc.id === id)?.processing
            ?.status !== 'review',
      )
    )
      return false;
    const signature = await courseReviewSignature(current, review.documentIds);
    return signature === review.baseSignature;
  } catch {
    return false;
  }
}

export async function resolveCourseReviewBundle(
  current: CourseBundle,
  reviewId: string,
  accept: boolean,
  now: string = new Date().toISOString(),
): Promise<CourseBundle> {
  const review = current.manifest.pendingReview;
  if (!review || review.id !== reviewId) {
    throw new Error('未找到对应的待审阅候选课程成果。');
  }
  if (accept && !(await reviewIsCurrent(current, review))) {
    throw new Error(STALE_REVIEW);
  }
  const selected = new Set(review.documentIds);
  const documents = current.manifest.documents.map((doc) => {
    if (!selected.has(doc.id)) return { ...doc };
    if (accept) {
      return {
        ...doc,
        includedInCourse: true,
        status: 'course-merged' as const,
        processing: undefined,
      };
    }
    if (doc.processing?.status === 'review') {
      return {
        ...doc,
        status: doc.includedInCourse
          ? ('course-merged' as const)
          : ('document-artifacts-ready' as const),
        processing: undefined,
      };
    }
    return { ...doc };
  });
  const knowledge = accept
    ? applyAiCourseKnowledge(current.knowledge, review.knowledge, now)
    : current.knowledge;
  const manifest = {
    ...current.manifest,
    revision: current.manifest.revision + 1,
    updatedAt: now,
    documents,
    activeKnowledgeVersion: accept
      ? knowledge.version
      : current.manifest.activeKnowledgeVersion,
  };
  delete manifest.pendingReview;
  return {
    ...current,
    manifest,
    knowledge,
  };
}
