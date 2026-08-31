export const COURSE_SCHEMA_VERSION = 1 as const;

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

export interface DocumentDigest {
  schemaVersion: typeof COURSE_SCHEMA_VERSION;
  documentId: string;
  fingerprint: string;
  title: string;
  overview: string;
  sections: DigestSection[];
  concepts: DigestConcept[];
  relations: ConceptRelation[];
  unresolvedQuestions: string[];
  sourcePages: number[];
  promptVersion: 'local-structure-v1';
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

export interface CourseKnowledge {
  schemaVersion: typeof COURSE_SCHEMA_VERSION;
  courseId: string;
  version: number;
  nodes: KnowledgeNode[];
  relations: ConceptRelation[];
  conflicts: KnowledgeConflict[];
  updatedAt: string;
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
  importDocument(
    file: File,
    digest: DocumentDigest,
    options: ImportOptions,
    expectedRevision: number,
  ): Promise<ImportResult>;
  updateDocumentArtifacts(
    documentId: string,
    expectedRevision: number,
  ): Promise<CourseBundle>;
  mergeDocument(
    documentId: string,
    expectedRevision: number,
  ): Promise<CourseBundle>;
  openPdf(documentId: string): Promise<File>;
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
}

export interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<BrowserDirectoryHandle>;
}
