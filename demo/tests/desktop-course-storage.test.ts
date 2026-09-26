import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { YeyuDesktopApi } from '../electron/api.ts';
import {
  createCourseDirectory,
  courseFileExists,
  deleteCourseEntry,
  ensureCourseDirectory,
  ensureWorkspace,
  listCourseFiles,
  readCourseFile,
  removeCourseDirectory,
  scanCourses,
  writeCourseFile,
} from '../electron/workspace.ts';
import { resolveWorkspaceLayout } from '../electron/workspace-paths.ts';
import { DesktopCourseStorage } from '../lib/course-storage/desktop-course-storage.ts';
import {
  publishCachedTranslation,
  sharedTranslationFromCache,
  type SharedTranslationRecord,
} from '../lib/shared-translation.ts';
import {
  createMemoryStore,
  createTranslationCache,
  type CachedTranslation,
} from '../lib/reader-cache.ts';
import type {
  DocumentDigest,
  ImportOptions,
} from '../lib/course-storage/types.ts';

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

  listFiles(courseDirectory: string, relativePath: string[]) {
    return listCourseFiles(
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

  writeFile(courseDirectory: string, relativePath: string[], data: Uint8Array) {
    return writeCourseFile(
      this.layout.coursesRoot,
      courseDirectory,
      relativePath,
      data,
    );
  }

  deleteFile(courseDirectory: string, relativePath: string[]) {
    return deleteCourseEntry(
      this.layout.coursesRoot,
      courseDirectory,
      relativePath,
    );
  }

  deleteCourseDirectory(courseDirectory: string) {
    return removeCourseDirectory(this.layout.coursesRoot, courseDirectory);
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

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, relative);
      } else if (entry.isFile()) {
        snapshot[relative] = createHash('sha256')
          .update(await readFile(fullPath))
          .digest('hex');
      }
    }
  };
  await visit(root, '');
  return snapshot;
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
      () => storage.importDocument(pdfFile(), digest, importOptions, 1),
      /已经在课程中/,
    );

    // revision 冲突保护。
    await assert.rejects(
      () => storage.mergeDocument(result.document.id, 0),
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
        storage.importDocument(
          pdfFile(),
          leaky,
          importOptions,
          initial.manifest.revision,
        ),
      /服务密钥/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('desktop storage publishes versioned translations without changing course artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-translations-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('翻译课程');
    const storage = new DesktopCourseStorage(api, directoryName);
    const initial = await storage.initialize('翻译课程');
    const digest = makeDigest({
      documentId: 'doc-translation000001',
      fingerprint: 'fingerprint-translation000001',
      sourcePages: [1, 2],
    });
    const imported = await storage.importDocument(
      pdfFile('翻译讲义.pdf'),
      digest,
      importOptions,
      initial.manifest.revision,
    );
    const courseRoot = path.join(
      resolveWorkspaceLayout(root).coursesRoot,
      directoryName,
    );
    const before = await snapshotFiles(courseRoot);
    const cache =
      createTranslationCache(createMemoryStore<CachedTranslation>());
    await cache.save({
      key: '',
      fingerprint: digest.fingerprint,
      pageNumber: 1,
      sourceHash: '1'.repeat(64),
      paragraphs: ['第一页缓存译文。'],
      targetLanguage: '简体中文',
      provider: 'test-provider',
      model: 'test-model',
      updatedAt: '2026-09-10T02:00:00.000Z',
    });
    await cache.save({
      key: '',
      fingerprint: digest.fingerprint,
      pageNumber: 2,
      sourceHash: '2'.repeat(64),
      paragraphs: ['第二页日本語译文。'],
      targetLanguage: '日本語',
      provider: 'test-provider',
      model: 'test-model',
      updatedAt: '2026-09-10T02:01:00.000Z',
    });
    const cached = await cache.list();
    assert.equal(cached.length, 2, '缓存命中后应可枚举待发布译文');
    await Promise.all(
      cached.map((entry) =>
        publishCachedTranslation(storage, entry, digest.documentId),
      ),
    );
    // Repeating the operation overwrites the same hashed records and does not
    // create duplicate files or change course revision/artifacts.
    await storage.publishTranslation(
      digest.documentId,
      sharedTranslationFromCache(cached[0]!, digest.documentId),
    );
    // A new storage instance models reopening the app after IndexedDB has
    // been cleared: published records are recovered from the course folder.
    const restartedStorage = new DesktopCourseStorage(api, directoryName);
    const restored = await restartedStorage.listTranslations(digest.documentId);
    assert.equal(restored.length, 2);
    assert.equal(restored[0]?.fingerprint, digest.fingerprint);
    assert.ok(restored.some((record) => record.targetLanguage === '日本語'));
    const after = await snapshotFiles(courseRoot);
    const existingAfter = Object.fromEntries(
      Object.entries(after).filter(
        ([file]) => !file.startsWith('Translations/'),
      ),
    );
    assert.deepEqual(existingAfter, before);
    const translationFiles = Object.keys(after).filter((file) =>
      file.startsWith('Translations/'),
    );
    assert.equal(translationFiles.length, 2);
    assert.equal(
      (await storage.load()).manifest.revision,
      imported.bundle.manifest.revision,
    );
    for (const file of translationFiles) {
      const record = JSON.parse(
        await readFile(path.join(courseRoot, file), 'utf8'),
      ) as SharedTranslationRecord;
      assert.equal(record.documentId, digest.documentId);
      assert.equal(record.fingerprint, digest.fingerprint);
      for (const forbidden of [
        'sourceText',
        'ocrImage',
        'apiKey',
        'conversation',
      ]) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(record, forbidden),
          false,
          `译文记录不应包含 ${forbidden}`,
        );
      }
    }
    await assert.rejects(
      () =>
        storage.publishTranslation(
          digest.documentId,
          sharedTranslationFromCache(
            {
              ...cached[0]!,
              provider: 'mock',
            },
            digest.documentId,
          ),
        ),
      /演示译文不能发布/,
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
  // 课程与 PDF 的删除能力在 UI 层接线，且带确认流程。
  for (const requirement of [
    'removeDocument',
    'deleteCourse',
    'removeRecentCourse',
    'synthesizeCourseKnowledge',
    '删除课程',
    '删除这份 PDF',
    '删除整门课程',
  ]) {
    assert.match(library, new RegExp(requirement));
  }
});

void test('desktop glossary lives in course directory and survives adapter recreation', async () => {
  const { EMPTY_GLOSSARY, reviseGlossary } = await import('../lib/glossary.ts');
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-glossary-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('术语课程');
    const storage = new DesktopCourseStorage(api, directoryName);
    await storage.initialize('术语课程');
    assert.deepEqual(await storage.loadGlossary(), EMPTY_GLOSSARY);
    const glossary = reviseGlossary(EMPTY_GLOSSARY, [{ source: 'mass', target: '质量', forbidden: ['群众'], note: '' }]);
    const before = await storage.load();
    await storage.saveGlossary(glossary);
    assert.deepEqual(await new DesktopCourseStorage(api, directoryName).loadGlossary(), glossary);
    assert.deepEqual(await storage.load(), before);
    await api.writeFile(directoryName, ['glossary.json'], new TextEncoder().encode('{bad'));
    await assert.rejects(storage.loadGlossary());
  } finally { await rm(root, { recursive: true, force: true }); }
});
