import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendStudyNote,
  artifactStatus,
  compareKnowledge,
  noteMarkdown,
  selectStudyDocuments,
  withLocalWriteLock,
} from '../lib/course-storage/study-tools.ts';
import { MemoryCourseStorage } from '../lib/course-storage/memory-course-storage.ts';
import type {
  CourseKnowledge,
  DocumentRecord,
} from '../lib/course-storage/types.ts';
import type { DocumentProgress } from '../lib/reader-cache.ts';

const record = (
  id: string,
  name: string,
  importedAt: string,
): DocumentRecord => ({
  id,
  fingerprint: id,
  fileName: name,
  storedFileName: name,
  importedAt,
  updatedAt: importedAt,
  hasSummary: false,
  hasMindmap: false,
  includedInCourse: false,
  includeConversationInsights: false,
  status: 'copied',
  pageCount: 10,
});

void test('artifact status represents summary and mindmap independently', () => {
  assert.equal(
    artifactStatus({ hasSummary: true, hasMindmap: false }),
    '总结已生成 · 脑图未生成',
  );
  assert.equal(
    artifactStatus({ hasSummary: false, hasMindmap: true }),
    '脑图已生成 · 总结未生成',
  );
  assert.equal(
    artifactStatus({ hasSummary: true, hasMindmap: true }),
    '总结与脑图已生成',
  );
  assert.equal(
    artifactStatus({ hasSummary: false, hasMindmap: false }),
    '未生成独立成果',
  );
});

void test('documents search case insensitively and sort by latest reading with import fallback', () => {
  const documents = [
    record('a', 'Lesson 10.pdf', '2026-01-01'),
    record('b', 'Lesson 2.pdf', '2026-01-03'),
    record('c', '补充.pdf', '2026-01-02'),
  ];
  const progress = [
    { fingerprint: 'a', updatedAt: '2026-02-01' },
  ] as DocumentProgress[];
  assert.deepEqual(
    selectStudyDocuments(documents, progress).map((item) => item.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    selectStudyDocuments(documents, progress, 'LESSON', 'name').map(
      (item) => item.id,
    ),
    ['b', 'a'],
  );
  assert.deepEqual(
    selectStudyDocuments(documents, progress, '', 'recent-import').map(
      (item) => item.id,
    ),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(
    documents.map((item) => item.id),
    ['a', 'b', 'c'],
    'does not mutate course manifest order',
  );
  assert.deepEqual(selectStudyDocuments(documents, progress, 'missing'), []);
});

void test('saving an artifact preserves existing notes, source range and timestamp', async () => {
  const storage = new MemoryCourseStorage();
  await storage.initialize('Test');
  await storage.saveNotes('个人笔记', (await storage.loadNotes()).token);
  await appendStudyNote(storage, {
    text: '$$E=mc^2$$',
    sources: [
      {
        documentId: 'a',
        fileName: 'physics.pdf',
        pageStart: 3,
        pageEnd: 5,
        type: 'pdf',
      },
    ],
  });
  const notes = await storage.loadNotes();
  assert.match(notes.content, /^个人笔记/);
  assert.match(notes.content, /\$\$E=mc\^2\$\$/);
  assert.match(notes.content, /physics.pdf · 第 3–5 页/);
  assert.match(notes.content, /记录时间：\d{4}-/);
  assert.match(
    noteMarkdown({ text: '说明' }, '2026-01-01T00:00:00Z'),
    /2026-01-01T00:00:00Z/,
  );
});

void test('stale and simultaneous note writes do not overwrite a newer edit', async () => {
  const storage = new MemoryCourseStorage();
  await storage.initialize('Test');
  const initial = await storage.loadNotes();
  await storage.saveNotes('外部修改', initial.token);
  await assert.rejects(storage.saveNotes('旧草稿', initial.token), /外部修改/);
  assert.equal((await storage.loadNotes()).content, '外部修改');
  const snapshot = await storage.loadNotes();
  const results = await Promise.allSettled([
    storage.saveNotes('窗口一', snapshot.token),
    storage.saveNotes('窗口二', snapshot.token),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal((await storage.loadNotes()).content, '窗口一');
  await assert.rejects(
    appendStudyNote(storage, { text: 'bearer abcdefghijklmnopqrstuvwxyz' }),
    /服务密钥/,
  );
});

void test('write queue releases after failures', async () => {
  const owner = {};
  const order: number[] = [];
  const values = await Promise.allSettled([
    withLocalWriteLock(owner, async () => {
      order.push(1);
      throw Error('failure');
    }),
    withLocalWriteLock(owner, async () => {
      order.push(2);
      return 2;
    }),
  ]);
  assert.equal(values[1].status, 'fulfilled');
  assert.deepEqual(order, [1, 2]);
});

void test('history comparison reports additions removals edits and unresolved questions', () => {
  const node = (id: string, description = id) => ({
    id,
    label: id,
    description,
    kind: 'concept' as const,
    ownership: 'generated' as const,
    sources: [],
  });
  const before: CourseKnowledge = {
    schemaVersion: 3,
    courseId: 'c',
    version: 1,
    updatedAt: '2026',
    nodes: [node('keep'), node('edit'), node('remove')],
    relations: [],
    conflicts: [],
    unresolvedQuestions: ['旧问题'],
  };
  const after = {
    ...before,
    version: 2,
    nodes: [node('keep'), node('edit', '新说明'), node('add')],
    relations: [{ from: 'keep', to: 'edit', label: '依赖' }],
    unresolvedQuestions: ['新问题'],
  };
  const result = compareKnowledge(before, after);
  assert.deepEqual(
    result.added.map((node) => node.id),
    ['add'],
  );
  assert.deepEqual(
    result.removed.map((node) => node.id),
    ['remove'],
  );
  assert.deepEqual(
    result.changed.map((node) => node.id),
    ['edit'],
  );
  assert.deepEqual(result.questionsAdded, ['新问题']);
  assert.deepEqual(result.questionsRemoved, ['旧问题']);
  assert.deepEqual(result.relationsAdded, after.relations);
  assert.equal(result.relationsRemoved.length, 0);
});
