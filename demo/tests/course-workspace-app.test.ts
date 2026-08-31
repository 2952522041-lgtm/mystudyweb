import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

void test('production app exposes the course workspace and reader handoff', async () => {
  const [page, library] = await Promise.all([
    read('../app/page.tsx'),
    read('../components/course-library.tsx'),
  ]);

  for (const requirement of [
    'CourseLibrary',
    '课程知识库',
    'PDF 总结',
    'PDF 脑图',
    'initialPage',
    'onOpenCourses',
  ]) {
    assert.match(page, new RegExp(requirement));
  }
  for (const requirement of [
    '创建本地课程',
    '连接已有课程',
    '尚未纳入课程知识库',
    'mergeDocument',
    'updateDocumentArtifacts',
    'openPdf',
  ]) {
    assert.match(library, new RegExp(requirement));
  }
});

void test('directory storage writes recoverable artifacts and never receives settings', async () => {
  const [storage, types] = await Promise.all([
    read('../lib/course-storage/browser-directory-storage.ts'),
    read('../lib/course-storage/types.ts'),
  ]);

  for (const artifact of [
    'course.json',
    '课程总结.md',
    '课程脑图.json',
    '课程脑图.svg',
    '我的课程笔记.md',
    'PDFs',
    'Documents',
    'History',
    'Knowledge',
  ]) {
    assert.match(storage, new RegExp(artifact));
  }
  assert.match(storage, /assertRevision/);
  assert.match(storage, /createRevision/);
  assert.doesNotMatch(types, /apiKey|baseUrl|bearer/i);
});

void test('Sites hosting metadata keeps database bindings optional', async () => {
  const [hosting, vite] = await Promise.all([
    read('../.openai/hosting.json'),
    read('../vite.config.ts'),
  ]);
  const metadata = JSON.parse(hosting) as Record<string, unknown>;

  assert.equal(typeof metadata.project_id, 'string');
  assert.deepEqual(Object.keys(metadata), ['project_id']);
  assert.match(vite, /d1\?: string/);
  assert.match(vite, /r2\?: string/);
});
