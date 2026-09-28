import { sanitizeFileName, stableDocumentId, suffixFileName } from './file-utils.ts';
import type { CourseBundle, DocumentProcessing, DocumentRecord, ImportOptions, PdfMetadata } from './types.ts';

export function rawPdfRecord(bundle: CourseBundle, file: File, metadata: PdfMetadata, options: ImportOptions): DocumentRecord {
  if (!/^[a-f0-9]{64}$/i.test(metadata.fingerprint) || !Number.isInteger(metadata.pageCount) || metadata.pageCount < 1)
    throw new Error('PDF 指纹或页数无效。');
  if (bundle.manifest.documents.some(item => item.fingerprint === metadata.fingerprint))
    throw new Error('这份 PDF 已经在课程中，未重复导入。');
  const used = new Set(bundle.manifest.documents.map(item => item.storedFileName));
  const safeName = sanitizeFileName(file.name);
  let storedFileName = safeName;
  let suffix = 0;
  while (used.has(storedFileName)) storedFileName = suffixFileName(safeName, `${metadata.fingerprint.slice(0, 8)}${suffix++ ? `-${suffix}` : ''}`);
  const now = new Date().toISOString();
  const processing: DocumentProcessing | undefined = options.generateSummary || options.generateMindmap || options.mergeIntoCourse
    ? { phase: 'document', status: 'queued', options: {...options}, updatedAt: now } : undefined;
  return { id: stableDocumentId(metadata.fingerprint), fingerprint: metadata.fingerprint, fileName: file.name, storedFileName,
    pageCount: metadata.pageCount, status: 'copied', includedInCourse: false, includeConversationInsights: options.includeConversationInsights,
    hasSummary: false, hasMindmap: false, importedAt: now, updatedAt: now, ...(processing ? {processing} : {}) };
}

export function artifactsReady(document: DocumentRecord): DocumentRecord {
  const job = document.processing;
  const now = new Date().toISOString();
  return {...document, hasSummary: job?.options.generateSummary ?? true, hasMindmap: job?.options.generateMindmap ?? true,
    status: document.includedInCourse ? 'course-merged' : 'document-artifacts-ready', updatedAt: now,
    processing: job?.options.mergeIntoCourse ? {...job, phase:'course', status:'queued', error:undefined, updatedAt:now} : undefined };
}

export function processingBundle(current: CourseBundle, documentId: string, processing: DocumentProcessing | undefined): CourseBundle {
  if (!current.manifest.documents.some(item => item.id === documentId)) throw new Error('文档不存在。');
  const now = new Date().toISOString();
  return {...current, manifest:{...current.manifest, revision:current.manifest.revision+1, updatedAt:now,
    documents:current.manifest.documents.map(item => item.id === documentId ? {...item, processing, updatedAt:now} : item)}};
}
