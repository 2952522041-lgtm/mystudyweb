export const COURSE_SCHEMA_VERSION = 1 as const;
/** AI 生成的 DocumentDigest 使用 schemaVersion 2；本地规则生成的旧摘要仍为 1。 */
export const DIGEST_SCHEMA_VERSION = 2 as const;
/** AI 生成的课程知识库使用 schemaVersion 2；旧版增量合并结果仍为 1。 */
export const KNOWLEDGE_SCHEMA_VERSION = 2 as const;

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
  pageStart: number;
  pageEnd: number;
}

export interface DigestConcept {
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
  schemaVersion: 1 | 2;
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
  theme: string;
  nodes: Array<{
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
  schemaVersion: 1 | 2;
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

export interface ImportResult {
  bundle: CourseBundle;
  document: DocumentRecord;
}

export interface CourseStorage {
  readonly label: string;
  initialize(name: string): Promise<CourseBundle>;
  load(): Promise<CourseBundle>;
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
   * 删除一份 PDF 及其全部成果（原文件、总结、脑图），并从课程知识库中移除
   * 它的贡献；版本号推进并把删除前的状态写入 History。
   */
  removeDocument(
    documentId: string,
    expectedRevision: number,
  ): Promise<CourseBundle>;
  /**
   * 删除整门课程。桌面端把课程目录移入系统回收站（无回收站时直接删除）；
   * 浏览器端清空授权文件夹中的全部内容，文件夹本身由系统保留。
   * 课程列表记录的清理由调用方负责。
   */
  deleteCourse(): Promise<void>;
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
  removeEntry?(
    name: string,
    options?: { recursive?: boolean },
  ): Promise<void>;
  /** 与 FileSystemDirectoryHandle.values 一致；课程删除时枚举条目用。 */
  values?(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
}

export interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<BrowserDirectoryHandle>;
}
