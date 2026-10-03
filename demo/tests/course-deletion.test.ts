import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { YeyuDesktopApi } from '../electron/api.ts';
import {
  courseFileExists,
  createCourseDirectory,
  deleteCourseEntry,
  ensureCourseDirectory,
  ensureWorkspace,
  readCourseFile,
  removeCourseDirectory,
  scanCourses,
  writeCourseFile,
} from '../electron/workspace.ts';
import { resolveWorkspaceLayout } from '../electron/workspace-paths.ts';
import { BrowserDirectoryStorage } from '../lib/course-storage/browser-directory-storage.ts';
import { DesktopCourseStorage } from '../lib/course-storage/desktop-course-storage.ts';
import { MemoryCourseStorage } from '../lib/course-storage/memory-course-storage.ts';
import type {
  AiCourseKnowledge,
  BrowserDirectoryHandle,
  BrowserFileHandle,
  DocumentDigest,
  ImportOptions,
  WritableFileHandle,
} from '../lib/course-storage/types.ts';

/** 用真实的 workspace 文件层模拟主进程 IPC（与 desktop-course-storage.test.ts 相同）。 */
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

/** 支持删除的内存文件夹：模拟 File System Access API 的 removeEntry/values。 */
type DeletionNode =
  | { type: 'dir'; children: Map<string, DeletionNode> }
  | { type: 'file'; data: Uint8Array };

class DeletionFileHandle implements BrowserFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  private readonly node: Extract<DeletionNode, { type: 'file' }>;

  constructor(name: string, node: Extract<DeletionNode, { type: 'file' }>) {
    this.name = name;
    this.node = node;
  }

  async getFile(): Promise<File> {
    return new File([this.node.data.slice()], this.name);
  }

  async createWritable(): Promise<WritableFileHandle> {
    const chunks: BlobPart[] = [];
    return {
      write: async (data) => {
        chunks.push(data as BlobPart);
      },
      close: async () => {
        this.node.data = new Uint8Array(await new Blob(chunks).arrayBuffer());
      },
    };
  }
}

class DeletionDirectoryHandle implements BrowserDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  private readonly node: Extract<DeletionNode, { type: 'dir' }>;

  constructor(name: string, node: Extract<DeletionNode, { type: 'dir' }>) {
    this.name = name;
    this.node = node;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BrowserDirectoryHandle> {
    let child = this.node.children.get(name);
    if (!child) {
      if (!options?.create) throw new Error(`目录不存在：${name}`);
      child = { type: 'dir', children: new Map() };
      this.node.children.set(name, child);
    }
    if (child.type !== 'dir') throw new Error(`“${name}”不是目录`);
    return new DeletionDirectoryHandle(name, child);
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BrowserFileHandle> {
    let child = this.node.children.get(name);
    if (!child) {
      if (!options?.create) throw new Error(`文件不存在：${name}`);
      child = { type: 'file', data: new Uint8Array() };
      this.node.children.set(name, child);
    }
    if (child.type !== 'file') throw new Error(`“${name}”不是文件`);
    return new DeletionFileHandle(name, child);
  }

  async removeEntry(
    name: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const child = this.node.children.get(name);
    if (!child) throw new Error(`条目不存在：${name}`);
    if (
      child.type === 'dir' &&
      child.children.size > 0 &&
      !options?.recursive
    ) {
      throw new Error(`目录“${name}”非空，需要 recursive。`);
    }
    this.node.children.delete(name);
  }

  async *values(): AsyncGenerator<BrowserFileHandle | BrowserDirectoryHandle> {
    for (const [name, child] of this.node.children) {
      yield child.type === 'dir'
        ? new DeletionDirectoryHandle(name, child)
        : new DeletionFileHandle(name, child);
    }
  }

  list(): string[] {
    return [...this.node.children.keys()];
  }
}

function newDeletionRoot(): DeletionDirectoryHandle {
  return new DeletionDirectoryHandle('课程文件夹', {
    type: 'dir',
    children: new Map(),
  });
}

function makeDigest(overrides: Partial<DocumentDigest> = {}): DocumentDigest {
  const documentId = overrides.documentId ?? 'doc-delete000000001';
  return {
    schemaVersion: 2,
    documentId,
    fingerprint: overrides.fingerprint ?? `fingerprint-${documentId}`,
    title: '测试讲义',
    overview: '这是一份测试讲义。',
    sections: [],
    concepts: [
      {
        id: `concept-${documentId}`,
        label: overrides.title ?? '极限',
        description: '极限的 ε-δ 定义。',
        sources: [
          {
            documentId,
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

function pdfFile(name: string): File {
  return new File([new TextEncoder().encode(`pdf-bytes-${name}`)], name, {
    type: 'application/pdf',
  });
}

/** History 目录名带不可预测的时间戳；在真实磁盘上按 revision 前缀找到快照。 */
async function readHistorySnapshot(
  root: string,
  directoryName: string,
  revision: number,
): Promise<{ documents: unknown[] }> {
  const historyDir = path.join(
    resolveWorkspaceLayout(root).coursesRoot,
    directoryName,
    'History',
  );
  const entries = await readdir(historyDir);
  const snapshot = entries.find((name) =>
    name.startsWith(`revision-${revision}-`),
  );
  assert.ok(snapshot, `History 中应存在 revision-${revision} 快照`);
  return JSON.parse(
    await readFile(path.join(historyDir, snapshot!, 'course.json'), 'utf8'),
  );
}

void test('desktop storage removeDocument deletes files, cleans knowledge and writes history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-delete-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('MAT3007');
    const storage = new DesktopCourseStorage(api, directoryName);
    await storage.initialize('MAT3007');

    const digestOne = makeDigest({
      documentId: 'doc-delete000000001',
      fingerprint: 'fingerprint-delete00000001',
      title: '极限',
    });
    const digestTwo = makeDigest({
      documentId: 'doc-delete000000002',
      fingerprint: 'fingerprint-delete00000002',
      title: '微分',
    });
    const importedOne = await storage.importDocument(
      pdfFile('讲义1.pdf'),
      digestOne,
      importOptions,
      0,
    );
    const importedTwo = await storage.importDocument(
      pdfFile('讲义2.pdf'),
      digestTwo,
      importOptions,
      importedOne.bundle.manifest.revision,
    );
    assert.equal(importedTwo.bundle.manifest.documents.length, 2);

    const next = await storage.removeDocument(
      digestOne.documentId,
      importedTwo.bundle.manifest.revision,
    );

    // 清单与摘要：目标文档被移除，另一份保持完好，版本推进。
    assert.deepEqual(
      next.manifest.documents.map((document) => document.id),
      [digestTwo.documentId],
    );
    assert.equal(
      next.manifest.revision,
      importedTwo.bundle.manifest.revision + 1,
    );
    assert.deepEqual(Object.keys(next.digests), [digestTwo.documentId]);
    assert.equal(
      next.manifest.activeKnowledgeVersion,
      next.knowledge.version,
    );

    // 知识库：来自被删文档的来源全部消失，另一文档的贡献保留。
    for (const node of next.knowledge.nodes) {
      for (const source of node.sources) {
        assert.notEqual(source.documentId, digestOne.documentId);
      }
    }
    assert.ok(
      next.knowledge.nodes.some((node) =>
        node.sources.some(
          (source) => source.documentId === digestTwo.documentId,
        ),
      ),
      '另一份文档的知识节点必须保留',
    );
    assert.ok(
      !next.knowledge.nodes.some(
        (node) => node.id === `concept-${digestOne.documentId}`,
      ),
      '失去全部来源的生成节点应被移除',
    );

    // 磁盘：PDF 与成果目录被删除，其余文件完好。
    assert.equal(await api.exists(directoryName, ['PDFs', '讲义1.pdf']), false);
    assert.equal(
      await api.exists(directoryName, ['Documents', digestOne.documentId]),
      false,
    );
    assert.equal(await api.exists(directoryName, ['PDFs', '讲义2.pdf']), true);
    assert.equal(
      await api.exists(directoryName, [
        'Documents',
        digestTwo.documentId,
        'document.json',
      ]),
      true,
    );

    // course.json 落盘为删除后的版本；删除前的状态已写入 History。
    const saved = JSON.parse(
      new TextDecoder().decode(
        await api.readFile(directoryName, ['course.json']),
      ),
    ) as { documents: unknown[]; revision: number };
    assert.equal(saved.documents.length, 1);
    assert.equal(saved.revision, next.manifest.revision);
    const snapshot = await readHistorySnapshot(
      root,
      directoryName,
      importedTwo.bundle.manifest.revision,
    );
    assert.equal(snapshot.documents.length, 2, 'History 保存删除前状态');

    await assert.rejects(() => storage.openPdf(digestOne.documentId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('desktop storage removeDocument rebuilds course knowledge from AI output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-delete-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('MAT3007');
    const storage = new DesktopCourseStorage(api, directoryName);
    await storage.initialize('MAT3007');

    const digestOne = makeDigest({
      documentId: 'doc-delete000000001',
      fingerprint: 'fingerprint-delete00000001',
      title: '极限',
    });
    const digestTwo = makeDigest({
      documentId: 'doc-delete000000002',
      fingerprint: 'fingerprint-delete00000002',
      title: '微分',
    });
    const importedOne = await storage.importDocument(
      pdfFile('讲义1.pdf'),
      digestOne,
      importOptions,
      0,
    );
    const importedTwo = await storage.importDocument(
      pdfFile('讲义2.pdf'),
      digestTwo,
      importOptions,
      importedOne.bundle.manifest.revision,
    );
    const versionBefore = importedTwo.bundle.knowledge.version;

    // 模拟 UI 用剩余资料重新综合出的课程知识库。
    const ai: AiCourseKnowledge = {
      theme: '课程核心围绕极限与微分两条主线。',
      nodes: [
        {
          id: 'course-kn-1',
          label: '微分',
          description: '变化率与导数的理论。',
          sources: [
            {
              documentId: digestTwo.documentId,
              fileName: '讲义2.pdf',
              pageStart: 5,
              type: 'pdf',
            },
          ],
        },
      ],
      relations: [],
      conflicts: [],
      unresolvedQuestions: ['如何求复合函数的导数？'],
      provider: 'knowledge-provider-test',
      model: 'knowledge-model-x',
      promptVersion: 'ai-course-v1',
    };

    const next = await storage.removeDocument(
      digestOne.documentId,
      importedTwo.bundle.manifest.revision,
      ai,
    );

    // 知识库被 AI 输出重建，而不是只做本地裁剪。
    assert.equal(next.knowledge.schemaVersion, 3);
    assert.equal(next.knowledge.version, versionBefore + 1);
    assert.equal(next.knowledge.provider, 'knowledge-provider-test');
    assert.equal(next.knowledge.model, 'knowledge-model-x');
    assert.ok(
      next.knowledge.nodes.some((node) => node.label === '微分'),
      'AI 输出的节点应出现',
    );
    assert.ok(
      !next.knowledge.nodes.some((node) => node.label === '极限'),
      '被删文档的概念不应保留',
    );
    assert.deepEqual(
      next.knowledge.unresolvedQuestions,
      ['如何求复合函数的导数？'],
    );
    // 磁盘上的课程脑图与 course.json 同步为重建后的版本。
    const savedKnowledge = JSON.parse(
      new TextDecoder().decode(
        await api.readFile(directoryName, ['课程脑图.json']),
      ),
    ) as { version: number; provider?: string };
    assert.equal(savedKnowledge.version, next.knowledge.version);
    assert.equal(savedKnowledge.provider, 'knowledge-provider-test');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('browser storage removeDocument also accepts AI knowledge', async () => {
  const root = newDeletionRoot();
  const storage = new BrowserDirectoryStorage(root);
  await storage.initialize('线性代数');
  const imported = await storage.importDocument(
    pdfFile('讲义.pdf'),
    makeDigest(),
    importOptions,
    0,
  );
  const ai: AiCourseKnowledge = {
    theme: '重新综合后的主题。',
    nodes: [],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
    provider: 'knowledge-provider-test',
    model: 'knowledge-model-x',
    promptVersion: 'ai-course-v1',
  };

  const next = await storage.removeDocument(imported.document.id, 1, ai);

  assert.equal(next.knowledge.schemaVersion, 3);
  assert.equal(next.knowledge.provider, 'knowledge-provider-test');
  assert.equal(next.manifest.documents.length, 0);
  assert.equal(next.manifest.revision, 2);
});

void test('desktop storage removeDocument rejects stale revision', async () => {  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-delete-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('MAT3007');
    const storage = new DesktopCourseStorage(api, directoryName);
    await storage.initialize('MAT3007');
    const imported = await storage.importDocument(
      pdfFile('讲义.pdf'),
      makeDigest(),
      importOptions,
      0,
    );
    await assert.rejects(
      () =>
        storage.removeDocument(
          imported.document.id,
          imported.bundle.manifest.revision - 1,
        ),
      /外部修改/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('desktop storage deleteCourse removes the directory from the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-delete-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('MAT3007');
    const storage = new DesktopCourseStorage(api, directoryName);
    await storage.initialize('MAT3007');
    assert.equal((await api.listCourses()).length, 1);

    await storage.deleteCourse();

    assert.deepEqual(await api.listCourses(), []);
    // 课程目录本身已被移除：对目录内任何路径的访问都会报“课程目录不存在”。
    await assert.rejects(
      () => api.exists(directoryName, ['course.json']),
      /课程目录不存在/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('browser storage removeDocument deletes stored files and artifacts', async () => {
  const root = newDeletionRoot();
  const storage = new BrowserDirectoryStorage(root);
  await storage.initialize('线性代数');
  const imported = await storage.importDocument(
    pdfFile('讲义.pdf'),
    makeDigest(),
    importOptions,
    0,
  );

  const next = await storage.removeDocument(imported.document.id, 1);

  assert.equal(next.manifest.documents.length, 0);
  assert.equal(next.manifest.revision, 2);
  assert.deepEqual(Object.keys(next.digests), []);
  const pdfs = (await root.getDirectoryHandle('PDFs')) as DeletionDirectoryHandle;
  assert.deepEqual(pdfs.list(), []);
  const documents = (await root.getDirectoryHandle(
    'Documents',
  )) as DeletionDirectoryHandle;
  assert.deepEqual(documents.list(), []);
  await assert.rejects(() => storage.openPdf(imported.document.id));
});

void test('desktop deletion preserves referenced PDFs when manifest commit fails and commits before cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-delete-failure-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const {directoryName} = await api.createCourseDirectory('删除故障');
    const storage = new DesktopCourseStorage(api, directoryName);
    await storage.initialize('删除故障');
    const imported = await storage.importDocument(pdfFile('原文.pdf'), makeDigest(), importOptions, 0);
    const write = api.writeFile.bind(api);
    api.writeFile = async (directory, relative, data) => {
      if (relative.length === 1 && relative[0] === 'course.json') throw new Error('manifest write failure');
      await write(directory, relative, data);
    };
    await assert.rejects(storage.removeDocument(imported.document.id, 1), /manifest write failure/);
    assert.deepEqual((await storage.load()).manifest, imported.bundle.manifest);
    assert.equal(await (await storage.openPdf(imported.document.id)).text(), await pdfFile('原文.pdf').text());
    assert.ok((await storage.load()).digests[imported.document.id], 'failed manifest must preserve document digest');

    api.writeFile = write;
    api.deleteFile = async () => {
      const committed = await storage.load();
      assert.equal(committed.manifest.documents.length, 0, 'cleanup must observe the committed removal');
      assert.equal(committed.manifest.revision, 2);
      throw new Error('cleanup interrupted');
    };
    await assert.rejects(storage.removeDocument(imported.document.id, 1), /cleanup interrupted/);
    assert.equal((await storage.load()).manifest.documents.length, 0);
    assert.equal(await api.exists(directoryName, ['PDFs','原文.pdf']), true, 'interrupted cleanup leaves recoverable bytes, not missing referenced bytes');
  } finally { await rm(root, {recursive:true,force:true}); }
});

void test('browser deletion preserves referenced PDFs when manifest commit fails and commits before cleanup', async () => {
  const root = newDeletionRoot();
  const storage = new BrowserDirectoryStorage(root);
  await storage.initialize('删除故障');
  const imported = await storage.importDocument(pdfFile('原文.pdf'), makeDigest(), importOptions, 0);
  const getFile = root.getFileHandle.bind(root);
  root.getFileHandle = async (name, options) => {
    if (name === 'course.json' && options?.create) throw new Error('manifest write failure');
    return getFile(name, options);
  };
  await assert.rejects(storage.removeDocument(imported.document.id, 1), /manifest write failure/);
  assert.deepEqual((await storage.load()).manifest, imported.bundle.manifest);
  assert.equal(await (await storage.openPdf(imported.document.id)).text(), await pdfFile('原文.pdf').text());
  assert.ok((await storage.load()).digests[imported.document.id]);

  root.getFileHandle = getFile;
  const pdfs = await root.getDirectoryHandle('PDFs');
  const getDirectory = root.getDirectoryHandle.bind(root);
  root.getDirectoryHandle = async (name, options) => {
    const directory = await getDirectory(name, options);
    if (name === 'PDFs') directory.removeEntry = async () => {
      const committed = await storage.load();
      assert.equal(committed.manifest.documents.length, 0, 'cleanup must observe the committed removal');
      assert.equal(committed.manifest.revision, 2);
      throw new Error('cleanup interrupted');
    };
    return directory;
  };
  await assert.rejects(storage.removeDocument(imported.document.id, 1), /cleanup interrupted/);
  assert.equal((await storage.load()).manifest.documents.length, 0);
  assert.equal(await (await pdfs.getFileHandle('原文.pdf')).getFile().then(file => file.text()), await pdfFile('原文.pdf').text());
});

void test('browser storage deleteCourse empties the course folder', async () => {
  const root = newDeletionRoot();
  const storage = new BrowserDirectoryStorage(root);
  await storage.initialize('线性代数');
  await storage.importDocument(
    pdfFile('讲义.pdf'),
    makeDigest(),
    importOptions,
    0,
  );
  assert.ok(root.list().length > 0);

  await storage.deleteCourse();

  assert.deepEqual(root.list(), []);
  await assert.rejects(() => storage.load(), /course\.json/);
});

void test('memory storage removeDocument and deleteCourse keep invariants', async () => {
  const storage = new MemoryCourseStorage();
  await storage.initialize('测试课程');
  const imported = await storage.importDocument(
    pdfFile('讲义.pdf'),
    makeDigest(),
    importOptions,
    0,
  );

  const next = await storage.removeDocument(imported.document.id, 1);
  assert.equal(next.manifest.documents.length, 0);
  assert.equal(next.manifest.revision, 2);
  assert.deepEqual(Object.keys(next.digests), []);
  await assert.rejects(
    () => storage.openPdf(imported.document.id),
    /PDF 不存在/,
  );

  await storage.deleteCourse();
  await assert.rejects(() => storage.load(), /课程不存在/);
});

void test('workspace deleteCourseEntry is safe and idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-delete-'));
  try {
    const api = new FakeWorkspaceApi(root);
    await api.getWorkspaceInfo();
    const coursesRoot = resolveWorkspaceLayout(root).coursesRoot;
    const { directoryName } = await api.createCourseDirectory('MAT3007');
    const storage = new DesktopCourseStorage(api, directoryName);
    await storage.initialize('MAT3007');

    // 空路径等于删除课程根目录，必须拒绝。
    await assert.rejects(
      () => deleteCourseEntry(coursesRoot, directoryName, []),
      /必须指定/,
    );

    // 删除不存在的目标保持幂等，不抛错。
    await deleteCourseEntry(coursesRoot, directoryName, ['PDFs', '不存在.pdf']);

    // 递归删除成果目录。
    await deleteCourseEntry(coursesRoot, directoryName, ['History']);
    assert.equal(
      await courseFileExists(coursesRoot, directoryName, ['History']),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
