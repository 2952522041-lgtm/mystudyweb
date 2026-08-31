import type { YeyuDesktopApi } from '../../electron/api';
import {
  assertSafeArtifactContent,
  createCourseId,
  sanitizeFileName,
  suffixFileName,
} from './file-utils.ts';
import type {
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
const decoder = new TextDecoder();

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, 2));
}

function encodeText(value: string): Uint8Array {
  assertSafeArtifactContent(value);
  return encoder.encode(value);
}

async function writeText(
  api: YeyuDesktopApi,
  directoryName: string,
  relativePath: string[],
  content: string,
): Promise<void> {
  await api.writeFile(directoryName, relativePath, encodeText(content));
}

async function readJson<T>(
  api: YeyuDesktopApi,
  directoryName: string,
  relativePath: string[],
): Promise<T> {
  return JSON.parse(
    decoder.decode(await api.readFile(directoryName, relativePath)),
  ) as T;
}

function assertManifest(value: CourseManifest): void {
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.revision !== 'number' ||
    !Array.isArray(value.documents)
  ) {
    throw new Error('课程目录中的 course.json 格式不受支持或已损坏。');
  }
}

function documentDirectory(documentId: string): string[] {
  return ['Documents', documentId];
}

/**
 * 桌面端的 CourseStorage 实现：通过 window.yeyuDesktop 白名单 IPC
 * 读写固定工作区，与 BrowserDirectoryStorage 保持相同的业务行为。
 */
export class DesktopCourseStorage implements CourseStorage {
  readonly label: string;

  private readonly api: YeyuDesktopApi;
  private readonly directoryName: string;

  constructor(api: YeyuDesktopApi, directoryName: string) {
    this.api = api;
    this.directoryName = directoryName;
    this.label = directoryName;
  }

  async initialize(name: string): Promise<CourseBundle> {
    if (await this.api.exists(this.directoryName, ['course.json'])) {
      throw new Error('该课程目录已经包含课程，请改用扫描到的课程。');
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
        this.api.ensureDirectory(this.directoryName, [directory]),
      ),
    );
    await writeText(
      this.api,
      this.directoryName,
      ['我的课程笔记.md'],
      `# ${name}课程笔记\n\n`,
    );
    await this.writeBundle(bundle, false);
    return bundle;
  }

  async load(): Promise<CourseBundle> {
    const manifest = await readJson<CourseManifest>(this.api, this.directoryName, [
      'course.json',
    ]);
    assertManifest(manifest);
    const versionedPath = [
      'Knowledge',
      `knowledge-v${manifest.activeKnowledgeVersion}.json`,
    ];
    const knowledge = await readJson<CourseBundle['knowledge']>(
      this.api,
      this.directoryName,
      (await this.api.exists(this.directoryName, versionedPath))
        ? versionedPath
        : ['课程脑图.json'],
    );
    const digests: Record<string, DocumentDigest> = {};
    for (const document of manifest.documents) {
      try {
        digests[document.id] = await readJson<DocumentDigest>(
          this.api,
          this.directoryName,
          [...documentDirectory(document.id), 'document.json'],
        );
      } catch {
        // 单份文档成果损坏时保持课程其余部分可用。
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

    await this.api.writeFile(
      this.directoryName,
      ['PDFs', storedFileName],
      new Uint8Array(await file.arrayBuffer()),
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
    const data = await this.api.readFile(this.directoryName, [
      'PDFs',
      document.storedFileName,
    ]);
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return new File([copy], document.fileName, { type: 'application/pdf' });
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
    await this.api.writeFile(
      this.directoryName,
      [...directory, 'document.json'],
      encodeJson(digest),
    );
    if (document.hasSummary) {
      await writeText(
        this.api,
        this.directoryName,
        [...directory, 'PDF总结.md'],
        renderDocumentSummary(digest),
      );
    }
    if (document.hasMindmap) {
      await this.api.writeFile(
        this.directoryName,
        [...directory, 'PDF脑图.json'],
        encodeJson({ nodes: digest.concepts, relations: digest.relations }),
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
      await writeText(
        this.api,
        this.directoryName,
        [...directory, 'PDF脑图.svg'],
        renderKnowledgeSvg(oneDocumentManifest, oneDocumentKnowledge),
      );
    }
  }

  private async createRevision(current: CourseBundle): Promise<void> {
    const name = `revision-${current.manifest.revision}-${Date.now()}`;
    const base = ['History', name];
    await this.api.writeFile(
      this.directoryName,
      [...base, 'course.json'],
      encodeJson(current.manifest),
    );
    await this.api.writeFile(
      this.directoryName,
      [...base, '课程脑图.json'],
      encodeJson(current.knowledge),
    );
    await writeText(
      this.api,
      this.directoryName,
      [...base, '课程总结.md'],
      renderCourseSummary(current.manifest, current.knowledge),
    );
  }

  private async writeBundle(
    bundle: CourseBundle,
    updateManifestLast: boolean,
  ): Promise<void> {
    const knowledgeJson = JSON.stringify(bundle.knowledge, null, 2);
    await this.api.writeFile(
      this.directoryName,
      ['Knowledge', `knowledge-v${bundle.knowledge.version}.json`],
      encoder.encode(knowledgeJson),
    );
    await this.api.writeFile(
      this.directoryName,
      ['课程脑图.json'],
      encoder.encode(knowledgeJson),
    );
    await writeText(
      this.api,
      this.directoryName,
      ['课程总结.md'],
      renderCourseSummary(bundle.manifest, bundle.knowledge),
    );
    await writeText(
      this.api,
      this.directoryName,
      ['课程脑图.svg'],
      renderKnowledgeSvg(bundle.manifest, bundle.knowledge),
    );
    if (
      updateManifestLast ||
      !(await this.api.exists(this.directoryName, ['course.json']))
    ) {
      await this.api.writeFile(
        this.directoryName,
        ['course.json'],
        encodeJson(bundle.manifest),
      );
    }
  }
}
