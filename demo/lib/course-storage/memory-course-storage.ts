import { EMPTY_GLOSSARY, parseGlossary, type Glossary } from '../glossary.ts';
import { rawPdfRecord, artifactsReady, processingBundle } from './background-records.ts';
import type { DocumentProcessing, PdfMetadata } from './types.ts';
import { createCourseId, sanitizeFileName } from './file-utils.ts';
import type {
  AiCourseKnowledge,
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

export class MemoryCourseStorage implements CourseStorage {
  readonly label = '测试课程文件夹';
  private bundle: CourseBundle | null = null;
  private files = new Map<string, File>();

  private glossary: Glossary = structuredClone(EMPTY_GLOSSARY);
  async loadGlossary(): Promise<Glossary> { return structuredClone(this.glossary); }
  async saveGlossary(glossary: Glossary): Promise<void> { this.glossary = parseGlossary(glossary); }

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

  async savePdf(file: File, metadata: PdfMetadata, options: ImportOptions, expectedRevision: number): Promise<ImportResult> {
    const current = await this.load();
    this.assertRevision(current, expectedRevision);
    const document = rawPdfRecord(current, file, metadata, options);
    this.files.set(document.id, file);
    this.bundle = {...current, manifest:{...current.manifest, revision:current.manifest.revision+1, updatedAt:document.updatedAt, documents:[...current.manifest.documents, document]}};
    return {bundle:await this.load(), document};
  }

  async setDocumentProcessing(documentId: string, processing: DocumentProcessing | undefined, expectedRevision: number): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current, expectedRevision);
    this.bundle = processingBundle(current, documentId, processing);
    return this.load();
  }

  async mergeDocuments(documentIds: string[], expectedRevision: number, aiKnowledge: AiCourseKnowledge): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current, expectedRevision);
    if (!documentIds.length || documentIds.some(id => !current.digests[id] || !current.manifest.documents.some(doc => doc.id === id))) throw new Error('文档摘要不存在。');
    const now = new Date().toISOString();
    const knowledge = applyAiCourseKnowledge(current.knowledge, aiKnowledge, now);
    this.bundle = {...current, knowledge, manifest:{...current.manifest, revision:current.manifest.revision+1, activeKnowledgeVersion:knowledge.version, updatedAt:now,
      documents:current.manifest.documents.map(doc => documentIds.includes(doc.id) ? {...doc, processing:undefined, includedInCourse:true, status:'course-merged', updatedAt:now} : doc)}};
    return this.load();
  }

  async importDocument(
    file: File,
    digest: DocumentDigest,
    options: ImportOptions,
    expectedRevision: number,
    aiKnowledge?: AiCourseKnowledge,
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
      ? aiKnowledge
        ? applyAiCourseKnowledge(current.knowledge, aiKnowledge, now)
        : mergeDocumentDigest(current.knowledge, digest, now)
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
    digest?: DocumentDigest,
  ): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current, expectedRevision);
    const document = current.manifest.documents.find(
      (item) => item.id === documentId,
    );
    if (!document) throw new Error('文档不存在。');
    if (digest) current.digests[documentId] = digest;
    if (!current.digests[documentId]) throw new Error('文档摘要不存在。');
    Object.assign(document, artifactsReady(document));
    current.manifest.revision += 1;
    this.bundle = current;
    return this.load();
  }

  async mergeDocument(
    documentId: string,
    expectedRevision: number,
    aiKnowledge?: AiCourseKnowledge,
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
    current.knowledge = aiKnowledge
      ? applyAiCourseKnowledge(current.knowledge, aiKnowledge)
      : mergeDocumentDigest(current.knowledge, digest);
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

  async removeDocument(
    documentId: string,
    expectedRevision: number,
    aiKnowledge?: AiCourseKnowledge,
  ): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current, expectedRevision);
    const document = current.manifest.documents.find(
      (item) => item.id === documentId,
    );
    if (!document) throw new Error('课程中找不到这份 PDF。');
    const now = new Date().toISOString();
    current.knowledge = aiKnowledge
      ? applyAiCourseKnowledge(current.knowledge, aiKnowledge, now)
      : removeDocumentContribution(current.knowledge, documentId, now);
    current.manifest.documents = current.manifest.documents.filter(
      (item) => item.id !== documentId,
    );
    current.manifest.revision += 1;
    current.manifest.activeKnowledgeVersion = current.knowledge.version;
    current.manifest.updatedAt = now;
    delete current.digests[documentId];
    this.files.delete(documentId);
    this.bundle = current;
    return this.load();
  }

  async deleteCourse(): Promise<void> {
    this.bundle = null;
    this.files.clear();
    this.glossary = structuredClone(EMPTY_GLOSSARY);
  }

  private assertRevision(bundle: CourseBundle, expectedRevision: number): void {
    if (bundle.manifest.revision !== expectedRevision) {
      throw new Error('课程文件已在外部修改，请重新加载后再操作。');
    }
  }
}
