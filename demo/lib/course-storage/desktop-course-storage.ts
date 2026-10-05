import { stageCourseReviewBundle, resolveCourseReviewBundle } from './course-review.ts';
import { EMPTY_GLOSSARY, parseGlossary, type Glossary } from '../glossary.ts';
import { rawPdfRecord, artifactsReady, processingBundle } from './background-records.ts';
import type { DocumentProcessing, PdfMetadata } from './types.ts';
import type { YeyuDesktopApi } from '../../electron/api';
import { assertNotesUnchanged, isHistoryKnowledge, notesSnapshot, withLocalWriteLock, type CourseHistoryEntry } from './study-tools.ts';
import {
  assertSafeArtifactContent,
  createCourseId,
  sanitizeFileName,
  suffixFileName,
} from './file-utils.ts';
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
import {
  renderCourseSummary,
  renderDocumentSummary,
  renderKnowledgeSvg,
} from '../knowledge/artifact-renderer.ts';
import {
  encodeSharedTranslation,
  SHARED_TRANSLATION_MAX_BYTES,
  sharedTranslationFileName,
  validateSharedTranslation,
  type SharedTranslationRecord,
} from '../shared-translation.ts';

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

  async loadGlossary(): Promise<Glossary> {
    if (!await this.api.exists(this.directoryName, ['glossary.json'])) return structuredClone(EMPTY_GLOSSARY);
    return parseGlossary(await readJson(this.api, this.directoryName, ['glossary.json']));
  }
  async saveGlossary(glossary: Glossary): Promise<void> {
    const content = encodeJson(parseGlossary(glossary));
    await this.withWriteLock(() => this.api.writeFile(this.directoryName, ['glossary.json'], content));
  }

  async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.api.acquireCourseLock || !this.api.releaseCourseLock) return withLocalWriteLock(this, operation);
    const token = await this.api.acquireCourseLock(this.directoryName);
    try { return await operation(); }
    finally { await this.api.releaseCourseLock(token); }
  }

  async loadNotes() {
    const path = ['我的课程笔记.md'];
    return notesSnapshot(await this.api.exists(this.directoryName, path)
      ? decoder.decode(await this.api.readFile(this.directoryName, path)) : '');
  }

  async saveNotes(content: string, expectedToken: string) {
    return this.withWriteLock(async () => {
      assertSafeArtifactContent(content);
      assertNotesUnchanged(await this.loadNotes(), expectedToken);
      await writeText(this.api, this.directoryName, ['我的课程笔记.md'], content);
      return notesSnapshot(content);
    });
  }

  async listHistory(): Promise<CourseHistoryEntry[]> {
    if (!this.api.listFiles) return [];
    const history: CourseHistoryEntry[] = [];
    for (const file of await this.api.listFiles(this.directoryName, ['History'])) {
      if (!/^revision-\d+-\d+\.json$/.test(file)) continue;
      try {
        const entry = await readJson<CourseHistoryEntry>(this.api, this.directoryName, ['History', file]);
        if (isHistoryKnowledge(entry.knowledge) && typeof entry.summary === 'string' && typeof entry.updatedAt === 'string') history.push({...entry, id:file, source:'snapshot'});
      } catch { /* A partial external snapshot must not hide valid versions. */ }
    }
    // Older desktop versions did not index History subdirectories. Their
    // immutable Knowledge files still provide honest artifact-only previews.
    const bundle = await this.load();
    for (const file of await this.api.listFiles(this.directoryName, ['Knowledge'])) {
      if (!/^knowledge-v\d+\.json$/.test(file)) continue;
      try {
        const knowledge = await readJson<unknown>(this.api, this.directoryName, ['Knowledge', file]);
        if (!isHistoryKnowledge(knowledge) || knowledge.courseId !== bundle.manifest.id || knowledge.version === bundle.knowledge.version || history.some(entry => entry.knowledge.version === knowledge.version)) continue;
        history.push({ id:file, updatedAt:knowledge.updatedAt, knowledge, summary:'', source:'knowledge' });
      } catch { /* Ignore damaged individual versions. */ }
    }
    return history.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    const manifest = await readJson<CourseManifest>(
      this.api,
      this.directoryName,
      ['course.json'],
    );
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

  async savePdf(file: File, metadata: PdfMetadata, options: ImportOptions, expectedRevision: number): Promise<ImportResult> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    const document = rawPdfRecord(current, file, metadata, options);
    await this.api.writeFile(this.directoryName, ['PDFs', document.storedFileName], new Uint8Array(await file.arrayBuffer()));
    const bundle = {...current, manifest:{...current.manifest, revision:current.manifest.revision+1, updatedAt:document.updatedAt, documents:[...current.manifest.documents, document]}};
    await this.createRevision(current);
    await this.api.writeFile(this.directoryName, ['course.json'], encodeJson(bundle.manifest));
    return {bundle, document};
  }

  async setDocumentProcessing(documentId: string, processing: DocumentProcessing | undefined, expectedRevision: number): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    const next = processingBundle(current, documentId, processing);
    await this.api.writeFile(this.directoryName, ['course.json'], encodeJson(next.manifest));
    return next;
  }

  async stageCourseReview(documentIds: string[], expectedRevision: number, knowledge: AiCourseKnowledge): Promise<CourseBundle> {
    const current = await this.load();
    this.assertRevision(current.manifest, expectedRevision);
    const next = await stageCourseReviewBundle(current, documentIds, knowledge);
    await this.api.writeFile(this.directoryName, ['course.json'], encodeJson(next.manifest));
    return next;
  }

  async resolveCourseReview(reviewId: string, accept: boolean): Promise<CourseBundle> {
    return this.withWriteLock(async () => {
      const current = await this.load();
      const next = await resolveCourseReviewBundle(current, reviewId, accept);
      if (accept) { await this.createRevision(current); await this.writeBundle(next, true); }
      else { await this.api.writeFile(this.directoryName, ['course.json'], encodeJson(next.manifest)); }
      return next;
    });
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
    if (!activeDigest)
      throw new Error('这份 PDF 的内部摘要缺失，无法生成成果。');
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
    const data = await this.api.readFile(this.directoryName, [
      'PDFs',
      document.storedFileName,
    ]);
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return new File([copy], document.fileName, { type: 'application/pdf' });
  }

  async listTranslations(
    documentId: string,
  ): Promise<SharedTranslationRecord[]> {
    const listFiles = this.api.listFiles?.bind(this.api);
    if (!listFiles) return [];
    let bundle: CourseBundle;
    try {
      bundle = await this.load();
    } catch {
      return [];
    }
    const document = bundle.manifest.documents.find(
      (item) => item.id === documentId,
    );
    if (!document) return [];

    let fileNames: string[];
    try {
      fileNames = await listFiles(this.directoryName, [
        'Translations',
        documentId,
      ]);
    } catch {
      // A missing directory is normal before the first publish. Other
      // transient filesystem failures should not prevent opening the PDF.
      return [];
    }

    const records: SharedTranslationRecord[] = [];
    for (const fileName of fileNames) {
      if (!/^[a-f0-9]{64}\.json$/i.test(fileName)) continue;
      try {
        const data = await this.api.readFile(this.directoryName, [
          'Translations',
          documentId,
          fileName,
        ]);
        if (data.byteLength > SHARED_TRANSLATION_MAX_BYTES) continue;
        const parsed = JSON.parse(decoder.decode(data)) as unknown;
        const valid = validateSharedTranslation(parsed, {
          documentId,
          fingerprint: document.fingerprint,
          pageCount: document.pageCount,
        });
        if (!valid || valid.provider === 'mock') continue;
        if ((await sharedTranslationFileName(valid)) !== fileName) continue;
        records.push(valid);
      } catch {
        // Corrupt, partial, missing, or replaced records are ignored; the
        // reader can still show other pages and retry on a later open.
      }
    }
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return records;
  }

  async publishTranslation(
    documentId: string,
    translation: SharedTranslationRecord,
  ): Promise<void> {
    // A document deletion must not run between validation and publication and
    // leave an orphaned Translations directory behind. AI has already finished.
    await this.withWriteLock(async () => {
      const bundle = await this.load();
      const document = bundle.manifest.documents.find(
        (item) => item.id === documentId,
      );
      if (!document) throw new Error('课程中找不到这份 PDF，译文未发布。');
      if (translation.provider === 'mock') {
        throw new Error('演示译文不能发布到课程共享目录。');
      }
      const valid = validateSharedTranslation(translation, {
        documentId,
        fingerprint: document.fingerprint,
        pageCount: document.pageCount,
      });
      if (!valid) throw new Error('译文记录格式不正确，未发布。');
      const fileName = await sharedTranslationFileName(valid);
      await this.api.writeFile(
        this.directoryName,
        ['Translations', documentId, fileName],
        encodeSharedTranslation(valid),
      );
    });
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
    // Publish the removal before irreversible cleanup. A close/crash before
    // manifest commit keeps the old PDF readable; after commit it can only
    // leave unreferenced files, never a manifest pointing at deleted bytes.
    await this.api.deleteFile(this.directoryName, ['PDFs', document.storedFileName]);
    await this.api.deleteFile(this.directoryName, documentDirectory(documentId));
    await this.api.deleteFile(this.directoryName, ['Translations', documentId]);
    return bundle;
  }

  async deleteCourse(): Promise<void> {
    await this.api.deleteCourseDirectory(this.directoryName);
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
    await this.api.writeFile(this.directoryName, ['History', `${name}.json`], encodeJson({
      id:name, revision:current.manifest.revision, updatedAt:current.manifest.updatedAt,
      knowledge:current.knowledge, summary:renderCourseSummary(current.manifest, current.knowledge), source:'snapshot',
    } satisfies CourseHistoryEntry));
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
