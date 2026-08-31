import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSafeArtifactContent,
  sanitizeFileName,
  suffixFileName,
} from '../lib/course-storage/file-utils.ts';
import { MemoryCourseStorage } from '../lib/course-storage/memory-course-storage.ts';
import type {
  CourseKnowledge,
  DocumentDigest,
} from '../lib/course-storage/types.ts';
import {
  renderCourseSummary,
  renderDocumentSummary,
  renderKnowledgeSvg,
} from '../lib/knowledge/artifact-renderer.ts';
import {
  emptyCourseKnowledge,
  mergeDocumentDigest,
  removeDocumentContribution,
} from '../lib/knowledge/course-merger.ts';
import { createDocumentDigest } from '../lib/knowledge/document-digest.ts';

function digest(
  fingerprint: string,
  fileName: string,
  pages: string[],
): DocumentDigest {
  return createDocumentDigest({
    fingerprint,
    fileName,
    pages,
    now: '2026-08-31T00:00:00.000Z',
  });
}

void test('course file utilities sanitize platform characters and block secrets', () => {
  assert.equal(
    sanitizeFileName(' chapter:1?/intro.pdf '),
    'chapter_1__intro.pdf',
  );
  assert.equal(sanitizeFileName('\u0001.'), '_');
  assert.equal(
    suffixFileName('lecture.pdf', 'abcd1234'),
    'lecture-abcd1234.pdf',
  );
  assert.doesNotThrow(() => assertSafeArtifactContent('# 普通课程总结'));
  assert.doesNotThrow(() =>
    assertSafeArtifactContent(
      'This chapter explains how to configure an API Key.',
    ),
  );
  assert.throws(
    () =>
      assertSafeArtifactContent('Authorization: Bearer sk-secret-value-123'),
    /服务密钥/,
  );
});

void test('local document digest keeps page-scoped sections and sources', () => {
  const result = digest('a'.repeat(64), 'Linear Models.pdf', [
    '1 Linear Models\nA linear model represents the prediction as a weighted sum.',
    '2 Gradient Descent\nGradient descent updates parameters in the negative gradient direction.',
  ]);

  assert.equal(result.documentId, `doc-${'a'.repeat(16)}`);
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[1].pageStart, 2);
  assert.ok(result.concepts.length >= 2);
  assert.equal(result.concepts[0].sources[0].fileName, 'Linear Models.pdf');
  assert.deepEqual(result.sourcePages, [1, 2]);
});

void test('incremental merge deduplicates concepts, appends sources and preserves user nodes', () => {
  const first = digest('a'.repeat(64), 'Lecture 1.pdf', [
    'Gradient Descent\nShort description.',
  ]);
  const second = digest('b'.repeat(64), 'Lecture 2.pdf', [
    'Gradient Descent\nA longer description about optimization.',
  ]);
  first.concepts = [
    {
      id: 'gradient-a',
      label: 'Gradient Descent',
      description: 'PDF one explanation',
      sources: [
        {
          documentId: first.documentId,
          fileName: 'Lecture 1.pdf',
          pageStart: 1,
          type: 'pdf',
        },
      ],
    },
  ];
  second.concepts = [
    {
      id: 'gradient-b',
      label: 'Gradient  Descent',
      description: 'PDF two contains a longer explanation of this concept',
      sources: [
        {
          documentId: second.documentId,
          fileName: 'Lecture 2.pdf',
          pageStart: 1,
          type: 'pdf',
        },
      ],
    },
  ];

  let knowledge = emptyCourseKnowledge('course-1', '机器学习');
  knowledge = mergeDocumentDigest(knowledge, first);
  knowledge.nodes[1].ownership = 'user';
  knowledge.nodes[1].description = '我的理解，不能被自动覆盖';
  knowledge = mergeDocumentDigest(knowledge, second);

  const concept = knowledge.nodes.find((node) => node.kind === 'concept')!;
  assert.equal(
    knowledge.nodes.filter((node) => node.kind === 'concept').length,
    1,
  );
  assert.equal(concept.sources.length, 2);
  assert.equal(concept.description, '我的理解，不能被自动覆盖');

  const removed = removeDocumentContribution(knowledge, first.documentId);
  assert.equal(
    removed.nodes.find((node) => node.id === concept.id)?.sources.length,
    1,
  );
});

void test('memory storage enforces fingerprint dedupe and optimistic revisions', async () => {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('机器学习');
  const documentDigest = digest('c'.repeat(64), 'Lecture.pdf', [
    'Optimization\nLoss and gradient.',
  ]);
  const file = new File(['pdf-content'], 'Lecture.pdf', {
    type: 'application/pdf',
  });

  const imported = await storage.importDocument(
    file,
    documentDigest,
    {
      generateSummary: false,
      generateMindmap: false,
      mergeIntoCourse: false,
      includeConversationInsights: true,
    },
    initial.manifest.revision,
  );
  assert.equal(imported.document.status, 'digested');
  assert.equal(imported.bundle.knowledge.version, 0);

  await assert.rejects(
    storage.importDocument(
      file,
      documentDigest,
      {
        generateSummary: true,
        generateMindmap: true,
        mergeIntoCourse: true,
        includeConversationInsights: true,
      },
      imported.bundle.manifest.revision,
    ),
    /未重复导入/,
  );

  const artifacts = await storage.updateDocumentArtifacts(
    imported.document.id,
    imported.bundle.manifest.revision,
  );
  assert.equal(artifacts.manifest.documents[0].hasSummary, true);
  const merged = await storage.mergeDocument(
    imported.document.id,
    artifacts.manifest.revision,
  );
  assert.equal(merged.manifest.documents[0].includedInCourse, true);
  assert.ok(merged.knowledge.nodes.length > 1);

  await assert.rejects(
    storage.mergeDocument(imported.document.id, initial.manifest.revision),
    /外部修改/,
  );
});

void test('artifact renderers produce portable Markdown and SVG with sources', async () => {
  const storage = new MemoryCourseStorage();
  const bundle = await storage.initialize('概率论');
  const documentDigest = digest('d'.repeat(64), 'Probability.pdf', [
    'Sample Space\nEvents and probability measures.',
  ]);
  const knowledge: CourseKnowledge = mergeDocumentDigest(
    bundle.knowledge,
    documentDigest,
  );
  const manifest = {
    ...bundle.manifest,
    activeKnowledgeVersion: knowledge.version,
  };

  const documentMarkdown = renderDocumentSummary(documentDigest);
  const courseMarkdown = renderCourseSummary(manifest, knowledge);
  const svg = renderKnowledgeSvg(manifest, knowledge);

  assert.match(documentMarkdown, /来源：第 1 页/);
  assert.match(courseMarkdown, /Probability\.pdf · 第 1 页/);
  assert.match(svg, /^<svg/);
  assert.match(svg, /概率论/);
  assert.doesNotMatch(
    `${documentMarkdown}${courseMarkdown}${svg}`,
    /api[_-]?key/i,
  );
});
