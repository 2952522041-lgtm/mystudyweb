import {
  assertSafeArtifactContent,
  createCourseId,
  sanitizeFileName,
  suffixFileName,
} from './file-utils.ts';
import type {
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
  emptyCourseKnowledge,
  mergeDocumentDigest,
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

  constructor(readonly root: BrowserDirectoryHandle) {
    this.label = root.name;
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

  async importDocument(
    file: File,
    digest: DocumentDigest,
    options: ImportOptions,
    expectedRevision: number,
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
      ? mergeDocumentDigest(current.knowledge, digest, now)
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
  ): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    const digest = current.digests[documentId];
    if (!digest) throw new Error('这份 PDF 的内部摘要缺失，无法生成成果。');
    const now = new Date().toISOString();
    const documents = current.manifest.documents.map((document) =>
      document.id === documentId
        ? {
            ...document,
            hasSummary: true,
            hasMindmap: true,
            status: document.includedInCourse
              ? ('course-merged' as const)
              : ('document-artifacts-ready' as const),
            updatedAt: now,
          }
        : document,
    );
    const target = documents.find((document) => document.id === documentId)!;
    await this.writeDocumentArtifacts(target, digest);
    const bundle = {
      ...current,
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
  ): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    const digest = current.digests[documentId];
    if (!digest) throw new Error('这份 PDF 的内部摘要缺失，无法并入课程。');
    const now = new Date().toISOString();
    const knowledge = mergeDocumentDigest(current.knowledge, digest, now);
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
