import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCourseAiContext } from '../lib/course-ai-context.ts';
import { loadSharedCourseAiContext } from '../lib/host-shared-actions.ts';
import type {
  CourseBundle,
  CourseStorage,
  DocumentRecord,
} from '../lib/course-storage/types.ts';
import type { Glossary } from '../lib/glossary.ts';

function documentRecord(id: string, fingerprint: string): DocumentRecord {
  return {
    id,
    fingerprint,
    fileName: 'lecture.pdf',
    storedFileName: 'lecture.pdf',
    pageCount: 1,
    status: 'course-merged',
    includedInCourse: true,
    includeConversationInsights: true,
    hasSummary: true,
    hasMindmap: true,
    importedAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
}

function courseBundle(document: DocumentRecord): CourseBundle {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'course-shared',
      name: '共享课程',
      revision: 2,
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:00:00.000Z',
      activeKnowledgeVersion: 1,
      documents: [document],
    },
    knowledge: {
      schemaVersion: 3,
      courseId: 'course-shared',
      version: 1,
      nodes: [
        {
          id: 'course-root',
          label: '统计学基础',
          description: '课程介绍概率、抽样与估计。',
          kind: 'course',
          ownership: 'generated',
          sources: [],
        },
      ],
      relations: [],
      conflicts: [],
      updatedAt: '2026-09-29T00:00:00.000Z',
    },
    digests: {},
  };
}

function storageFor(bundle: CourseBundle, glossary: Glossary): CourseStorage {
  return {
    label: 'test',
    load: async () => structuredClone(bundle),
    loadGlossary: async () => structuredClone(glossary),
  } as unknown as CourseStorage;
}

void test('shared host context uses the matching course bundle and glossary', async () => {
  const document = documentRecord('doc-1', 'fingerprint-1');
  const bundle = courseBundle(document);
  const glossary: Glossary = {
    schemaVersion: 1,
    version: 1,
    entries: [{ source: 'sampling', target: '抽样', forbidden: [], note: '' }],
  };
  const context = await loadSharedCourseAiContext({
    storage: storageFor(bundle, glossary),
    document,
  });

  assert.equal(context, buildCourseAiContext(bundle, glossary));
  assert.match(context, /course-shared/);
  assert.match(context, /sampling → 抽样/);
});

void test('shared host context is empty for a stale or mismatched document', async () => {
  const storedDocument = documentRecord('stored-doc', 'stored-fingerprint');
  const requestedDocument = documentRecord(
    'requested-doc',
    'requested-fingerprint',
  );
  const context = await loadSharedCourseAiContext({
    storage: storageFor(courseBundle(storedDocument), {
      schemaVersion: 1,
      version: 1,
      entries: [
        { source: 'secret-term', target: '不应泄漏', forbidden: [], note: '' },
      ],
    }),
    document: requestedDocument,
  });

  assert.equal(context, '');
  assert.doesNotMatch(context, /secret-term|course-shared/);
});

void test('shared host context is empty when course storage cannot be read', async () => {
  const document = documentRecord('doc-1', 'fingerprint-1');
  const storage = {
    label: 'broken',
    load: async () => {
      throw new Error('directory unavailable');
    },
  } as unknown as CourseStorage;

  assert.equal(await loadSharedCourseAiContext({ storage, document }), '');
});

void test('shared host context keeps the course summary when glossary read fails', async () => {
  const document = documentRecord('doc-1', 'fingerprint-1');
  const bundle = courseBundle(document);
  const storage = {
    label: 'glossary-unavailable',
    load: async () => structuredClone(bundle),
    loadGlossary: async () => {
      throw new Error('glossary unavailable');
    },
  } as unknown as CourseStorage;

  assert.equal(
    await loadSharedCourseAiContext({ storage, document }),
    buildCourseAiContext(bundle),
  );
});
