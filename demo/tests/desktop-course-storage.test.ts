import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { YeyuDesktopApi } from '../electron/api.ts';
import { CourseLocks } from '../electron/course-locks.ts';
import { BackgroundImports } from '../lib/background-imports.ts';
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
import { appendStudyNote } from '../lib/course-storage/study-tools.ts';
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

/** Mirror main-process short leases, with independent UI/worker owners. */
class LockedWorkspaceApi extends FakeWorkspaceApi {
  readonly locks: CourseLocks;
  readonly owner: number;
  beforeWrite?: (relativePath: string[]) => Promise<void>;
  constructor(root: string, locks: CourseLocks, owner: number) {
    super(root); this.locks = locks; this.owner = owner;
  }
  acquireCourseLock(directory: string) { return this.locks.acquire(this.owner, directory); }
  async releaseCourseLock(token: string) { this.locks.release(this.owner, token); }
  override writeFile(directory: string, relativePath: string[], data: Uint8Array) {
    return this.locks.run(this.owner, directory, async () => {
      await this.beforeWrite?.(relativePath);
      await super.writeFile(directory, relativePath, data);
    });
  }
  override ensureDirectory(directory: string, relativePath: string[]) {
    return this.locks.run(this.owner, directory, () => super.ensureDirectory(directory, relativePath));
  }
  override deleteFile(directory: string, relativePath: string[]) {
    return this.locks.run(this.owner, directory, () => super.deleteFile(directory, relativePath));
  }
  override deleteCourseDirectory(directory: string) {
    return this.locks.run(this.owner, directory, () => super.deleteCourseDirectory(directory));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

function manualMutations(storage: DesktopCourseStorage, courseId: string) {
  const worker = new BackgroundImports({
    execute:false,
    analyze:async () => {throw new Error('AI must run outside the write transaction');},
    synthesize:async () => {throw new Error('AI must run outside the write transaction');},
    onBundle:() => undefined,
  });
  worker.register(courseId, storage);
  return worker;
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
    const glossary = reviseGlossary(EMPTY_GLOSSARY, [
      { source: 'mass', target: '质量', forbidden: ['群众'], note: '' },
    ]);
    const before = await storage.load();
    await storage.saveGlossary(glossary);
    assert.deepEqual(
      await new DesktopCourseStorage(api, directoryName).loadGlossary(),
      glossary,
    );
    assert.deepEqual(await storage.load(), before);
    await api.writeFile(
      directoryName,
      ['glossary.json'],
      new TextEncoder().encode('{bad'),
    );
    await assert.rejects(storage.loadGlossary());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('desktop raw save survives restart, persists processing, and writes a digest later without touching knowledge or notes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-background-import-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('后台课程');
    const storage = new DesktopCourseStorage(api, directoryName);
    const initial = await storage.initialize('后台课程');
    const note = '# 后台课程笔记\n\n用户手写内容，不应被后台导入覆盖。\n';
    await api.writeFile(
      directoryName,
      ['我的课程笔记.md'],
      new TextEncoder().encode(note),
    );
    const knowledgeBefore = await api.readFile(directoryName, [
      'Knowledge',
      'knowledge-v0.json',
    ]);
    const noteBefore = await api.readFile(directoryName, ['我的课程笔记.md']);
    const fingerprint = 'a'.repeat(64);
    const raw = await storage.savePdf(
      pdfFile('queued.pdf', 'durable raw pdf'),
      { fingerprint, pageCount: 3 },
      {
        generateSummary: true,
        generateMindmap: true,
        mergeIntoCourse: true,
        includeConversationInsights: false,
      },
      initial.manifest.revision,
    );
    assert.equal(raw.document.status, 'copied');
    assert.equal(raw.document.processing?.status, 'queued');
    assert.equal(raw.bundle.digests[raw.document.id], undefined);

    const reopened = new DesktopCourseStorage(api, directoryName);
    const persisted = await reopened.load();
    assert.equal(persisted.manifest.documents[0]?.processing?.status, 'queued');
    assert.equal(persisted.digests[raw.document.id], undefined);
    const opened = await reopened.openPdf(raw.document.id);
    assert.equal(await opened.text(), 'durable raw pdf');

    const running = await reopened.setDocumentProcessing(
      raw.document.id,
      {
        ...persisted.manifest.documents[0]!.processing!,
        status: 'running',
        updatedAt: new Date().toISOString(),
      },
      persisted.manifest.revision,
    );
    const afterRunningRestart = await new DesktopCourseStorage(
      api,
      directoryName,
    ).load();
    assert.equal(
      afterRunningRestart.manifest.documents[0]?.processing?.status,
      'running',
    );

    const digest = makeDigest({
      documentId: raw.document.id,
      fingerprint,
      title: '后台生成的摘要',
      sourcePages: [1, 2, 3],
    });
    const withDigest = await reopened.updateDocumentArtifacts(
      raw.document.id,
      running.manifest.revision,
      digest,
    );
    assert.deepEqual(withDigest.digests[raw.document.id], digest);
    assert.equal(withDigest.manifest.documents[0]?.processing?.phase, 'course');
    assert.equal(
      withDigest.manifest.documents[0]?.processing?.status,
      'queued',
    );
    const restored = await new DesktopCourseStorage(api, directoryName).load();
    assert.deepEqual(restored.digests[raw.document.id], digest);
    assert.deepEqual(
      await api.readFile(directoryName, ['Knowledge', 'knowledge-v0.json']),
      knowledgeBefore,
    );
    assert.deepEqual(
      await api.readFile(directoryName, ['我的课程笔记.md']),
      noteBefore,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('desktop notes reject external edits and history exposes actual artifact versions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-study-'));
  try {
    const api = new FakeWorkspaceApi(root); await api.getWorkspaceInfo();
    const {directoryName} = await api.createCourseDirectory('学习');
    const storage = new DesktopCourseStorage(api, directoryName);
    await storage.initialize('学习');
    const initial = await storage.loadNotes();
    await api.writeFile(directoryName, ['我的课程笔记.md'], new TextEncoder().encode('外部编辑的笔记'));
    await assert.rejects(storage.saveNotes('旧草稿', initial.token), /外部修改/);
    assert.equal((await storage.loadNotes()).content, '外部编辑的笔记');
    await appendStudyNote(storage, {text:'保留的新摘记',sources:[{documentId:'doc',fileName:'lesson.pdf',pageStart:2,type:'pdf'}]});
    assert.match((await storage.loadNotes()).content, /^外部编辑的笔记/);
    const imported = await storage.importDocument(pdfFile(), makeDigest(), {generateSummary:true,generateMindmap:true,mergeIntoCourse:true,includeConversationInsights:false}, 0);
    await storage.updateDocumentArtifacts(imported.document.id, imported.bundle.manifest.revision);
    const history = await storage.listHistory();
    assert.ok(history.some(entry => entry.revision === 0 && entry.knowledge.version === 0));
    assert.ok(history.some(entry => entry.revision === 1 && entry.summary.includes('极限')));
    await api.writeFile(directoryName, ['History','revision-99-1.json'], new TextEncoder().encode('{corrupt'));
    assert.equal((await storage.listHistory()).length, history.length);
    // Legacy courses have only immutable Knowledge versions and directory snapshots.
    for (const file of await api.listFiles(directoryName, ['History'])) await api.deleteFile(directoryName, ['History',file]);
    const legacyHistory = await storage.listHistory();
    assert.ok(legacyHistory.some(entry => entry.source === 'knowledge' && entry.knowledge.version === 0));
    assert.ok(legacyHistory.every(entry => entry.revision === undefined));
  } finally { await rm(root,{recursive:true,force:true}); }
});

void test('UI multi-file publication and background import serialize across renderer owners', {timeout:10_000}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-write-transaction-'));
  const locks = new CourseLocks();
  const resume = deferred();
  try {
    const uiApi = new LockedWorkspaceApi(root, locks, 1);
    const bgApi = new LockedWorkspaceApi(root, locks, 2);
    await uiApi.getWorkspaceInfo();
    const {directoryName} = await uiApi.createCourseDirectory('并发课程');
    const uiStorage = new DesktopCourseStorage(uiApi, directoryName);
    const bgStorage = new DesktopCourseStorage(bgApi, directoryName);
    const initial = await uiStorage.withWriteLock(() => uiStorage.initialize('并发课程'));
    const ui = manualMutations(uiStorage, initial.manifest.id);
    const background = manualMutations(bgStorage, initial.manifest.id);
    const digest = makeDigest();
    const imported = await ui.mutate(initial.manifest.id, (storage, current) => storage.importDocument(pdfFile(), digest, importOptions, current.manifest.revision));
    const reached = deferred();
    uiApi.beforeWrite = async relative => {
      if (relative[0] === 'Documents' && relative.at(-1) === 'document.json') {
        reached.resolve(); await resume.promise;
      }
    };
    const publication = ui.mutate(initial.manifest.id, storage => storage.updateDocumentArtifacts(digest.documentId, imported.bundle.manifest.revision, {...digest, overview:'重新生成'}));
    await reached.promise;
    let backgroundEntered = false;
    const save = background.mutate(initial.manifest.id, async (storage, current) => {
      backgroundEntered = true;
      return storage.savePdf(pdfFile('第二份.pdf'), {fingerprint:'b'.repeat(64),pageCount:1}, {generateSummary:false,generateMindmap:false,mergeIntoCourse:false,includeConversationInsights:false}, current.manifest.revision);
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(backgroundEntered, false, 'another renderer must wait for all artifact/history/manifest writes');
    resume.resolve();
    await Promise.all([publication, save]);
    const current = await uiStorage.load();
    assert.equal(current.manifest.revision, 3);
    assert.equal(current.manifest.documents.length, 2);
    assert.equal(current.digests[digest.documentId].overview, '重新生成');
    assert.ok((await uiStorage.listHistory()).some(entry => entry.revision === 2), 'background import must snapshot the completed UI publication');

    // Model time holds no lease. The import completes while manual AI waits;
    // its old result is then rejected before it changes any artifact file.
    uiApi.beforeWrite = undefined;
    const ai = deferred();
    const oldRevision = current.manifest.revision;
    const latePublication = ai.promise.then(() => ui.mutate(initial.manifest.id, storage => storage.updateDocumentArtifacts(digest.documentId, oldRevision, {...digest, overview:'过时 AI 结果'})));
    await background.mutate(initial.manifest.id, (storage, latest) => storage.savePdf(pdfFile('第三份.pdf'), {fingerprint:'c'.repeat(64),pageCount:1}, {generateSummary:false,generateMindmap:false,mergeIntoCourse:false,includeConversationInsights:false}, latest.manifest.revision));
    const courseRoot = path.join(resolveWorkspaceLayout(root).coursesRoot, directoryName);
    const before = await snapshotFiles(courseRoot);
    ai.resolve();
    await assert.rejects(latePublication, /外部修改/);
    assert.deepEqual(await snapshotFiles(courseRoot), before, 'stale AI must not partly replace document or course artifacts');
  } finally {
    resume.resolve(); await locks.close(); await rm(root, {recursive:true,force:true});
  }
});

void test('translation publish checks document existence inside the deletion transaction boundary', {timeout:10_000}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-translation-race-'));
  const locks = new CourseLocks();
  const resume = deferred();
  try {
    const uiApi = new LockedWorkspaceApi(root, locks, 1);
    const bgApi = new LockedWorkspaceApi(root, locks, 2);
    await uiApi.getWorkspaceInfo();
    const {directoryName} = await uiApi.createCourseDirectory('删除课程');
    const uiStorage = new DesktopCourseStorage(uiApi, directoryName);
    const bgStorage = new DesktopCourseStorage(bgApi, directoryName);
    const initial = await uiStorage.withWriteLock(() => uiStorage.initialize('删除课程'));
    const digest = makeDigest();
    await uiStorage.withWriteLock(() => uiStorage.importDocument(pdfFile(), digest, importOptions, 0));
    const background = manualMutations(bgStorage, initial.manifest.id);
    const deleting = deferred();
    const removal = background.mutate(initial.manifest.id, async (storage, current) => {
      deleting.resolve(); await resume.promise;
      return storage.removeDocument(digest.documentId, current.manifest.revision);
    });
    await deleting.promise;
    let publicationFinished = false;
    const publication = uiStorage.publishTranslation(digest.documentId, {
      schemaVersion:1,documentId:digest.documentId,fingerprint:digest.fingerprint,
      pageNumber:1,sourceHash:'1'.repeat(64),targetLanguage:'简体中文',provider:'test',model:'test',
      promptVersion:1,paragraphs:['译文'],updatedAt:new Date().toISOString(),
    });
    const rejected = assert.rejects(publication, /找不到这份 PDF/).then(() => {publicationFinished = true;});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(publicationFinished, false);
    resume.resolve(); await Promise.all([removal, rejected]);
    assert.equal((await uiStorage.load()).manifest.documents.length, 0);
    assert.equal(await uiApi.exists(directoryName, ['Translations',digest.documentId]), false, 'late publication must not recreate deleted translation files');
  } finally {
    resume.resolve(); await locks.close(); await rm(root, {recursive:true,force:true});
  }
});

void test('same-renderer glossary save waits for course deletion and cannot recreate its directory', {timeout:10_000}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-delete-race-'));
  const locks = new CourseLocks();
  const resume = deferred();
  try {
    const api = new LockedWorkspaceApi(root, locks, 1);
    await api.getWorkspaceInfo();
    const {directoryName} = await api.createCourseDirectory('删除课程');
    const storage = new DesktopCourseStorage(api, directoryName);
    const initial = await storage.withWriteLock(() => storage.initialize('删除课程'));
    const ui = manualMutations(storage, initial.manifest.id);
    const deleting = deferred();
    const removal = ui.mutate(initial.manifest.id, async currentStorage => {
      deleting.resolve(); await resume.promise; await currentStorage.deleteCourse();
    });
    await deleting.promise;
    let wrote = false;
    api.beforeWrite = async () => {wrote = true;};
    const rejected = assert.rejects(storage.saveGlossary({schemaVersion:1,version:0,entries:[]}), /课程目录不存在/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(wrote, false, 'same-owner single write must not borrow an unrelated deletion lease');
    resume.resolve(); await Promise.all([removal, rejected]);
    assert.deepEqual(await api.listCourses(), []);
    assert.deepEqual(await readdir(resolveWorkspaceLayout(root).coursesRoot), []);
  } finally {
    resume.resolve(); await locks.close(); await rm(root, {recursive:true,force:true});
  }
});
