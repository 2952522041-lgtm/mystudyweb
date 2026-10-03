import { EMPTY_GLOSSARY, parseGlossary, type Glossary } from '../glossary.ts';
import { assertNotesUnchanged, isHistoryKnowledge, notesSnapshot, withLocalWriteLock, type CourseHistoryEntry } from './study-tools.ts';
import { rawPdfRecord, artifactsReady, processingBundle } from './background-records.ts';
import type { DocumentProcessing, PdfMetadata } from './types.ts';
import {
  assertSafeArtifactContent,
  createCourseId,
  sanitizeFileName,
  suffixFileName,
} from './file-utils.ts';
import type {
  AiCourseKnowledge,
  BrowserDirectoryHandle,
  BrowserFileHandle,
  CourseBundle,
  CourseManifest,
  CourseStorage,
  DocumentDigest,
  DocumentRecord,
  ImportOptions,
  ImportResult,
} from './types.ts';
import {
  applyAiCourseKnowledge,
  emptyCourseKnowledge,
  mergeDocumentDigest,
  removeDocumentContribution,
} from '../knowledge/course-merger.ts';
import {
  renderCourseSummary,
  renderDocumentSummary,
  renderKnowledgeSvg,
} from '../knowledge/artifact-renderer.ts';

const encoder = new TextEncoder();

async function getDirectory(
  root: BrowserDirectoryHandle,
  path: string[],
  create = false,
): Promise<BrowserDirectoryHandle> {
  let current = root;
  for (const segment of path) {
    current = await current.getDirectoryHandle(segment, { create });
  }
  return current;
}

async function getFileHandle(
  root: BrowserDirectoryHandle,
  path: string[],
  create = false,
): Promise<BrowserFileHandle> {
  const directory = await getDirectory(root, path.slice(0, -1), create);
  return directory.getFileHandle(path.at(-1)!, { create });
}

async function fileExists(
  root: BrowserDirectoryHandle,
  path: string[],
): Promise<boolean> {
  try {
    await getFileHandle(root, path);
    return true;
  } catch {
    return false;
  }
}

async function writeFile(
  root: BrowserDirectoryHandle,
  path: string[],
  content: Blob | ArrayBuffer | string,
): Promise<void> {
  if (typeof content === 'string') assertSafeArtifactContent(content);
  const handle = await getFileHandle(root, path, true);
  const writable = await handle.createWritable();
  await writable.write(
    typeof content === 'string' ? encoder.encode(content) : content,
  );
  await writable.close();
}

async function readText(
  root: BrowserDirectoryHandle,
  path: string[],
): Promise<string> {
  const handle = await getFileHandle(root, path);
  return (await handle.getFile()).text();
}

async function readJson<T>(
  root: BrowserDirectoryHandle,
  path: string[],
): Promise<T> {
  return JSON.parse(await readText(root, path)) as T;
}

async function removeEntry(
  root: BrowserDirectoryHandle,
  path: string[],
  recursive = false,
): Promise<void> {
  if (!root.removeEntry) {
    throw new Error('当前浏览器不支持删除课程文件。');
  }
  const directory = await getDirectory(root, path.slice(0, -1));
  if (!directory.removeEntry) {
    throw new Error('当前浏览器不支持删除课程文件。');
  }
  await directory.removeEntry(path.at(-1)!, { recursive });
}

function assertManifest(value: CourseManifest): void {
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.revision !== 'number' ||
    !Array.isArray(value.documents)
  ) {
    throw new Error('课程文件夹中的 course.json 格式不受支持或已损坏。');
  }
}

function documentDirectory(documentId: string): string[] {
  return ['Documents', documentId];
}

export class BrowserDirectoryStorage implements CourseStorage {
  readonly label: string;
  readonly root: BrowserDirectoryHandle;

  constructor(root: BrowserDirectoryHandle) {
    this.root = root;
    this.label = root.name;
  }

  async loadGlossary(): Promise<Glossary> {
    try { return parseGlossary(await readJson(this.root, ['glossary.json'])); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return structuredClone(EMPTY_GLOSSARY);
      throw error;
    }
  }
  async saveGlossary(glossary: Glossary): Promise<void> {
    await writeFile(this.root, ['glossary.json'], JSON.stringify(parseGlossary(glossary), null, 2));
  }

  async loadNotes() {
    try { return notesSnapshot(await readText(this.root, ['我的课程笔记.md'])); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return notesSnapshot('');
      throw error;
    }
  }

  async saveNotes(content: string, expectedToken: string) {
    const save = async () => {
      assertSafeArtifactContent(content);
      assertNotesUnchanged(await this.loadNotes(), expectedToken);
      await writeFile(this.root, ['我的课程笔记.md'], content);
      return notesSnapshot(content);
    };
    // Serialize application windows while still detecting external file edits.
    if (typeof navigator !== 'undefined' && navigator.locks) {
      const { manifest } = await this.load();
      return navigator.locks.request(`course-notes:${manifest.id}`, save);
    }
    return withLocalWriteLock(this, save);
  }

  async listHistory(): Promise<CourseHistoryEntry[]> {
    const root = await getDirectory(this.root, ['History']);
    if (!root.values) return [];
    const history: CourseHistoryEntry[] = [];
    for await (const entry of root.values()) {
      if (entry.kind !== 'directory' || !/^revision-\d+-\d+$/.test(entry.name)) continue;
      try {
        const manifest = await readJson<CourseManifest>(entry, ['course.json']);
        const knowledge = await readJson<unknown>(entry, ['课程脑图.json']);
        if (!isHistoryKnowledge(knowledge)) continue;
        history.push({id:entry.name, revision:manifest.revision, updatedAt:manifest.updatedAt, knowledge,
          summary:await readText(entry, ['课程总结.md']), source:'snapshot'});
      } catch { /* One externally damaged snapshot must not hide other versions. */ }
    }
    return history.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async initialize(name: string): Promise<CourseBundle> {
    if (await fileExists(this.root, ['course.json'])) {
      throw new Error('所选文件夹已经包含课程，请使用“连接已有课程”。');
    }
    const now = new Date().toISOString();
    const id = createCourseId();
    const manifest: CourseManifest = {
      schemaVersion: 1,
      id,
      name,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      activeKnowledgeVersion: 0,
      documents: [],
    };
    const knowledge = emptyCourseKnowledge(id, name, now);
    const bundle: CourseBundle = { manifest, knowledge, digests: {} };
    await Promise.all(
      ['PDFs', 'Documents', 'History', 'Knowledge'].map((directory) =>
        this.root.getDirectoryHandle(directory, { create: true }),
      ),
    );
    await writeFile(this.root, ['我的课程笔记.md'], `# ${name}课程笔记\n\n`);
    await this.writeBundle(bundle, false);
    return bundle;
  }

  async load(): Promise<CourseBundle> {
    const manifest = await readJson<CourseManifest>(this.root, ['course.json']);
    assertManifest(manifest);
    const versionedPath = [
      'Knowledge',
      `knowledge-v${manifest.activeKnowledgeVersion}.json`,
    ];
    const knowledge = await readJson<CourseBundle['knowledge']>(
      this.root,
      (await fileExists(this.root, versionedPath))
        ? versionedPath
        : ['课程脑图.json'],
    );
    const digests: Record<string, DocumentDigest> = {};
    for (const document of manifest.documents) {
      try {
        digests[document.id] = await readJson<DocumentDigest>(this.root, [
          ...documentDirectory(document.id),
          'document.json',
        ]);
      } catch {
        // Keep the course recoverable even if one document artifact is damaged.
      }
    }
    return { manifest, knowledge, digests };
  }

  async savePdf(file: File, metadata: PdfMetadata, options: ImportOptions, expectedRevision: number): Promise<ImportResult> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    const document = rawPdfRecord(current, file, metadata, options);
    await writeFile(this.root, ['PDFs', document.storedFileName], await file.arrayBuffer());
    const bundle = {...current, manifest:{...current.manifest, revision:current.manifest.revision+1, updatedAt:document.updatedAt, documents:[...current.manifest.documents, document]}};
    await this.createRevision(current);
    await writeFile(this.root, ['course.json'], JSON.stringify(bundle.manifest, null, 2));
    return {bundle, document};
  }

  async setDocumentProcessing(documentId: string, processing: DocumentProcessing | undefined, expectedRevision: number): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    const next = processingBundle(current, documentId, processing);
    await writeFile(this.root, ['course.json'], JSON.stringify(next.manifest, null, 2));
    return next;
  }

  async mergeDocuments(documentIds: string[], expectedRevision: number, aiKnowledge: AiCourseKnowledge): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    if (!documentIds.length || documentIds.some(id => !current.digests[id] || !current.manifest.documents.some(doc => doc.id === id))) throw new Error('文档摘要不存在。');
    const now = new Date().toISOString();
    const knowledge = applyAiCourseKnowledge(current.knowledge, aiKnowledge, now);
    const bundle: CourseBundle = {...current, knowledge, manifest:{...current.manifest, revision:current.manifest.revision+1, activeKnowledgeVersion:knowledge.version, updatedAt:now,
      documents:current.manifest.documents.map(doc => documentIds.includes(doc.id) ? {...doc, processing:undefined, includedInCourse:true, status:'course-merged', updatedAt:now} : doc)}};
    await this.createRevision(current);
    await this.writeBundle(bundle, true);
    return bundle;
  }

  async importDocument(
    file: File,
    digest: DocumentDigest,
    options: ImportOptions,
    expectedRevision: number,
    aiKnowledge?: AiCourseKnowledge,
  ): Promise<ImportResult> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    if (
      current.manifest.documents.some(
        (document) => document.fingerprint === digest.fingerprint,
      )
    ) {
      throw new Error('这份 PDF 已经在课程中，未重复导入。');
    }

    const now = new Date().toISOString();
    const safeName = sanitizeFileName(file.name);
    const usedNames = new Set(
      current.manifest.documents.map((document) => document.storedFileName),
    );
    const storedFileName = usedNames.has(safeName)
      ? suffixFileName(safeName, digest.fingerprint.slice(0, 8))
      : safeName;

    await writeFile(
      this.root,
      ['PDFs', storedFileName],
      await file.arrayBuffer(),
    );
    const document: DocumentRecord = {
      id: digest.documentId,
      fingerprint: digest.fingerprint,
      fileName: file.name,
      storedFileName,
      pageCount: digest.sourcePages.length,
      status: options.mergeIntoCourse
        ? 'course-merged'
        : options.generateSummary || options.generateMindmap
          ? 'document-artifacts-ready'
          : 'digested',
      includedInCourse: options.mergeIntoCourse,
      includeConversationInsights: options.includeConversationInsights,
      hasSummary: options.generateSummary,
      hasMindmap: options.generateMindmap,
      importedAt: now,
      updatedAt: now,
    };

    await this.writeDocumentArtifacts(document, digest);
    const knowledge = options.mergeIntoCourse
      ? aiKnowledge
        ? applyAiCourseKnowledge(current.knowledge, aiKnowledge, now)
        : mergeDocumentDigest(current.knowledge, digest, now)
      : current.knowledge;
    const manifest: CourseManifest = {
      ...current.manifest,
      revision: current.manifest.revision + 1,
      updatedAt: now,
      activeKnowledgeVersion: knowledge.version,
      documents: [...current.manifest.documents, document],
    };
    const bundle: CourseBundle = {
      manifest,
      knowledge,
      digests: { ...current.digests, [document.id]: digest },
    };
    await this.createRevision(current);
    await this.writeBundle(bundle, true);
    return { bundle, document };
  }

  async updateDocumentArtifacts(
    documentId: string,
    expectedRevision: number,
    digest?: DocumentDigest,
  ): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    const activeDigest = digest ?? current.digests[documentId];
    if (!activeDigest) throw new Error('这份 PDF 的内部摘要缺失，无法生成成果。');
    const now = new Date().toISOString();
    const documents = current.manifest.documents.map((document) =>
      document.id === documentId
        ? artifactsReady(document)
        : document,
    );
    const target = documents.find((document) => document.id === documentId)!;
    await this.writeDocumentArtifacts(target, activeDigest);
    const bundle = {
      ...current,
      digests: { ...current.digests, [documentId]: activeDigest },
      manifest: {
        ...current.manifest,
        documents,
        revision: current.manifest.revision + 1,
        updatedAt: now,
      },
    };
    await this.createRevision(current);
    await this.writeBundle(bundle, true);
    return bundle;
  }

  async mergeDocument(
    documentId: string,
    expectedRevision: number,
    aiKnowledge?: AiCourseKnowledge,
  ): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    const digest = current.digests[documentId];
    if (!digest) throw new Error('这份 PDF 的内部摘要缺失，无法并入课程。');
    const now = new Date().toISOString();
    const knowledge = aiKnowledge
      ? applyAiCourseKnowledge(current.knowledge, aiKnowledge, now)
      : mergeDocumentDigest(current.knowledge, digest, now);
    const documents = current.manifest.documents.map((document) =>
      document.id === documentId
        ? {
            ...document,
            includedInCourse: true,
            status: 'course-merged' as const,
            updatedAt: now,
          }
        : document,
    );
    const bundle: CourseBundle = {
      ...current,
      knowledge,
      manifest: {
        ...current.manifest,
        documents,
        revision: current.manifest.revision + 1,
        activeKnowledgeVersion: knowledge.version,
        updatedAt: now,
      },
    };
    await this.createRevision(current);
    await this.writeBundle(bundle, true);
    return bundle;
  }

  async openPdf(documentId: string): Promise<File> {
    const bundle = await this.load();
    const document = bundle.manifest.documents.find(
      (item) => item.id === documentId,
    );
    if (!document) throw new Error('课程中找不到这份 PDF。');
    return (
      await getFileHandle(this.root, ['PDFs', document.storedFileName])
    ).getFile();
  }

  async removeDocument(
    documentId: string,
    expectedRevision: number,
    aiKnowledge?: AiCourseKnowledge,
  ): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    const document = current.manifest.documents.find(
      (item) => item.id === documentId,
    );
    if (!document) throw new Error('课程中找不到这份 PDF。');
    const now = new Date().toISOString();
    const knowledge = aiKnowledge
      ? applyAiCourseKnowledge(current.knowledge, aiKnowledge, now)
      : removeDocumentContribution(current.knowledge, documentId, now);
    const digests = { ...current.digests };
    delete digests[documentId];
    const bundle: CourseBundle = {
      manifest: {
        ...current.manifest,
        documents: current.manifest.documents.filter(
          (item) => item.id !== documentId,
        ),
        revision: current.manifest.revision + 1,
        activeKnowledgeVersion: knowledge.version,
        updatedAt: now,
      },
      knowledge,
      digests,
    };
    await this.createRevision(current);
    await this.writeBundle(bundle, true);
    // Keep referenced PDF bytes until the new manifest is committed. An
    // interrupted cleanup may leave extra files, but cannot break the old PDF.
    await removeEntry(this.root, ['PDFs', document.storedFileName]);
    await removeEntry(this.root, documentDirectory(documentId), true);
    return bundle;
  }

  async deleteCourse(): Promise<void> {
    if (!this.root.values || !this.root.removeEntry) {
      throw new Error('当前浏览器不支持删除课程文件夹内容。');
    }
    const names: string[] = [];
    for await (const child of this.root.values()) {
      names.push(child.name);
    }
    for (const name of names) {
      await this.root.removeEntry(name, { recursive: true });
    }
  }

  private assertRevision(manifest: CourseManifest, expected: number): void {
    if (manifest.revision !== expected) {
      throw new Error('课程文件已在外部修改，请重新加载后再操作。');
    }
  }

  private async writeDocumentArtifacts(
    document: DocumentRecord,
    digest: DocumentDigest,
  ): Promise<void> {
    const directory = documentDirectory(document.id);
    await writeFile(
      this.root,
      [...directory, 'document.json'],
      JSON.stringify(digest, null, 2),
    );
    if (document.hasSummary) {
      await writeFile(
        this.root,
        [...directory, 'PDF总结.md'],
        renderDocumentSummary(digest),
      );
    }
    if (document.hasMindmap) {
      await writeFile(
        this.root,
        [...directory, 'PDF脑图.json'],
        JSON.stringify(
          { nodes: digest.concepts, relations: digest.relations },
          null,
          2,
        ),
      );
      const oneDocumentManifest: CourseManifest = {
        schemaVersion: 1,
        id: document.id,
        name: digest.title,
        revision: 0,
        createdAt: digest.updatedAt,
        updatedAt: digest.updatedAt,
        activeKnowledgeVersion: 1,
        documents: [document],
      };
      const oneDocumentKnowledge = mergeDocumentDigest(
        emptyCourseKnowledge(document.id, digest.title, digest.updatedAt),
        digest,
        digest.updatedAt,
      );
      await writeFile(
        this.root,
        [...directory, 'PDF脑图.svg'],
        renderKnowledgeSvg(oneDocumentManifest, oneDocumentKnowledge),
      );
    }
  }

  private async createRevision(current: CourseBundle): Promise<void> {
    const name = `revision-${current.manifest.revision}-${Date.now()}`;
    const base = ['History', name];
    await writeFile(
      this.root,
      [...base, 'course.json'],
      JSON.stringify(current.manifest, null, 2),
    );
    await writeFile(
      this.root,
      [...base, '课程脑图.json'],
      JSON.stringify(current.knowledge, null, 2),
    );
    await writeFile(
      this.root,
      [...base, '课程总结.md'],
      renderCourseSummary(current.manifest, current.knowledge),
    );
  }

  private async writeBundle(
    bundle: CourseBundle,
    updateManifestLast: boolean,
  ): Promise<void> {
    const knowledgeJson = JSON.stringify(bundle.knowledge, null, 2);
    await writeFile(
      this.root,
      ['Knowledge', `knowledge-v${bundle.knowledge.version}.json`],
      knowledgeJson,
    );
    await writeFile(this.root, ['课程脑图.json'], knowledgeJson);
    await writeFile(
      this.root,
      ['课程总结.md'],
      renderCourseSummary(bundle.manifest, bundle.knowledge),
    );
    await writeFile(
      this.root,
      ['课程脑图.svg'],
      renderKnowledgeSvg(bundle.manifest, bundle.knowledge),
    );
    if (updateManifestLast || !(await fileExists(this.root, ['course.json']))) {
      await writeFile(
        this.root,
        ['course.json'],
        JSON.stringify(bundle.manifest, null, 2),
      );
    }
  }
}
