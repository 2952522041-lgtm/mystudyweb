import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  courseReviewSignature,
  resolveCourseReviewBundle,
  reviewIsCurrent,
  stageCourseReviewBundle,
} from '../lib/course-storage/course-review.ts';
import type {
  AiCourseKnowledge,
  CourseBundle,
  CourseKnowledge,
  DocumentDigest,
  DocumentRecord,
  SourceReference,
} from '../lib/course-storage/types.ts';

const NOW = '2026-01-02T03:04:05.000Z';
const LATER = '2026-02-03T04:05:06.000Z';

function source(documentId: string, page = 1): SourceReference {
  return {
    documentId,
    fileName: `${documentId}.pdf`,
    pageStart: page,
    type: 'pdf',
  };
}

function digest(
  documentId: string,
  fingerprint: string,
  title: string,
): DocumentDigest {
  return {
    schemaVersion: 3,
    documentId,
    fingerprint,
    title,
    overview: `${title} 概览`,
    sections: [],
    concepts: [],
    relations: [],
    unresolvedQuestions: [],
    sourcePages: [1],
    promptVersion: 'test-v1',
    updatedAt: NOW,
  };
}

function document(
  id: string,
  overrides: Partial<DocumentRecord> = {},
): DocumentRecord {
  return {
    id,
    fingerprint: `${id}-fp`,
    fileName: `${id}.pdf`,
    storedFileName: `${id}.pdf`,
    pageCount: 3,
    status: 'document-artifacts-ready',
    includedInCourse: false,
    includeConversationInsights: false,
    hasSummary: true,
    hasMindmap: true,
    importedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function knowledge(): CourseKnowledge {
  return {
    schemaVersion: 3,
    courseId: 'course-1',
    version: 2,
    nodes: [
      {
        id: 'root',
        label: '课程',
        description: '课程总知识入口。',
        kind: 'course',
        ownership: 'generated',
        sources: [],
      },
      {
        id: 'user-note',
        label: '用户笔记',
        description: '用户手工保留的节点。',
        kind: 'insight',
        ownership: 'user',
        sources: [],
      },
      {
        id: 'gen-a',
        label: '概念 A',
        description: '生成的概念。',
        kind: 'concept',
        ownership: 'generated',
        sources: [source('doc-a')],
      },
    ],
    relations: [],
    conflicts: [],
    updatedAt: NOW,
  };
}

function aiKnowledge(): AiCourseKnowledge {
  return {
    theme: '课程主题',
    nodes: [
      {
        id: 'ai-b',
        label: '概念 B',
        description: '候选概念 B。',
        sources: [source('doc-b')],
      },
    ],
    relations: [{ from: 'root', to: 'ai-b', label: '包含' }],
    conflicts: [],
    unresolvedQuestions: ['候选问题？'],
    provider: 'provider',
    model: 'model',
    promptVersion: 'prompt-v1',
  };
}

function baseBundle(): CourseBundle {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'course-1',
      name: '课程',
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
      activeKnowledgeVersion: 2,
      documents: [
        document('doc-a', { includedInCourse: true, status: 'course-merged' }),
        document('doc-b'),
        document('doc-raw', { status: 'selected' }),
      ],
    },
    knowledge: knowledge(),
    digests: {
      'doc-a': digest('doc-a', 'doc-a-fp', '文档 A'),
      'doc-b': digest('doc-b', 'doc-b-fp', '文档 B'),
    },
  };
}

async function stagedBundle(): Promise<CourseBundle> {
  return stageCourseReviewBundle(baseBundle(), ['doc-b'], aiKnowledge(), {
    id: 'review-1',
    now: NOW,
  });
}

void test('stage keeps candidate unpublished and records pending review', async () => {
  const current = baseBundle();
  const staged = await stageCourseReviewBundle(
    current,
    ['doc-b'],
    aiKnowledge(),
    {
      id: 'review-1',
      now: NOW,
    },
  );

  assert.deepStrictEqual(staged.knowledge, current.knowledge);
  assert.strictEqual(staged.manifest.activeKnowledgeVersion, 2);
  assert.strictEqual(staged.manifest.revision, 4);
  assert.strictEqual(staged.manifest.updatedAt, NOW);

  const review = staged.manifest.pendingReview;
  assert.ok(review);
  assert.strictEqual(review.schemaVersion, 1);
  assert.strictEqual(review.id, 'review-1');
  assert.strictEqual(review.courseId, 'course-1');
  assert.strictEqual(review.createdAt, NOW);
  assert.deepStrictEqual(review.documentIds, ['doc-b']);
  assert.strictEqual(typeof review.baseSignature, 'string');
  assert.ok(review.baseSignature.length > 0);
  assert.deepStrictEqual(review.knowledge, aiKnowledge());
  assert.notStrictEqual(review.knowledge, aiKnowledge());

  const selected = staged.manifest.documents.find((doc) => doc.id === 'doc-b');
  assert.ok(selected);
  assert.strictEqual(selected.includedInCourse, false);
  assert.ok(selected.processing);
  assert.strictEqual(selected.processing.phase, 'course');
  assert.strictEqual(selected.processing.status, 'review');
  assert.strictEqual(
    selected.processing.message,
    '候选课程成果已生成，等待审阅',
  );
  assert.strictEqual(selected.processing.updatedAt, NOW);
  assert.strictEqual(selected.processing.runId, undefined);
  assert.strictEqual(selected.processing.error, undefined);
  assert.deepStrictEqual(selected.processing.options, {
    generateSummary: true,
    generateMindmap: true,
    mergeIntoCourse: true,
    includeConversationInsights: false,
  });

  const untouched = staged.manifest.documents.find((doc) => doc.id === 'doc-a');
  assert.strictEqual(untouched?.processing, undefined);
  assert.deepStrictEqual(staged.digests, current.digests);
});

void test('candidate knowledge is deep cloned and user nodes survive accept', async () => {
  const input = aiKnowledge();
  const staged = await stageCourseReviewBundle(baseBundle(), ['doc-b'], input, {
    id: 'review-1',
    now: NOW,
  });
  input.nodes[0].label = '被修改';

  assert.strictEqual(
    staged.manifest.pendingReview?.knowledge.nodes[0].label,
    '概念 B',
  );

  const accepted = await resolveCourseReviewBundle(
    staged,
    'review-1',
    true,
    LATER,
  );
  const userNode = accepted.knowledge.nodes.find(
    (node) => node.id === 'user-note',
  );
  assert.ok(userNode);
  assert.strictEqual(userNode.ownership, 'user');
  assert.strictEqual(
    accepted.knowledge.nodes.some((node) => node.label === '概念 B'),
    true,
  );
  assert.strictEqual(
    accepted.manifest.activeKnowledgeVersion,
    accepted.knowledge.version,
  );
  assert.strictEqual(accepted.knowledge.version, 3);
  assert.strictEqual(accepted.knowledge.updatedAt, LATER);
});

void test('accept publishes selected documents and removes pending review', async () => {
  const staged = await stagedBundle();
  const accepted = await resolveCourseReviewBundle(
    staged,
    'review-1',
    true,
    LATER,
  );
  const selected = accepted.manifest.documents.find(
    (doc) => doc.id === 'doc-b',
  );

  assert.ok(selected);
  assert.strictEqual(selected.includedInCourse, true);
  assert.strictEqual(selected.status, 'course-merged');
  assert.strictEqual(selected.processing, undefined);
  assert.strictEqual(accepted.manifest.pendingReview, undefined);
  assert.strictEqual('pendingReview' in accepted.manifest, false);
  assert.strictEqual(accepted.manifest.revision, 5);
  assert.strictEqual(accepted.manifest.updatedAt, LATER);
});

void test('discard keeps live knowledge and restores selected documents', async () => {
  const current = baseBundle();
  const staged = await stageCourseReviewBundle(
    current,
    ['doc-b'],
    aiKnowledge(),
    {
      id: 'review-1',
      now: NOW,
    },
  );
  const discarded = await resolveCourseReviewBundle(
    staged,
    'review-1',
    false,
    LATER,
  );
  const selected = discarded.manifest.documents.find(
    (doc) => doc.id === 'doc-b',
  );

  assert.deepStrictEqual(discarded.knowledge, current.knowledge);
  assert.strictEqual(discarded.knowledge, staged.knowledge);
  assert.strictEqual(discarded.manifest.activeKnowledgeVersion, 2);
  assert.ok(selected);
  assert.strictEqual(selected.includedInCourse, false);
  assert.strictEqual(selected.status, 'document-artifacts-ready');
  assert.strictEqual(selected.processing, undefined);
  assert.strictEqual('pendingReview' in discarded.manifest, false);
  assert.strictEqual(discarded.manifest.revision, 5);
  assert.strictEqual(discarded.manifest.updatedAt, LATER);
});

void test('discard restores course-merged status for already included documents', async () => {
  const staged = await stageCourseReviewBundle(
    baseBundle(),
    ['doc-a'],
    aiKnowledge(),
    {
      id: 'review-1',
      now: NOW,
    },
  );
  const discarded = await resolveCourseReviewBundle(
    staged,
    'review-1',
    false,
    LATER,
  );
  const selected = discarded.manifest.documents.find(
    (doc) => doc.id === 'doc-a',
  );

  assert.ok(selected);
  assert.strictEqual(selected.status, 'course-merged');
  assert.strictEqual(selected.includedInCourse, true);
  assert.strictEqual(selected.processing, undefined);
});

void test('discard preserves a subsequently queued unrelated task', async () => {
  const staged = await stagedBundle();
  const queued: DocumentProcessingLike = {
    phase: 'document',
    status: 'queued',
    options: {
      generateSummary: true,
      generateMindmap: true,
      mergeIntoCourse: true,
      includeConversationInsights: false,
    },
    updatedAt: LATER,
  };
  const requeued = {
    ...staged,
    manifest: {
      ...staged.manifest,
      documents: staged.manifest.documents.map((doc) =>
        doc.id === 'doc-b' ? { ...doc, processing: queued } : { ...doc },
      ),
    },
  };
  const discarded = await resolveCourseReviewBundle(
    requeued,
    'review-1',
    false,
    LATER,
  );
  const selected = discarded.manifest.documents.find(
    (doc) => doc.id === 'doc-b',
  );

  assert.deepStrictEqual(selected?.processing, queued);
});

type DocumentProcessingLike = NonNullable<DocumentRecord['processing']>;

void test('accept rejects a superseding task and discard preserves its checkpoint', async () => {
  for (const status of ['queued', 'running', 'paused', 'cancelled'] as const) {
    const staged = await stagedBundle();
    const review = staged.manifest.pendingReview!;
    const selected = staged.manifest.documents.find((doc) =>
      review.documentIds.includes(doc.id),
    )!;
    selected.processing = { ...selected.processing!, status };
    assert.equal(await reviewIsCurrent(staged, review), false);
    await assert.rejects(
      resolveCourseReviewBundle(staged, review.id, true),
      /课程已变更/,
    );
    const discarded = await resolveCourseReviewBundle(staged, review.id, false);
    assert.equal(
      discarded.manifest.documents.find((doc) => doc.id === selected.id)
        ?.processing?.status,
      status,
    );
    assert.deepEqual(discarded.knowledge, staged.knowledge);
  }
});

void test('reviewIsCurrent accepts an unchanged staged review', async () => {
  const staged = await stagedBundle();
  assert.ok(staged.manifest.pendingReview);
  assert.strictEqual(
    await reviewIsCurrent(staged, staged.manifest.pendingReview),
    true,
  );
});

void test('reviewIsCurrent is false for removed document, changed digest or knowledge', async () => {
  const staged = await stagedBundle();
  const review = staged.manifest.pendingReview;
  assert.ok(review);

  const removed = {
    ...staged,
    manifest: {
      ...staged.manifest,
      documents: staged.manifest.documents.filter((doc) => doc.id !== 'doc-a'),
    },
  };
  assert.strictEqual(await reviewIsCurrent(removed, review), false);

  const changedDigest = {
    ...staged,
    digests: {
      ...staged.digests,
      'doc-a': { ...staged.digests['doc-a'], title: '改过的标题' },
    },
  };
  assert.strictEqual(await reviewIsCurrent(changedDigest, review), false);

  const changedKnowledge = {
    ...staged,
    knowledge: {
      ...staged.knowledge,
      nodes: staged.knowledge.nodes.map((node) =>
        node.id === 'gen-a' ? { ...node, label: '改过的概念' } : node,
      ),
    },
  };
  assert.strictEqual(await reviewIsCurrent(changedKnowledge, review), false);
});

void test('reviewIsCurrent is false when a new included document appears', async () => {
  const staged = await stagedBundle();
  const review = staged.manifest.pendingReview;
  assert.ok(review);
  const withNewIncluded = {
    ...staged,
    manifest: {
      ...staged.manifest,
      documents: [
        ...staged.manifest.documents,
        document('doc-new', {
          includedInCourse: true,
          status: 'course-merged',
        }),
      ],
    },
    digests: {
      ...staged.digests,
      'doc-new': digest('doc-new', 'doc-new-fp', '文档 NEW'),
    },
  };
  assert.strictEqual(await reviewIsCurrent(withNewIncluded, review), false);
});

void test('reviewIsCurrent ignores unrelated raw documents and processing progress', async () => {
  const staged = await stagedBundle();
  const review = staged.manifest.pendingReview;
  assert.ok(review);
  const noisy = {
    ...staged,
    manifest: {
      ...staged.manifest,
      revision: staged.manifest.revision + 9,
      updatedAt: LATER,
      documents: [
        ...staged.manifest.documents.map((doc) =>
          doc.id === 'doc-b'
            ? {
                ...doc,
                updatedAt: LATER,
                processing: {
                  ...(doc.processing as NonNullable<
                    DocumentRecord['processing']
                  >),
                  completedUnits: 5,
                  totalUnits: 10,
                  progressRevision: 3,
                  lastActivityAt: LATER,
                },
              }
            : { ...doc, updatedAt: LATER },
        ),
        document('doc-raw-new', { status: 'selected' }),
      ],
    },
  };
  assert.strictEqual(await reviewIsCurrent(noisy, review), true);
});

void test('reviewIsCurrent returns false without throwing for malformed reviews', async () => {
  const staged = await stagedBundle();
  const review = staged.manifest.pendingReview;
  assert.ok(review);

  assert.strictEqual(await reviewIsCurrent(staged, undefined as never), false);
  assert.strictEqual(await reviewIsCurrent(staged, null as never), false);
  assert.strictEqual(
    await reviewIsCurrent(staged, { ...review, courseId: 'course-2' }),
    false,
  );
  assert.strictEqual(
    await reviewIsCurrent(staged, { ...review, id: '' }),
    false,
  );
  assert.strictEqual(
    await reviewIsCurrent(staged, { ...review, documentIds: 'doc-a' as never }),
    false,
  );
  assert.strictEqual(
    await reviewIsCurrent(staged, { ...review, documentIds: [] }),
    false,
  );
  assert.strictEqual(
    await reviewIsCurrent(staged, { ...review, baseSignature: 42 as never }),
    false,
  );
  assert.strictEqual(
    await reviewIsCurrent(staged, { ...review, baseSignature: 'deadbeef' }),
    false,
  );
});

void test('stage rejects invalid selections and duplicate reviews', async () => {
  await assert.rejects(
    stageCourseReviewBundle(baseBundle(), [], aiKnowledge(), { now: NOW }),
  );
  await assert.rejects(
    stageCourseReviewBundle(baseBundle(), ['doc-b', 'doc-b'], aiKnowledge(), {
      now: NOW,
    }),
  );
  await assert.rejects(
    stageCourseReviewBundle(baseBundle(), ['missing'], aiKnowledge(), {
      now: NOW,
    }),
  );
  await assert.rejects(
    stageCourseReviewBundle(baseBundle(), ['doc-raw'], aiKnowledge(), {
      now: NOW,
    }),
  );

  const staged = await stagedBundle();
  await assert.rejects(
    stageCourseReviewBundle(staged, ['doc-b'], aiKnowledge(), { now: LATER }),
  );
});

void test('stage rejects a malformed AI payload', async () => {
  const current = baseBundle();
  await assert.rejects(
    stageCourseReviewBundle(
      current,
      ['doc-b'],
      { ...aiKnowledge(), theme: 1 as never },
      {
        now: NOW,
      },
    ),
  );
  await assert.rejects(
    stageCourseReviewBundle(
      current,
      ['doc-b'],
      { ...aiKnowledge(), nodes: null as never },
      {
        now: NOW,
      },
    ),
  );
  await assert.rejects(
    stageCourseReviewBundle(
      current,
      ['doc-b'],
      { ...aiKnowledge(), unresolvedQuestions: undefined as never },
      { now: NOW },
    ),
  );
});

void test('resolve rejects missing or wrong review ids', async () => {
  const current = baseBundle();
  await assert.rejects(
    resolveCourseReviewBundle(current, 'review-1', true, NOW),
  );
  const staged = await stagedBundle();
  await assert.rejects(resolveCourseReviewBundle(staged, 'other', true, NOW));
  await assert.rejects(resolveCourseReviewBundle(staged, 'other', false, NOW));
});

void test('accept rejects a stale review with the explicit message', async () => {
  const staged = await stagedBundle();
  const changed = {
    ...staged,
    knowledge: {
      ...staged.knowledge,
      nodes: staged.knowledge.nodes.map((node) =>
        node.id === 'gen-a' ? { ...node, label: '改过的概念' } : node,
      ),
    },
  };
  await assert.rejects(
    resolveCourseReviewBundle(changed, 'review-1', true, LATER),
    (error: unknown) =>
      error instanceof Error &&
      error.message === '课程已变更，请保留原成果并重新生成候选版本。',
  );
});

void test('a stale review can still be discarded', async () => {
  const staged = await stagedBundle();
  const changedKnowledge = {
    ...staged.knowledge,
    nodes: staged.knowledge.nodes.map((node) =>
      node.id === 'gen-a' ? { ...node, label: '改过的概念' } : node,
    ),
  };
  const changed = { ...staged, knowledge: changedKnowledge };
  const discarded = await resolveCourseReviewBundle(
    changed,
    'review-1',
    false,
    LATER,
  );

  assert.strictEqual(discarded.knowledge, changedKnowledge);
  assert.strictEqual('pendingReview' in discarded.manifest, false);
  assert.strictEqual(discarded.manifest.activeKnowledgeVersion, 2);
});

void test('signature is canonical and sensitive to relevant changes', async () => {
  const current = baseBundle();
  const first = await courseReviewSignature(current, ['doc-b']);

  const reorderedKeys: CourseBundle = {
    ...current,
    knowledge: {
      nodes: current.knowledge.nodes.map((node) => ({ ...node })),
      schemaVersion: current.knowledge.schemaVersion,
      courseId: current.knowledge.courseId,
      version: current.knowledge.version,
      relations: current.knowledge.relations,
      conflicts: current.knowledge.conflicts,
      updatedAt: current.knowledge.updatedAt,
    },
    manifest: { ...current.manifest },
  };
  assert.strictEqual(
    await courseReviewSignature(reorderedKeys, ['doc-b']),
    first,
  );

  const arrayReordered: CourseBundle = {
    ...current,
    knowledge: {
      ...current.knowledge,
      nodes: [...current.knowledge.nodes].reverse(),
    },
  };
  assert.notStrictEqual(
    await courseReviewSignature(arrayReordered, ['doc-b']),
    first,
  );

  const newIncluded: CourseBundle = {
    ...current,
    manifest: {
      ...current.manifest,
      documents: [
        ...current.manifest.documents,
        document('doc-new', { includedInCourse: true }),
      ],
    },
  };
  assert.notStrictEqual(
    await courseReviewSignature(newIncluded, ['doc-b']),
    first,
  );

  const removedRelevant: CourseBundle = {
    ...current,
    manifest: {
      ...current.manifest,
      documents: current.manifest.documents.filter((doc) => doc.id !== 'doc-a'),
    },
  };
  assert.notStrictEqual(
    await courseReviewSignature(removedRelevant, ['doc-b']),
    first,
  );

  const newRaw: CourseBundle = {
    ...current,
    manifest: {
      ...current.manifest,
      documents: [...current.manifest.documents, document('doc-extra')],
    },
  };
  assert.strictEqual(await courseReviewSignature(newRaw, ['doc-b']), first);
});

void test('transitions never mutate the original bundle', async () => {
  const current = baseBundle();
  const snapshot = structuredClone(current);

  const staged = await stageCourseReviewBundle(
    current,
    ['doc-b'],
    aiKnowledge(),
    {
      id: 'review-1',
      now: NOW,
    },
  );
  assert.deepStrictEqual(current, snapshot);

  await resolveCourseReviewBundle(staged, 'review-1', true, LATER);
  assert.deepStrictEqual(current, snapshot);

  const stagedForDiscard = await stageCourseReviewBundle(
    current,
    ['doc-b'],
    aiKnowledge(),
    {
      id: 'review-2',
      now: NOW,
    },
  );
  await resolveCourseReviewBundle(stagedForDiscard, 'review-2', false, LATER);
  assert.deepStrictEqual(current, snapshot);
});

void test('generates a review id when none is supplied', async () => {
  const staged = await stageCourseReviewBundle(
    baseBundle(),
    ['doc-b'],
    aiKnowledge(),
    {
      now: NOW,
    },
  );
  const id = staged.manifest.pendingReview?.id;
  assert.strictEqual(typeof id, 'string');
  assert.ok((id ?? '').length > 0);
});
