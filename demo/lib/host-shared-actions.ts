import {
  chatSettingsConfigured,
  createChatProviderForSettings,
  createChatService,
  loadChatSettings,
  type ChatScope,
  type PageConversation,
} from './chat-cache.ts';
import type { ChatMessage } from './chat.ts';
import type {
  CourseStorage,
  DocumentRecord,
} from './course-storage/types.ts';
import {
  readDocumentChatIndex,
  retrieveDocumentChunks,
} from './document-chat.ts';
import { EMPTY_GLOSSARY } from './glossary.ts';
import {
  createOcrProviderForSettings,
  createOcrService,
  pageNeedsOcr,
  resolvePageOcr,
} from './ocr.ts';
import { extractPageText, renderPageImage } from './page-vision.ts';
import { loadPdfjs } from './pdfjs.ts';
import {
  createProviderForSettings,
  createReaderService,
  loadReaderSettings,
  resolvePageTranslation,
} from './reader-cache.ts';
import { publishCachedTranslationForReader } from './shared-translation.ts';

function assertPage(document: DocumentRecord, page: number): void {
  if (!Number.isInteger(page) || page < 1 || page > document.pageCount) {
    throw new Error(`page 超出 PDF 页数（共 ${document.pageCount} 页）。`);
  }
}

async function openPdf(storage: CourseStorage, document: DocumentRecord) {
  const file = await storage.openPdf(document.id);
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data }).promise;
}

export async function translateSharedPage(input: {
  storage: CourseStorage;
  document: DocumentRecord;
  page: number;
  targetLanguage: string;
  bypassCache?: boolean;
  signal?: AbortSignal;
}): Promise<{
  pageNumber: number;
  targetLanguage: string;
  paragraphs: string[];
  provider: string;
  model: string;
  updatedAt: string;
}> {
  const targetLanguage = input.targetLanguage.trim();
  input.signal?.throwIfAborted();
  assertPage(input.document, input.page);
  if (!targetLanguage || targetLanguage.length > 128) {
    throw new Error('目标语言必须是 1–128 个字符。');
  }
  const pdfDoc = await openPdf(input.storage, input.document);
  let sourceText = await extractPageText(pdfDoc, input.page);
  if (pageNeedsOcr(sourceText)) {
    const chatSettings = loadChatSettings();
    if (!chatSettingsConfigured(chatSettings)) {
      throw new Error(
        '当前页需要 OCR，请先在主电脑的 AI 答疑设置中配置视觉模型。',
      );
    }
    const image = await renderPageImage(pdfDoc, input.page, {
      signal: input.signal,
      maxDimension: 2200,
      maxPixels: 4_000_000,
    });
    const ocr = await resolvePageOcr({
      provider: createOcrProviderForSettings(chatSettings),
      cache: createOcrService(),
      request: {
        fingerprint: input.document.fingerprint,
        pageNumber: input.page,
        pageImage: image,
      },
      bypassCache: input.bypassCache,
      signal: input.signal,
    });
    sourceText = ocr.result.text;
  }
  const glossary = (await input.storage.loadGlossary?.()) ?? EMPTY_GLOSSARY;
  const outcome = await resolvePageTranslation({
    provider: createProviderForSettings(loadReaderSettings()),
    cache: createReaderService().cache,
    fingerprint: input.document.fingerprint,
    request: {
      glossary,
      text: sourceText,
      sourceLanguage: 'auto',
      targetLanguage,
      pageNumber: input.page,
    },
    bypassCache: input.bypassCache,
    publishedTranslations:
      (await input.storage.listTranslations?.(input.document.id)) ?? [],
    signal: input.signal,
  });
  const publication = await publishCachedTranslationForReader(
    input.storage,
    outcome.cacheEntry,
    input.document.id,
  );
  if (publication.status === 'failed') {
    throw new Error(publication.error ?? '译文发布失败。');
  }
  return {
    pageNumber: input.page,
    targetLanguage,
    paragraphs: outcome.cacheEntry.paragraphs,
    provider: outcome.cacheEntry.provider,
    model: outcome.cacheEntry.model,
    updatedAt: outcome.cacheEntry.updatedAt,
  };
}

function conversationPage(scope: ChatScope, page: number): number {
  return scope === 'document' ? 0 : page;
}

function newMessage(
  role: 'user' | 'assistant',
  content: string,
  allowWebSearch?: boolean,
): ChatMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(allowWebSearch === false ? { allowWebSearch } : {}),
  };
}

export async function getSharedConversation(input: {
  document: DocumentRecord;
  page: number;
  scope: ChatScope;
}): Promise<PageConversation | null> {
  assertPage(input.document, input.page);
  return (
    (await createChatService().load(
      input.document.fingerprint,
      conversationPage(input.scope, input.page),
      input.scope,
    )) ?? null
  );
}

export async function clearSharedConversation(input: {
  document: DocumentRecord;
  page: number;
  scope: ChatScope;
}): Promise<{ cleared: true }> {
  assertPage(input.document, input.page);
  await createChatService().delete(
    input.document.fingerprint,
    conversationPage(input.scope, input.page),
    input.scope,
  );
  return { cleared: true };
}

export async function askSharedDocument(input: {
  storage: CourseStorage;
  document: DocumentRecord;
  page: number;
  scope: ChatScope;
  question: string;
  allowWebSearch?: boolean;
  signal?: AbortSignal;
}): Promise<PageConversation> {
  const question = input.question.trim();
  input.signal?.throwIfAborted();
  assertPage(input.document, input.page);
  if (!question || question.length > 8_000) {
    throw new Error('问题必须是 1–8000 个字符。');
  }
  const settings = loadChatSettings();
  if (!chatSettingsConfigured(settings)) {
    throw new Error('请先在主电脑配置 AI 答疑接口、API Key 和视觉模型。');
  }
  const service = createChatService();
  const storedPage = conversationPage(input.scope, input.page);
  const existing = await service.load(
    input.document.fingerprint,
    storedPage,
    input.scope,
  );
  const history = existing?.messages ?? [];
  const pdfDoc = await openPdf(input.storage, input.document);
  const documentChunks =
    input.scope === 'document'
      ? retrieveDocumentChunks(
          await readDocumentChatIndex(
            pdfDoc,
            input.signal ?? new AbortController().signal,
          ),
          question,
          history,
        )
      : undefined;
  if (documentChunks && documentChunks.length === 0) {
    throw new Error('未检索到相关文字，请补充文档中的关键词或页码。');
  }
  const [pageText, pageImage] = documentChunks
    ? [documentChunks.map((chunk) => chunk.text).join('\n'), undefined]
    : await Promise.all([
        extractPageText(pdfDoc, input.page),
        renderPageImage(pdfDoc, input.page, { signal: input.signal }),
      ]);
  const user = newMessage('user', question, input.allowWebSearch);
  const result = await createChatProviderForSettings(settings).answer(
    {
      fingerprint: input.document.fingerprint,
      pageNumber: input.page,
      pageText,
      pageImage,
      documentChunks,
      messages: history,
      question,
      allowWebSearch: input.allowWebSearch,
    },
    { signal: input.signal },
  );
  input.signal?.throwIfAborted();
  const assistant = newMessage('assistant', result.content);
  const now = new Date().toISOString();
  const conversation: PageConversation = {
    fingerprint: input.document.fingerprint,
    pageNumber: storedPage,
    ...(input.scope === 'document' ? { scope: input.scope } : {}),
    messages: [...history, user, assistant],
    createdAt: existing?.createdAt ?? user.createdAt,
    updatedAt: now,
  };
  await service.save(conversation);
  return conversation;
}
