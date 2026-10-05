import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  exportCourseBackup,
  inspectCourseBackup,
  restoreCourseBackup,
} from '../electron/course-backup.ts';

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<
    string,
    unknown
  >;
}

async function entriesIn(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).sort();
}

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const walk = async (directory: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, entryRel);
      } else if (entry.isFile()) {
        snapshot.set(entryRel, sha256(await fs.readFile(absolute)));
      }
    }
  };
  await walk(root, '');
  return snapshot;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

interface BuiltCourse {
  id: string;
  name: string;
  pdfA: Buffer;
  pdfB: Buffer;
  pdfC: Buffer;
  pdfD: Buffer;
}

interface BuildOptions {
  id?: string;
  name?: string;
  revision?: number;
  pendingReview?: unknown;
}

async function buildCourse(
  root: string,
  options: BuildOptions = {},
): Promise<BuiltCourse> {
  const id = options.id ?? 'course-old';
  const name = options.name ?? '测试课程';
  const revision = options.revision ?? 2;
  const pdfA = Buffer.from([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0, 1, 2, 3, 255, 254,
    253,
  ]);
  const pdfB = Buffer.from('PDF-B-binary-\u0000\u0001\u0002', 'latin1');
  const pdfC = Buffer.from([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 9, 8, 7,
  ]);
  const pdfD = Buffer.from('PDF-D-notes-\u0000\u0005', 'latin1');

  await fs.mkdir(path.join(root, 'PDFs'), { recursive: true });
  await fs.writeFile(path.join(root, 'PDFs', 'a.pdf'), pdfA);
  await fs.writeFile(path.join(root, 'PDFs', 'b.pdf'), pdfB);
  await fs.writeFile(path.join(root, 'PDFs', 'c.pdf'), pdfC);
  await fs.writeFile(path.join(root, 'PDFs', 'd.pdf'), pdfD);

  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    id,
    name,
    revision,
    activeKnowledgeVersion: 1,
    updatedAt: '2024-05-01T00:00:00.000Z',
    documents: [
      {
        id: 'doc-a',
        storedFileName: 'a.pdf',
        sha256: sha256(pdfA),
        pageCount: 3,
        hasSummary: true,
        hasMindmap: true,
        includedInCourse: true,
        status: 'document-artifacts-ready',
        processing: {
          status: 'running',
          phase: 'document',
          runId: 'run-a',
          options: { model: 'fast', retry: 1 },
        },
      },
      {
        id: 'doc-b',
        storedFileName: 'b.pdf',
        sha256: sha256(pdfB),
        pageCount: 1,
        status: 'course-merged',
        processing: { status: 'paused', phase: 'course', runId: 'run-b' },
      },
      {
        id: 'doc-c',
        storedFileName: 'c.pdf',
        sha256: sha256(pdfC),
        pageCount: 2,
        status: 'copied',
        processing: { status: 'failed', phase: 'document', runId: 'run-c' },
      },
      {
        id: 'doc-d',
        storedFileName: 'd.pdf',
        sha256: sha256(pdfD),
        pageCount: 1,
        status: 'copied',
        processing: {
          status: 'review',
          phase: 'document',
          runId: 'run-d',
          options: { candidate: 1 },
        },
      },
    ],
  };
  if (options.pendingReview !== undefined) {
    manifest.pendingReview = options.pendingReview;
  }
  await writeJson(path.join(root, 'course.json'), manifest);

  await writeJson(path.join(root, 'Documents', 'doc-a', 'document.json'), {
    documentId: 'doc-a',
    fingerprint: sha256(pdfA),
    summary: '文档摘要',
    mindmap: { root: '知识点' },
  });

  await writeJson(path.join(root, 'Knowledge', 'knowledge-v1.json'), {
    courseId: id,
    version: 1,
    nodes: [{ id: 'node-1', label: '节点一' }],
    relations: [],
    conflicts: [],
  });

  await writeText(path.join(root, 'notes', 'note.txt'), '我的笔记内容');
  await writeJson(path.join(root, 'glossary', 'glossary.json'), {
    entries: [{ term: '页语', definition: '示例' }],
  });
  await writeJson(path.join(root, 'translations', 'zh.json'), {
    hello: '你好',
  });

  await writeJson(path.join(root, 'History', '1', 'course.json'), {
    schemaVersion: 1,
    id,
    name: '历史课程名',
    revision: 1,
    activeKnowledgeVersion: 1,
    documents: [],
    updatedAt: '2024-01-01T00:00:00.000Z',
  });
  await writeJson(
    path.join(root, 'History', '1', 'Knowledge', 'knowledge-v1.json'),
    {
      courseId: id,
      version: 1,
      nodes: [{ id: 'old-node', label: '旧节点' }],
      relations: [],
      conflicts: [],
    },
  );

  return { id, name, pdfA, pdfB, pdfC, pdfD };
}

async function setup(options: BuildOptions = {}): Promise<{
  base: string;
  course: string;
  backups: string;
  courses: string;
  built: BuiltCourse;
}> {
  const base = await makeTempDir('yeyu-backup-');
  const course = path.join(base, 'course');
  const backups = path.join(base, 'backups');
  const courses = path.join(base, 'courses');
  await fs.mkdir(course, { recursive: true });
  await fs.mkdir(backups, { recursive: true });
  await fs.mkdir(courses, { recursive: true });
  const built = await buildCourse(course, options);
  return { base, course, backups, courses, built };
}

function documentsById(
  manifest: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const documents = manifest.documents as Array<Record<string, unknown>>;
  const map = new Map<string, Record<string, unknown>>();
  for (const document of documents) map.set(String(document.id), document);
  return map;
}

void test('full export / inspect / restore roundtrip with nested processing', async () => {
  const { course, backups, courses } = await setup();
  const before = await snapshotTree(course);

  const exported = await exportCourseBackup(course, backups);
  assert.equal(exported.files, before.size);
  assert.ok(exported.bytes > 0);
  assert.equal(exported.name, path.basename(exported.directory));
  assert.ok(exported.directory.startsWith(`${backups}${path.sep}`));

  const metadata = await readJson(
    path.join(exported.directory, '.yeyu-backup.json'),
  );
  assert.equal(metadata.format, 'yeyu-course-backup');
  assert.equal(metadata.version, 1);
  assert.equal(metadata.courseId, 'course-old');
  assert.deepEqual(await snapshotTree(course), before);

  const backupBeforeInspect = await snapshotTree(exported.directory);
  const inspected = await inspectCourseBackup(exported.directory);
  assert.equal(inspected.name, '测试课程');
  assert.equal(inspected.courseId, 'course-old');
  assert.equal(inspected.files, before.size);
  assert.equal(inspected.bytes, exported.bytes);
  assert.equal(inspected.documents, 4);
  assert.ok(!Number.isNaN(Date.parse(inspected.createdAt)));
  assert.deepEqual(await snapshotTree(exported.directory), backupBeforeInspect);

  const restored = await restoreCourseBackup(exported.directory, courses);
  assert.notEqual(restored.courseId, 'course-old');
  assert.equal(restored.name, '测试课程（恢复）');
  const restoredDir = path.join(courses, restored.directoryName);
  const manifest = await readJson(path.join(restoredDir, 'course.json'));
  assert.equal(manifest.id, restored.courseId);
  assert.equal(manifest.name, '测试课程（恢复）');
  assert.equal(manifest.revision, 3);
  assert.equal(typeof manifest.updatedAt, 'string');
  assert.notEqual(manifest.updatedAt, '2024-05-01T00:00:00.000Z');

  const documents = documentsById(manifest);
  const docA = recordOf(documents.get('doc-a'));
  // Import-stage status must NOT be rewritten to a processing state.
  assert.equal(docA.status, 'document-artifacts-ready');
  assert.deepEqual(docA.processing, {
    status: 'paused',
    phase: 'document',
    options: { model: 'fast', retry: 1 },
  });

  // Already paused / failed work stays stable, including its runId.
  const docB = recordOf(documents.get('doc-b'));
  assert.equal(docB.status, 'course-merged');
  assert.deepEqual(docB.processing, {
    status: 'paused',
    phase: 'course',
    runId: 'run-b',
  });

  const docC = recordOf(documents.get('doc-c'));
  assert.equal(docC.status, 'copied');
  assert.deepEqual(docC.processing, {
    status: 'failed',
    phase: 'document',
    runId: 'run-c',
  });

  // A review candidate is downgraded to paused; no automatic AI call happens.
  const docD = recordOf(documents.get('doc-d'));
  assert.equal(docD.status, 'copied');
  assert.equal(recordOf(docD.processing).status, 'paused');
  assert.deepEqual(recordOf(docD.processing).options, { candidate: 1 });

  assert.deepEqual(
    await fs.readFile(path.join(restoredDir, 'PDFs', 'a.pdf')),
    await fs.readFile(path.join(course, 'PDFs', 'a.pdf')),
  );
  assert.equal(
    await fs.readFile(path.join(restoredDir, 'notes', 'note.txt'), 'utf8'),
    '我的笔记内容',
  );

  const history = await readJson(
    path.join(restoredDir, 'History', '1', 'course.json'),
  );
  assert.equal(history.id, restored.courseId);
  assert.equal(history.name, '历史课程名');
  const historyKnowledge = await readJson(
    path.join(restoredDir, 'History', '1', 'Knowledge', 'knowledge-v1.json'),
  );
  assert.equal(historyKnowledge.courseId, restored.courseId);
  const currentKnowledge = await readJson(
    path.join(restoredDir, 'Knowledge', 'knowledge-v1.json'),
  );
  assert.equal(currentKnowledge.courseId, restored.courseId);
  assert.deepEqual(currentKnowledge.nodes, [{ id: 'node-1', label: '节点一' }]);

  const untranslated = await fs.readFile(
    path.join(restoredDir, 'translations', 'zh.json'),
    'utf8',
  );
  const originalTranslation = await fs.readFile(
    path.join(course, 'translations', 'zh.json'),
    'utf8',
  );
  assert.equal(untranslated, originalTranslation);

  const second = await restoreCourseBackup(exported.directory, courses);
  assert.notEqual(second.courseId, restored.courseId);
  assert.notEqual(second.directoryName, restored.directoryName);
  assert.deepEqual(await snapshotTree(course), before);
});

void test('restore archives pendingReview and removes it from the manifest', async () => {
  const pendingReview = {
    courseId: 'course-old',
    status: 'review',
    candidate: { id: 'cand-1', text: '待审阅候选' },
  };
  const { course, backups, courses } = await setup({ pendingReview });

  const exported = await exportCourseBackup(course, backups);
  const restored = await restoreCourseBackup(exported.directory, courses);
  const restoredDir = path.join(courses, restored.directoryName);
  const manifest = await readJson(path.join(restoredDir, 'course.json'));
  assert.equal('pendingReview' in manifest, false);

  const archivePath = path.join(
    restoredDir,
    'History',
    `restored-pending-review-${restored.courseId}.json`,
  );
  assert.deepEqual(await readJson(archivePath), pendingReview);
});

void test('restore rewrites only recognized course metadata locations', async () => {
  const { course, backups, courses } = await setup();
  await writeJson(path.join(course, 'Documents', 'doc-a', 'custom.json'), {
    schemaVersion: 1,
    id: 'course-old',
    name: '伪装清单',
    revision: 0,
    activeKnowledgeVersion: 1,
    documents: [],
  });
  await writeJson(path.join(course, 'translations', 'fake-knowledge.json'), {
    courseId: 'course-old',
    version: 1,
    nodes: [],
    relations: [],
    conflicts: [],
  });
  await writeJson(path.join(course, 'notes', 'embedded.json'), {
    manifest: { schemaVersion: 1, id: 'course-old', documents: [] },
    knowledge: {
      courseId: 'course-old',
      version: 1,
      nodes: [],
      relations: [],
      conflicts: [],
    },
  });

  const exported = await exportCourseBackup(course, backups);
  const restored = await restoreCourseBackup(exported.directory, courses);
  const restoredDir = path.join(courses, restored.directoryName);

  const custom = await readJson(
    path.join(restoredDir, 'Documents', 'doc-a', 'custom.json'),
  );
  assert.equal(custom.id, 'course-old');
  const fakeKnowledge = await readJson(
    path.join(restoredDir, 'translations', 'fake-knowledge.json'),
  );
  assert.equal(fakeKnowledge.courseId, 'course-old');
  const embedded = await readJson(
    path.join(restoredDir, 'notes', 'embedded.json'),
  );
  assert.equal(recordOf(embedded.manifest).id, 'course-old');
  assert.equal(recordOf(embedded.knowledge).courseId, 'course-old');

  const currentKnowledge = await readJson(
    path.join(restoredDir, 'Knowledge', 'knowledge-v1.json'),
  );
  assert.equal(currentKnowledge.courseId, restored.courseId);
  const history = await readJson(
    path.join(restoredDir, 'History', '1', 'course.json'),
  );
  assert.equal(history.id, restored.courseId);
  const historyKnowledge = await readJson(
    path.join(restoredDir, 'History', '1', 'Knowledge', 'knowledge-v1.json'),
  );
  assert.equal(historyKnowledge.courseId, restored.courseId);
});

void test('restore rewrites embedded history.knowledge in the current manifest', async () => {
  const { course, backups, courses } = await setup();
  const manifestPath = path.join(course, 'course.json');
  const manifest = await readJson(manifestPath);
  manifest.history = {
    knowledge: [
      {
        courseId: 'course-old',
        version: 1,
        nodes: [],
        relations: [],
        conflicts: [],
      },
    ],
  };
  await writeJson(manifestPath, manifest);

  const exported = await exportCourseBackup(course, backups);
  const restored = await restoreCourseBackup(exported.directory, courses);
  const restoredManifest = await readJson(
    path.join(courses, restored.directoryName, 'course.json'),
  );
  const knowledge = recordOf(recordOf(restoredManifest.history).knowledge);
  assert.equal(
    (knowledge as unknown as Array<Record<string, unknown>>)[0].courseId,
    restored.courseId,
  );
});

void test('export rejects destination inside the course tree and leaves no partial output', async () => {
  const { course, backups } = await setup();
  const before = await entriesIn(backups);

  await assert.rejects(() => exportCourseBackup(course, course));
  const nested = path.join(course, 'sub');
  await fs.mkdir(nested);
  await assert.rejects(() => exportCourseBackup(course, nested));

  assert.deepEqual(await entriesIn(backups), before);
  assert.deepEqual(await entriesIn(nested), []);
});

void test('export rejects broken PDF fingerprint before creating any output', async () => {
  const { course, backups } = await setup();
  await fs.appendFile(
    path.join(course, 'PDFs', 'a.pdf'),
    Buffer.from([9, 9, 9]),
  );
  await assert.rejects(
    () => exportCourseBackup(course, backups),
    /指纹|fingerprint/i,
  );
  assert.deepEqual(await entriesIn(backups), []);
});

void test('export rejects digest whose id or fingerprint does not match the document', async () => {
  const wrongId = await setup();
  await writeJson(
    path.join(wrongId.course, 'Documents', 'doc-a', 'document.json'),
    {
      documentId: 'doc-other',
      fingerprint: sha256(wrongId.built.pdfA),
      summary: '摘要',
      mindmap: {},
    },
  );
  await assert.rejects(
    () => exportCourseBackup(wrongId.course, wrongId.backups),
    /摘要|digest|documentId/i,
  );
  assert.deepEqual(await entriesIn(wrongId.backups), []);

  const wrongFingerprint = await setup();
  await writeJson(
    path.join(wrongFingerprint.course, 'Documents', 'doc-a', 'document.json'),
    {
      documentId: 'doc-a',
      fingerprint: sha256('not-the-pdf'),
      summary: '摘要',
      mindmap: {},
    },
  );
  await assert.rejects(
    () => exportCourseBackup(wrongFingerprint.course, wrongFingerprint.backups),
    /摘要|指纹|digest/i,
  );
  assert.deepEqual(await entriesIn(wrongFingerprint.backups), []);
});

void test('export rejects missing digest and missing knowledge', async () => {
  const withMissingDigest = await setup();
  await fs.rm(
    path.join(withMissingDigest.course, 'Documents', 'doc-a', 'document.json'),
  );
  await assert.rejects(
    () =>
      exportCourseBackup(withMissingDigest.course, withMissingDigest.backups),
    /摘要|digest|不存在/i,
  );
  assert.deepEqual(await entriesIn(withMissingDigest.backups), []);

  const withMissingKnowledge = await setup();
  await fs.rm(path.join(withMissingKnowledge.course, 'Knowledge'), {
    recursive: true,
    force: true,
  });
  await assert.rejects(
    () =>
      exportCourseBackup(
        withMissingKnowledge.course,
        withMissingKnowledge.backups,
      ),
    /知识图谱|knowledge/i,
  );
  assert.deepEqual(await entriesIn(withMissingKnowledge.backups), []);
});

void test('export rejects symlinked files and directories', async () => {
  const withFileLink = await setup();
  await fs.symlink(
    path.join(withFileLink.course, 'course.json'),
    path.join(withFileLink.course, 'link.txt'),
  );
  await assert.rejects(
    () => exportCourseBackup(withFileLink.course, withFileLink.backups),
    /符号链接|symlink/i,
  );

  const withDirectoryLink = await setup();
  await fs.symlink(
    path.join(withDirectoryLink.course, 'notes'),
    path.join(withDirectoryLink.course, 'notes-link'),
  );
  await assert.rejects(
    () =>
      exportCourseBackup(withDirectoryLink.course, withDirectoryLink.backups),
    /符号链接|symlink/i,
  );

  const withRootLink = await setup();
  const rootLink = path.join(withRootLink.base, 'course-link');
  await fs.symlink(withRootLink.course, rootLink);
  await assert.rejects(
    () => exportCourseBackup(rootLink, withRootLink.backups),
    /符号链接|symlink/i,
  );
});

void test('export rejects non-portable source file names during traversal', async () => {
  const badFileNames = [
    'bad:name.txt',
    'bad?.txt',
    'bad\u0001.txt',
    'trailing.',
    'trailing ',
    'C:evil.txt',
  ];
  for (const badName of badFileNames) {
    const { course, backups } = await setup();
    await fs.writeFile(path.join(course, badName), 'x');
    await assert.rejects(
      () => exportCourseBackup(course, backups),
      /路径|非法|path/i,
      `expected rejection for file name ${JSON.stringify(badName)}`,
    );
    assert.deepEqual(await entriesIn(backups), []);
  }

  const badDirNames = ['bad dir ', 'bad dir.', 'bad:dir'];
  for (const badName of badDirNames) {
    const { course, backups } = await setup();
    const directory = path.join(course, badName);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'inner.txt'), 'x');
    await assert.rejects(
      () => exportCourseBackup(course, backups),
      /路径|非法|path/i,
      `expected rejection for directory name ${JSON.stringify(badName)}`,
    );
    assert.deepEqual(await entriesIn(backups), []);
  }
});

void test('inspect rejects missing, corrupt and unlisted payload files', async () => {
  const { course, backups } = await setup();
  const exported = await exportCourseBackup(course, backups);

  const missing = path.join(exported.directory, 'payload', 'PDFs', 'a.pdf');
  const saved = await fs.readFile(missing);
  await fs.rm(missing);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /不一致|清单|missing|不存在/i,
  );
  await fs.writeFile(missing, saved);

  await fs.writeFile(missing, Buffer.alloc(saved.length, 0x41));
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /哈希|hash/i,
  );
  await fs.writeFile(missing, saved);

  await fs.writeFile(
    path.join(exported.directory, 'payload', 'extra.txt'),
    'extra',
  );
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /未列出|清单|不一致/i,
  );
});

void test('inspect rejects unsafe, absolute, duplicate and oversized metadata paths', async () => {
  const { course, backups } = await setup();
  const exported = await exportCourseBackup(course, backups);
  const metadataPath = path.join(exported.directory, '.yeyu-backup.json');
  const metadata = await readJson(metadataPath);
  const files = metadata.files as Array<Record<string, unknown>>;

  const withTraversal = {
    ...metadata,
    files: [{ ...files[0], path: '../evil.txt' }, files[1]],
  };
  await writeJson(metadataPath, withTraversal);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /路径|非法|path/i,
  );

  const withAbsolute = {
    ...metadata,
    files: [{ ...files[0], path: '/etc/passwd' }, files[1]],
  };
  await writeJson(metadataPath, withAbsolute);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /路径|绝对|path/i,
  );

  const withBackslash = {
    ...metadata,
    files: [{ ...files[0], path: 'PDFs\\a.pdf' }, files[1]],
  };
  await writeJson(metadataPath, withBackslash);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /路径|非法|path/i,
  );

  const withNul = {
    ...metadata,
    files: [{ ...files[0], path: 'PDFs/a\u0000.pdf' }, files[1]],
  };
  await writeJson(metadataPath, withNul);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /路径|非法|path/i,
  );

  const withDrive = {
    ...metadata,
    files: [{ ...files[0], path: 'C:evil.txt' }, files[1]],
  };
  await writeJson(metadataPath, withDrive);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /路径|盘符|非法|path/i,
  );

  const withControl = {
    ...metadata,
    files: [{ ...files[0], path: 'PDFs/a\u0001.pdf' }, files[1]],
  };
  await writeJson(metadataPath, withControl);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /路径|控制|非法|path/i,
  );

  const withIllegal = {
    ...metadata,
    files: [{ ...files[0], path: 'PDFs/a?.pdf' }, files[1]],
  };
  await writeJson(metadataPath, withIllegal);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /路径|非法|path/i,
  );

  const withTrailingDot = {
    ...metadata,
    files: [{ ...files[0], path: 'PDFs/a.pdf.' }, files[1]],
  };
  await writeJson(metadataPath, withTrailingDot);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /路径|非法|path/i,
  );

  const withTrailingSpace = {
    ...metadata,
    files: [{ ...files[0], path: 'PDFs/a.pdf ' }, files[1]],
  };
  await writeJson(metadataPath, withTrailingSpace);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /路径|非法|path/i,
  );

  const withDuplicate = {
    ...metadata,
    files: [
      files[0],
      { ...files[1], path: String(files[0].path).toUpperCase() },
    ],
  };
  await writeJson(metadataPath, withDuplicate);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /重复|duplicate/i,
  );

  const withOversize = {
    ...metadata,
    files: [{ ...files[0], size: 10 * 1024 ** 3 + 1 }, files[1]],
  };
  await writeJson(metadataPath, withOversize);
  await assert.rejects(
    () => inspectCourseBackup(exported.directory),
    /大小|size|上限/i,
  );
});

void test('restore fails cleanly when the backup changed after inspection', async () => {
  const { course, backups, courses } = await setup();
  const exported = await exportCourseBackup(course, backups);
  const tamperedPath = path.join(
    exported.directory,
    'payload',
    'PDFs',
    'a.pdf',
  );
  const tamperedOriginal = await fs.readFile(tamperedPath);
  await fs.writeFile(tamperedPath, Buffer.alloc(tamperedOriginal.length, 0x42));

  const siblingsBefore = await entriesIn(path.dirname(courses));
  await assert.rejects(
    () => restoreCourseBackup(exported.directory, courses),
    /哈希|hash|变化/i,
  );
  assert.deepEqual(await entriesIn(courses), []);
  const siblingsAfter = await entriesIn(path.dirname(courses));
  assert.deepEqual(siblingsAfter, siblingsBefore);
});

void test('restore never overwrites an existing course directory', async () => {
  const { course, backups, courses } = await setup();
  const exported = await exportCourseBackup(course, backups);
  const existing = path.join(courses, 'existing');
  await fs.mkdir(existing);
  await writeText(path.join(existing, 'marker.txt'), 'keep');

  const restored = await restoreCourseBackup(exported.directory, courses);
  assert.notEqual(restored.directoryName, 'existing');
  assert.equal(
    await fs.readFile(path.join(existing, 'marker.txt'), 'utf8'),
    'keep',
  );
});

void test('accepts payload-prefixed metadata paths for portability', async () => {
  const { course, backups, courses } = await setup();
  const exported = await exportCourseBackup(course, backups);
  const metadataPath = path.join(exported.directory, '.yeyu-backup.json');
  const metadata = await readJson(metadataPath);
  const files = metadata.files as Array<Record<string, unknown>>;
  await writeJson(metadataPath, {
    ...metadata,
    files: files.map((file) => ({
      ...file,
      path: `payload/${String(file.path)}`,
    })),
  });

  const inspected = await inspectCourseBackup(exported.directory);
  assert.equal(inspected.files, files.length);
  const restored = await restoreCourseBackup(exported.directory, courses);
  assert.ok((await fs.readdir(courses)).includes(restored.directoryName));
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(courses, restored.directoryName, 'course.json'),
        'utf8',
      ),
    ).id,
    restored.courseId,
  );
});

void test('root 课程脑图.json knowledge fallback works end to end', async () => {
  const { course, backups, courses } = await setup();
  await fs.rm(path.join(course, 'Knowledge'), { recursive: true, force: true });
  await writeJson(path.join(course, '课程脑图.json'), {
    courseId: 'course-old',
    version: 1,
    nodes: [],
    relations: [],
    conflicts: [],
  });

  const exported = await exportCourseBackup(course, backups);
  const inspected = await inspectCourseBackup(exported.directory);
  assert.equal(inspected.courseId, 'course-old');
  const restored = await restoreCourseBackup(exported.directory, courses);
  const restoredDir = path.join(courses, restored.directoryName);
  const manifest = await readJson(path.join(restoredDir, 'course.json'));
  assert.equal(manifest.id, restored.courseId);
  const knowledge = await readJson(path.join(restoredDir, '课程脑图.json'));
  assert.equal(knowledge.courseId, restored.courseId);
});
