import { BackgroundImports } from './background-imports.ts';
import {
  updateTaskBundle,
  updateTaskProgress,
} from './background-task-store.ts';
import { loadKnowledgeSettings } from './knowledge-settings.ts';
import { loadChatSettings } from './chat-cache.ts';
import { EMPTY_GLOSSARY } from './glossary.ts';
import { createKnowledgeProviderForSettings } from './knowledge/ai-knowledge-provider.ts';
import { courseKnowledgeFromSingleDigest } from './knowledge/single-document-course.ts';
import { knowledgeStageMessage } from './knowledge/synthesis-progress.ts';
import { extractPdfPages } from './knowledge/document-digest.ts';
import {
  createOcrProviderForSettings,
  createOcrService,
  resolvePageOcr,
} from './ocr.ts';
import type { CourseBundle, DocumentDigest } from './course-storage/types.ts';

/** Runs inside either the browser adapter or the desktop's dedicated task window. */
export function createBackgroundProcessor(options: {
  onBundle(courseId: string, bundle: CourseBundle): void;
  onProgress?(message: string): void;
  onError?(message: string): void;
  execute?: boolean;
  onWake?(): void;
}) {
  return new BackgroundImports({
    ...options,
    onBundle: (id, bundle) => {
      if (options.execute !== false) updateTaskBundle(bundle);
      options.onBundle(id, bundle);
    },
    onTaskProgress: updateTaskProgress,
    analyze: async (storage, document, signal, progress) => {
      const provider = createKnowledgeProviderForSettings(
        loadKnowledgeSettings(),
      );
      const glossary = (await storage.loadGlossary?.()) ?? EMPTY_GLOSSARY;
      const ocrProvider = createOcrProviderForSettings(loadChatSettings());
      const cache = createOcrService();
      const file = await storage.openPdf(document.id);
      const extracted = await extractPdfPages(file, {
        signal,
        recognizePage: (request) =>
          resolvePageOcr({
            provider: ocrProvider,
            cache,
            request: { ...request, task: 'background' },
            signal: request.signal,
          }).then((value) => value.result.text),
        onProgress: (page, count, stage) =>
          progress(`${stage === 'ocr' ? 'OCR' : '提取文字'} ${page}/${count}`),
      });
      if (extracted.fingerprint !== document.fingerprint)
        throw new Error(
          '课程中的 PDF 已被外部替换；请重新导入新文件，原任务未覆盖已有成果。',
        );
      return provider.analyzeDocument({
        signal,
        glossary,
        fingerprint: document.fingerprint,
        documentId: document.id,
        fileName: document.fileName,
        pages: extracted.pages,
        onStage: (stage, detail) =>
          progress(knowledgeStageMessage(stage, detail)),
      });
    },
    synthesize: async (current, ids, storage, signal) => {
      const digests = current.manifest.documents
        .filter((doc) => doc.includedInCourse || ids.includes(doc.id))
        .map((doc) => current.digests[doc.id])
        .filter((digest): digest is DocumentDigest => Boolean(digest));
      const userNodeLabels = current.knowledge.nodes
        .filter((node) => node.ownership === 'user')
        .map((node) => node.label);
      const reused = courseKnowledgeFromSingleDigest(digests, userNodeLabels);
      if (reused) return reused;
      return createKnowledgeProviderForSettings(
        loadKnowledgeSettings(),
      ).synthesizeCourseKnowledge({
        signal,
        glossary: (await storage.loadGlossary?.()) ?? EMPTY_GLOSSARY,
        courseId: current.manifest.id,
        courseName: current.manifest.name,
        digests,
        userNodeLabels,
      });
    },
  });
}
