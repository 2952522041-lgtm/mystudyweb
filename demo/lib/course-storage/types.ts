import type { KnowledgeEvidence, SynthesisDiagnostic } from '../knowledge/hierarchical-synthesis.ts';
import type { Glossary } from '../glossary.ts';
export const COURSE_SCHEMA_VERSION = 1 as const;
/** AI 生成的 DocumentDigest 使用 schemaVersion 3（显式 parentId）；本地规则生成的旧摘要仍为 1。 */
export const DIGEST_SCHEMA_VERSION = 3 as const;
/** AI 生成的课程知识库使用 schemaVersion 3（显式 parentId）；旧版增量合并结果仍为 1。 */
export const KNOWLEDGE_SCHEMA_VERSION = 3 as const;

export type ImportStage =
  | 'selected'
  | 'copying'
  | 'copied'
  | 'extracting'
  | 'digested'
  | 'document-artifacts-ready'
  | 'course-merged'
  | 'failed';

export interface SourceReference {
  documentId: string;
  fileName: string;
  pageStart: number;
  pageEnd?: number;
  type: 'pdf' | 'conversation';
}

export interface DigestSection {
  id: string;
  title: string;
  summary: string;
  /** 可选以兼容既有摘要；每个要点保留独立来源与 Markdown/LaTeX 原文。 */
  points?: Array<{ text: string; pageStart: number; pageEnd: number }>;
  pageStart: number;
  pageEnd: number;
}

export interface DigestConcept {
  /** undefined: 旧数据；null: 主题的一级分支；string: 父概念 id。 */
  parentId?: string | null;
  id: string;
  label: string;
  description: string;
  sources: SourceReference[];
}

export interface ConceptRelation {
  from: string;
  to: string;
  label: string;
}

export type DigestPromptVersion = 'local-structure-v1' | (string & {});

export interface DocumentDigest {
  evidence?: KnowledgeEvidence[];
  diagnostics?: SynthesisDiagnostic[];
  glossaryFingerprint?: string;
  schemaVersion: 1 | 2 | 3;
  documentId: string;
  fingerprint: string;
  title: string;
  overview: string;
  sections: DigestSection[];
  concepts: DigestConcept[];
  relations: ConceptRelation[];
  unresolvedQuestions: string[];
  sourcePages: number[];
  promptVersion: DigestPromptVersion;
  /** AI 生成时记录供应商与模型；旧本地摘要没有这两个字段。 */
  provider?: string;
  model?: string;
  updatedAt: string;
}

export interface DocumentRecord {
  /** Durable background work; absent on legacy/completed or PDF-only imports. */
  processing?: DocumentProcessing;
  id: string;
  fingerprint: string;
  fileName: string;
  storedFileName: string;
  pageCount: number;
  status: ImportStage;
  includedInCourse: boolean;
  includeConversationInsights: boolean;
  hasSummary: boolean;
  hasMindmap: boolean;
  importedAt: string;
  updatedAt: string;
  error?: string;
}

export interface CourseManifest {
  schemaVersion: typeof COURSE_SCHEMA_VERSION;
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  activeKnowledgeVersion: number;
  documents: DocumentRecord[];
}

export interface KnowledgeNode {
  parentId?: string | null;
  id: string;
  label: string;
  description: string;
  kind: 'course' | 'concept' | 'insight' | 'question';
  ownership: 'generated' | 'user';
  sources: SourceReference[];
}

export interface KnowledgeConflict {
  id: string;
  nodeId: string;
  descriptions: string[];
  sources: SourceReference[];
}

/**
 * KnowledgeProvider 综合出的课程知识库内容（尚未写入版本号）。
 * 存储层接收后负责保留用户节点并推进 knowledge.version。
 */
export interface AiCourseKnowledge {
  evidence?: KnowledgeEvidence[];
  diagnostics?: SynthesisDiagnostic[];
  theme: string;
  nodes: Array<{
    parentId?: string | null;
    id: string;
    label: string;
    description: string;
    sources: SourceReference[];
  }>;
  relations: ConceptRelation[];
  conflicts: Array<{
    nodeId: string;
    descriptions: string[];
    sources: SourceReference[];
  }>;
  unresolvedQuestions: string[];
  provider: string;
  model: string;
  promptVersion: string;
}

export interface CourseKnowledge {
  evidence?: KnowledgeEvidence[];
  diagnostics?: SynthesisDiagnostic[];
  schemaVersion: 1 | 2 | 3;
  courseId: string;
  version: number;
  nodes: KnowledgeNode[];
  relations: ConceptRelation[];
  conflicts: KnowledgeConflict[];
  updatedAt: string;
  /** AI 综合生成时记录来源与提示词版本；旧版增量合并结果没有这些字段。 */
  provider?: string;
  model?: string;
  promptVersion?: string;
  unresolvedQuestions?: string[];
}

export interface CourseBundle {
  manifest: CourseManifest;
  knowledge: CourseKnowledge;
  digests: Record<string, DocumentDigest>;
}

export interface ImportOptions {
  generateSummary: boolean;
  generateMindmap: boolean;
  mergeIntoCourse: boolean;
  includeConversationInsights: boolean;
}

export interface DocumentProcessing {
  phase: 'document' | 'course';
  status: 'queued' | 'running' | 'failed';
  options: ImportOptions;
  updatedAt: string;
  error?: string;
}

export interface PdfMetadata {
  fingerprint: string;
  pageCount: number;
}

export interface ImportResult {
  bundle: CourseBundle;
  document: DocumentRecord;
}

export interface CourseStorage {
  readonly label: string;
  loadGlossary?(): Promise<Glossary>;
  saveGlossary?(glossary: Glossary): Promise<void>;
  initialize(name: string): Promise<CourseBundle>;
  load(): Promise<CourseBundle>;
  /** Save a readable PDF and its queue record without creating a fake digest. */
  savePdf(file: File, metadata: PdfMetadata, options: ImportOptions, expectedRevision: number): Promise<ImportResult>;
  setDocumentProcessing(documentId: string, processing: DocumentProcessing | undefined, expectedRevision: number): Promise<CourseBundle>;
  /** Publish one course synthesis covering all listed ready documents. */
  mergeDocuments(documentIds: string[], expectedRevision: number, aiKnowledge: AiCourseKnowledge): Promise<CourseBundle>;
  /**
   * aiKnowledge 是预先用 AI 综合好的课程知识库内容；
   * 提供时不再走本地名称匹配合并，但 user 节点仍由存储层强制保留。
   */
  importDocument(
    file: File,
    digest: DocumentDigest,
    options: ImportOptions,
    expectedRevision: number,
    aiKnowledge?: AiCourseKnowledge,
  ): Promise<ImportResult>;
  /** digest 提供时用 AI 重新生成的摘要替换已存摘要并重绘成果。 */
  updateDocumentArtifacts(
    documentId: string,
    expectedRevision: number,
    digest?: DocumentDigest,
  ): Promise<CourseBundle>;
  mergeDocument(
    documentId: string,
    expectedRevision: number,
    aiKnowledge?: AiCourseKnowledge,
  ): Promise<CourseBundle>;
  openPdf(documentId: string): Promise<File>;
  /**
   * 删除一份 PDF 及其全部成果（原文件、总结、脑图）；版本号推进并把删除前
   * 的状态写入 History。删除的文档已纳入课程时，可传入用剩余资料重新综合好
   * 的 aiKnowledge 重建课程知识库；省略时退回本地清理，只移除该文档的贡献。
   */
  removeDocument(
    documentId: string,
    expectedRevision: number,
    aiKnowledge?: AiCourseKnowledge,
  ): Promise<CourseBundle>;
  /**
   * 删除整门课程。桌面端把课程目录移入系统回收站（无回收站时直接删除）；
   * 浏览器端清空授权文件夹中的全部内容，文件夹本身由系统保留。
   * 课程列表记录的清理由调用方负责。
   */
  deleteCourse(): Promise<void>;
  /** 读取课程目录中已发布的页面译文；仅桌面固定工作区实现此能力。 */
  listTranslations?(
    documentId: string,
  ): Promise<import('../shared-translation.ts').SharedTranslationRecord[]>;
  /** 发布已完成的页面译文；仅桌面固定工作区实现此能力。 */
  publishTranslation?(
    documentId: string,
    translation: import('../shared-translation.ts').SharedTranslationRecord,
  ): Promise<void>;
}

export interface DirectoryPermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

export interface WritableFileHandle {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFileHandle>;
}

export interface BrowserDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BrowserDirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BrowserFileHandle>;
  queryPermission?(
    descriptor?: DirectoryPermissionDescriptor,
  ): Promise<PermissionState>;
  requestPermission?(
    descriptor?: DirectoryPermissionDescriptor,
  ): Promise<PermissionState>;
  /** 与 FileSystemDirectoryHandle.removeEntry 一致；课程删除需要它。 */
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
  /** 与 FileSystemDirectoryHandle.values 一致；课程删除时枚举条目用。 */
  values?(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
}

export interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<BrowserDirectoryHandle>;
}
