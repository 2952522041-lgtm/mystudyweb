import assert from 'node:assert/strict';
import test from 'node:test';

import { createDocumentDigest } from '../lib/knowledge/document-digest.ts';
import {
  courseKnowledgeFromSingleDigest,
  SINGLE_DOCUMENT_REUSE_PROMPT_VERSION,
} from '../lib/knowledge/single-document-course.ts';
import type { DocumentDigest, SourceReference } from '../lib/course-storage/types.ts';

function source(
  documentId: string,
  fileName: string,
  pageStart: number,
  pageEnd = pageStart,
): SourceReference {
  return { documentId, fileName, pageStart, pageEnd, type: 'pdf' };
}

function aiDigest(overrides: Partial<DocumentDigest> = {}): DocumentDigest {
  const digest = createDocumentDigest({
    fingerprint: 'a'.repeat(64),
    fileName: 'lecture.pdf',
    pages: [
      'Chapter one explains the first concept with enough source text.',
      'Chapter two explains the second concept with enough source text.',
    ],
    now: '2026-09-29T00:00:00.000Z',
  });
  digest.schemaVersion = 3;
  digest.promptVersion = 'ai-digest-v11';
  digest.provider = 'openai-compatible-knowledge';
  digest.model = 'knowledge-model-x';
  digest.concepts = [
    {
      id: 'concept-root',
      parentId: null,
      label: '第一主题',
      description: '第一主题的完整解释。',
      sources: [source(digest.documentId, 'lecture.pdf', 1)],
    },
    {
      id: 'concept-child',
      parentId: 'concept-root',
      label: '第二主题',
      description: '第二主题的完整解释。',
      sources: [source(digest.documentId, 'lecture.pdf', 2)],
    },
  ];
  digest.relations = [
    { from: 'concept-root', to: 'concept-child', label: '包含' },
  ];
  digest.evidence = [
    {
      text: '保留的公式或关键原文。',
      sources: [source(digest.documentId, 'lecture.pdf', 2)],
    },
  ];
  digest.diagnostics = [
    {
      layer: 'document',
      action: 'request-timing',
      identity: digest.documentId,
      inputBytes: 100,
      outputBytes: 80,
      timing: {
        headersMs: 10,
        firstContentMs: 20,
        totalMs: 30,
        outputChars: 40,
        status: 'success',
      },
      limit: 1000,
      droppedItems: 0,
      droppedBytes: 0,
      detail: 'timing',
    },
  ];
  digest.unresolvedQuestions = ['第二主题的边界条件是什么？'];
  return { ...digest, ...overrides };
}

void test('reuses a complete AI digest without mutating or aliasing its data', () => {
  const digest = aiDigest();
  const before = structuredClone(digest);

  const result = courseKnowledgeFromSingleDigest([digest], []);

  assert.ok(result);
  assert.equal(result.theme, digest.overview);
  assert.equal(result.provider, digest.provider);
  assert.equal(result.model, digest.model);
  assert.equal(result.promptVersion, SINGLE_DOCUMENT_REUSE_PROMPT_VERSION);
  assert.deepEqual(result.nodes, digest.concepts);
  assert.deepEqual(result.relations, digest.relations);
  assert.deepEqual(result.evidence, digest.evidence);
  assert.deepEqual(result.diagnostics, digest.diagnostics);
  assert.deepEqual(result.unresolvedQuestions, digest.unresolvedQuestions);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(digest, before);

  assert.notStrictEqual(result.nodes, digest.concepts);
  assert.notStrictEqual(result.nodes[0]!.sources, digest.concepts[0]!.sources);
  assert.notStrictEqual(result.relations, digest.relations);
  assert.notStrictEqual(result.evidence, digest.evidence);
  assert.notStrictEqual(
    result.evidence![0]!.sources,
    digest.evidence![0]!.sources,
  );
  assert.notStrictEqual(result.diagnostics, digest.diagnostics);
  assert.notStrictEqual(
    result.diagnostics![0]!.timing,
    digest.diagnostics![0]!.timing,
  );
  result.nodes[0]!.sources[0]!.pageStart = 2;
  result.relations[0]!.label = '依赖';
  result.evidence![0]!.sources[0]!.pageStart = 1;
  result.unresolvedQuestions.push('新增问题');
  assert.deepEqual(digest, before);
});

void test('rejects old or incomplete digests and lets the provider handle them', () => {
  const base = aiDigest();
  const invalid: Array<[string, DocumentDigest]> = [
    ['old schema', { ...base, schemaVersion: 2 }],
    ['missing provider', { ...base, provider: undefined }],
    ['missing model', { ...base, model: undefined }],
    ['empty concepts', { ...base, concepts: [] }],
    ['invalid unresolved questions', { ...base, unresolvedQuestions: [42] as never }],
    ['local non-AI prompt', { ...base, promptVersion: 'local-structure-v1' }],
  ];
  for (const [name, digest] of invalid) {
    assert.equal(courseKnowledgeFromSingleDigest([digest], []), null, name);
  }
});

void test('rejects isolated, cyclic, malformed-source, and bad-relation digests', () => {
  const cases: Array<[string, (digest: DocumentDigest) => void]> = [
    [
      'isolated parent',
      (digest) => {
        digest.concepts[1]!.parentId = 'missing';
      },
    ],
    [
      'cycle',
      (digest) => {
        digest.concepts[0]!.parentId = 'concept-child';
      },
    ],
    [
      'source from another document',
      (digest) => {
        digest.concepts[0]!.sources[0]!.documentId = 'doc-other';
      },
    ],
    [
      'source outside page range',
      (digest) => {
        digest.concepts[0]!.sources[0]!.pageStart = 99;
      },
    ],
    [
      'unknown relation endpoint',
      (digest) => {
        digest.relations.push({
          from: 'missing',
          to: 'concept-child',
          label: '关联',
        });
      },
    ],
    [
      'self relation',
      (digest) => {
        digest.relations.push({
          from: 'concept-child',
          to: 'concept-child',
          label: '关联',
        });
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    const digest = aiDigest();
    mutate(digest);
    assert.equal(courseKnowledgeFromSingleDigest([digest], []), null, name);
  }
});

void test('falls back for multiple documents or any user-created node', () => {
  const first = aiDigest();
  const second = aiDigest({
    documentId: 'doc-bbbbbbbbbbbbbbbb',
    fingerprint: 'b'.repeat(64),
    title: 'lecture-2',
    concepts: [
      {
        id: 'second-root',
        parentId: null,
        label: '另一主题',
        description: '另一份文档的主题。',
        sources: [source('doc-bbbbbbbbbbbbbbbb', 'lecture-2.pdf', 1)],
      },
    ],
    relations: [],
  });

  assert.equal(courseKnowledgeFromSingleDigest([first, second], []), null);
  assert.equal(courseKnowledgeFromSingleDigest([first], ['用户节点']), null);
});
