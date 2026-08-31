import { createCourseId, sanitizeFileName } from './file-utils.ts';
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

export class MemoryCourseStorage implements CourseStorage {
  readonly label = '测试课程文件夹';
  private bundle: CourseBundle | null = null;
  private files = new Map<string, File>();

  async initialize(name: string): Promise<CourseBundle> {
    if (this.bundle) throw new Error('课程已存在。');
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
    this.bundle = {
      manifest,
      knowledge: emptyCourseKnowledge(id, name, now),
      digests: {},
    };
    return structuredClone(this.bundle);
  }

  async load(): Promise<CourseBundle> {
    if (!this.bundle) throw new Error('课程不存在。');
    return structuredClone(this.bundle);
  }

  async importDocument(
    file: File,
    digest: DocumentDigest,
    options: ImportOptions,
    expectedRevision: number,
  ): Promise<ImportResult> {
    const current = await this.load();
    this.assertRevision(current, expectedRevision);
    if (
      current.manifest.documents.some(
        (item) => item.fingerprint === digest.fingerprint,
      )
    ) {
      throw new Error('这份 PDF 已经在课程中，未重复导入。');
    }
    const now = new Date().toISOString();
    const document: DocumentRecord = {
      id: digest.documentId,
      fingerprint: digest.fingerprint,
      fileName: file.name,
      storedFileName: sanitizeFileName(file.name),
      pageCount: digest.sourcePages.length,
      status: options.mergeIntoCourse ? 'course-merged' : 'digested',
      includedInCourse: options.mergeIntoCourse,
      includeConversationInsights: options.includeConversationInsights,
      hasSummary: options.generateSummary,
      hasMindmap: options.generateMindmap,
      importedAt: now,
      updatedAt: now,
    };
    const knowledge = options.mergeIntoCourse
      ? mergeDocumentDigest(current.knowledge, digest, now)
      : current.knowledge;
    current.manifest.documents.push(document);
    current.manifest.revision += 1;
    current.manifest.activeKnowledgeVersion = knowledge.version;
    current.manifest.updatedAt = now;
    current.knowledge = knowledge;
    current.digests[document.id] = digest;
    this.bundle = current;
    this.files.set(document.id, file);
    return { bundle: await this.load(), document };
  }

  async updateDocumentArtifacts(
    documentId: string,
    expectedRevision: number,
  ): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current, expectedRevision);
    const document = current.manifest.documents.find(
      (item) => item.id === documentId,
    );
    if (!document) throw new Error('文档不存在。');
    document.hasSummary = true;
    document.hasMindmap = true;
    document.status = document.includedInCourse
      ? 'course-merged'
      : 'document-artifacts-ready';
    current.manifest.revision += 1;
    this.bundle = current;
    return this.load();
  }

  async mergeDocument(
    documentId: string,
    expectedRevision: number,
  ): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current, expectedRevision);
    const document = current.manifest.documents.find(
      (item) => item.id === documentId,
    );
    const digest = current.digests[documentId];
    if (!document || !digest) throw new Error('文档摘要不存在。');
    document.includedInCourse = true;
    document.status = 'course-merged';
    current.knowledge = mergeDocumentDigest(current.knowledge, digest);
    current.manifest.activeKnowledgeVersion = current.knowledge.version;
    current.manifest.revision += 1;
    this.bundle = current;
    return this.load();
  }

  async openPdf(documentId: string): Promise<File> {
    const file = this.files.get(documentId);
    if (!file) throw new Error('PDF 不存在。');
    return file;
  }

  private assertRevision(bundle: CourseBundle, expectedRevision: number): void {
    if (bundle.manifest.revision !== expectedRevision) {
      throw new Error('课程文件已在外部修改，请重新加载后再操作。');
    }
  }
}
