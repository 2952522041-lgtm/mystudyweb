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
    'resolvePageOcr',
    '视觉模型识别',
  ]) {
    assert.match(library, new RegExp(requirement));
  }
});

void test('course deletion is desktop-only, confirmed and routed through the safe bridge', async () => {
  const [library, main, workspace] = await Promise.all([
    read('../components/course-library.tsx'),
    read('../electron/main.ts'),
    read('../electron/workspace.ts'),
  ]);

  for (const requirement of [
    // UI：确认对话框 + 明确说明数据去向，不能一击即删。
    '删除课程',
    '移入系统回收站',
    '移入回收站',
    'deleteCourseDirectory',
  ]) {
    assert.match(library, new RegExp(requirement));
  }
  // 删除入口只在桌面模式出现：浏览器模式没有删除用户文件夹的权限。
  assert.match(
    library,
    /isDesktop \? \(\s*<Button[^>]*variant="destructive"[\s\S]*?删除课程/,
  );

  // 主进程：删除走回收站而不是直接 rm，且目标必须先通过路径校验。
  assert.match(main, /resolveDeletableCourseDirectory/);
  assert.match(main, /shell\.trashItem/);
  // 校验层：只允许 Courses 根的直接子目录，并拒绝符号链接。
  assert.match(workspace, /assertKnownCourseDirectory\(directoryName\)/);
  assert.match(workspace, /lstat/);
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
