import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { YeyuDesktopApi } from '../electron/api.ts';
import {
  createCourseDirectory,
  courseFileExists,
  ensureCourseDirectory,
  ensureWorkspace,
  readCourseFile,
  scanCourses,
  writeCourseFile,
} from '../electron/workspace.ts';
import { resolveWorkspaceLayout } from '../electron/workspace-paths.ts';
import { DesktopCourseStorage } from '../lib/course-storage/desktop-course-storage.ts';
import type { DocumentDigest, ImportOptions } from '../lib/course-storage/types.ts';

/** 用真实的 workspace 文件层模拟主进程 IPC，验证 DesktopCourseStorage 端到端行为。 */
class FakeWorkspaceApi implements YeyuDesktopApi {
  private layout;

  constructor(root: string) {
    this.layout = resolveWorkspaceLayout(root);
  }

  async getWorkspaceInfo() {
    await ensureWorkspace(this.layout);
    return { root: this.layout.root, coursesRoot: this.layout.coursesRoot };
  }

  listCourses() {
    return scanCourses(this.layout.coursesRoot);
  }

  createCourseDirectory(name: string) {
    return createCourseDirectory(this.layout.coursesRoot, name);
  }

  exists(courseDirectory: string, relativePath: string[]) {
    return courseFileExists(
      this.layout.coursesRoot,
      courseDirectory,
      relativePath,
    );
  }

  ensureDirectory(courseDirectory: string, relativePath: string[]) {
    return ensureCourseDirectory(
      this.layout.coursesRoot,
      courseDirectory,
      relativePath,
    );
  }

  readFile(courseDirectory: string, relativePath: string[]) {
    return readCourseFile(
      this.layout.coursesRoot,
      courseDirectory,
      relativePath,
    );
  }

  writeFile(
    courseDirectory: string,
    relativePath: string[],
    data: Uint8Array,
  ) {
    return writeCourseFile(
      this.layout.coursesRoot,
      courseDirectory,
      relativePath,
      data,
    );
  }

  async revealWorkspace() {}
}

function makeDigest(overrides: Partial<DocumentDigest> = {}): DocumentDigest {
  return {
    schemaVersion: 1,
    documentId: 'doc-test000000000000',
    fingerprint: 'fingerprint-test0000000001',
    title: '测试讲义',
    overview: '这是一份测试讲义。',
    sections: [],
    concepts: [
      {
        id: 'concept-1',
        label: '极限',
        description: '极限的 ε-δ 定义。',
        sources: [
          {
            documentId: 'doc-test000000000000',
            fileName: '讲义.pdf',
            pageStart: 3,
            type: 'pdf',
          },
        ],
      },
    ],
    relations: [],
    unresolvedQuestions: [],
    sourcePages: [3],
    promptVersion: 'local-structure-v1',
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

const importOptions: ImportOptions = {
  generateSummary: true,
  generateMindmap: true,
  mergeIntoCourse: true,
  includeConversationInsights: false,
};

function pdfFile(name = '讲义.pdf', body = 'fake-pdf-bytes'): File {
  return new File([new TextEncoder().encode(body)], name, {
    type: 'application/pdf',
  });
}

void test('desktop storage initialize writes a recoverable course bundle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-desktop-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('MAT3007');
    const storage = new DesktopCourseStorage(api, directoryName);
    const bundle = await storage.initialize('MAT3007');

    assert.equal(bundle.manifest.name, 'MAT3007');
    assert.equal(bundle.manifest.revision, 0);
    assert.equal(storage.label, directoryName);

    const files = await readdir(
      path.join(resolveWorkspaceLayout(root).coursesRoot, directoryName),
    );
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
      assert.ok(files.includes(artifact), `missing artifact ${artifact}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('desktop storage import, scan recovery, conflict and history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-desktop-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('MAT3007');
    const storage = new DesktopCourseStorage(api, directoryName);
    const initial = await storage.initialize('MAT3007');
    const digest = makeDigest();

    const result = await storage.importDocument(
      pdfFile(),
      digest,
      importOptions,
      initial.manifest.revision,
    );
    assert.equal(result.bundle.manifest.revision, 1);
    assert.equal(result.document.status, 'course-merged');
    assert.equal(result.bundle.knowledge.version, 1);

    const courseRoot = path.join(
      resolveWorkspaceLayout(root).coursesRoot,
      directoryName,
    );
    const storedPdf = await readFile(
      path.join(courseRoot, 'PDFs', result.document.storedFileName),
    );
    assert.equal(new TextDecoder().decode(storedPdf), 'fake-pdf-bytes');
    const documentJson = JSON.parse(
      await readFile(
        path.join(courseRoot, 'Documents', result.document.id, 'document.json'),
        'utf8',
      ),
    );
    assert.equal(documentJson.title, '测试讲义');
    const historyEntries = await readdir(path.join(courseRoot, 'History'));
    assert.ok(historyEntries[0].startsWith('revision-0-'));

    // 重新扫描（等价于桌面端重启）后课程可以完整恢复。
    const scanned = await api.listCourses();
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0]?.manifest.revision, 1);
    const revived = new DesktopCourseStorage(api, directoryName);
    const reloaded = await revived.load();
    assert.equal(reloaded.knowledge.nodes.length, 2);

    // 重复导入同一指纹会被拒绝。
    await assert.rejects(
      () =>
        storage.importDocument(pdfFile(), digest, importOptions, 1),
      /已经在课程中/,
    );

    // revision 冲突保护。
    await assert.rejects(
      () =>
        storage.mergeDocument(result.document.id, 0),
      /外部修改/,
    );

    // 正确 revision 的 merge 会推进版本。
    const merged = await storage.mergeDocument(result.document.id, 1);
    assert.equal(merged.manifest.revision, 2);

    const opened = await revived.openPdf(result.document.id);
    assert.equal(opened.size, 'fake-pdf-bytes'.length);
    assert.equal(opened.name, '讲义.pdf');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('desktop storage refuses to write artifact content that embeds keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-desktop-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('安全测试');
    const storage = new DesktopCourseStorage(api, directoryName);
    const initial = await storage.initialize('安全测试');
    const leaky = makeDigest({
      documentId: 'doc-leak000000000000',
      fingerprint: 'fingerprint-leak000000001',
      overview: '密钥 sk-abcdef1234567890abcdef 泄漏测试。',
    });
    await assert.rejects(
      () =>
        storage.importDocument(pdfFile(), leaky, importOptions, initial.manifest.revision),
      /服务密钥/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('course library keeps both browser and desktop modes available', async () => {
  const library = await readFile(
    new URL('../components/course-library.tsx', import.meta.url),
    'utf8',
  );

  // 桌面模式接入。
  for (const requirement of [
    'window.yeyuDesktop',
    'DesktopCourseStorage',
    'getWorkspaceInfo',
    'revealWorkspace',
  ]) {
    assert.match(library, new RegExp(requirement));
  }
  // 不再把 storage 写死成浏览器实现。
  assert.match(library, /storage: CourseStorage;/);
  assert.doesNotMatch(library, /storage: BrowserDirectoryStorage/);
  // 浏览器模式行为保持不变。
  for (const requirement of [
    'showDirectoryPicker',
    'BrowserDirectoryStorage',
    'requestPermission',
    'saveRecentCourse',
  ]) {
    assert.match(library, new RegExp(requirement));
  }
});
