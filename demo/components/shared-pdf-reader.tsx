'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  Languages,
  LoaderCircle,
  MessageCircle,
  Minus,
  Network,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
} from 'lucide-react';

import { DocumentSummaryPanel } from '@/components/document-summary-panel';
import { KnowledgeMindmap } from '@/components/knowledge-mindmap';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { DocumentDigest } from '@/lib/course-storage/types';
import {
  loadPdfjs,
  type PDFDocumentProxy,
  type RenderTask,
  type TextLayer,
} from '@/lib/pdfjs';
import { itemsFromPdfJs } from '@/lib/pdf-text';
import { shouldBuildTextLayer, textLayerScale } from '@/lib/pdf-text-layer';
import {
  askSharedDocument,
  clearSharedConversation,
  loadSharedConversation,
  loadSharedReadingState,
  loadSharedTranslations,
  saveSharedReadingState,
  SharedApiError,
  type SharedGeneratedTranslation,
  translateSharedPage,
  type SharedReadingState,
} from '@/lib/lan-share-api';
import type { ChatScope, PageConversation } from '@/lib/chat-cache';
import type { SharedTranslationRecord } from '@/lib/shared-translation';

interface PageSize {
  width: number;
  height: number;
}

function SharedPdfPage({
  pdfDoc,
  pageNumber,
  width,
  height,
}: {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let activeTextLayer: TextLayer | null = null;

    void (async () => {
      const pdfPage = await pdfDoc.getPage(pageNumber);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = textLayerScale(width, base.width);
      const viewport = pdfPage.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
      await renderTask.promise;
      if (!cancelled) setRendering(false);
    })().catch(() => {
      if (!cancelled) setRendering(false);
    });

    void (async () => {
      const pdfjs = await loadPdfjs();
      const pdfPage = await pdfDoc.getPage(pageNumber);
      const container = textLayerRef.current;
      if (cancelled || !container) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = textLayerScale(width, base.width);
      const content = await pdfPage.getTextContent();
      if (cancelled) return;
      container.replaceChildren();
      const items = itemsFromPdfJs(
        content.items as Array<{
          str?: string;
          transform?: number[];
          width?: number;
          height?: number;
        }>,
        base.height,
      );
      if (!shouldBuildTextLayer(items)) return;
      container.style.setProperty('--total-scale-factor', String(scale));
      activeTextLayer = new pdfjs.TextLayer({
        textContentSource: content,
        container,
        viewport: pdfPage.getViewport({ scale }),
      });
      await activeTextLayer.render();
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      renderTask?.cancel();
      activeTextLayer?.cancel();
    };
  }, [pdfDoc, pageNumber, width, height]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="block bg-white"
        aria-label={`第 ${pageNumber} 页内容`}
      />
      <div ref={textLayerRef} className="pdf-text-layer" aria-hidden="true" />
      {rendering ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white">
          <LoaderCircle className="size-6 animate-spin text-slate-400" />
        </div>
      ) : null}
    </>
  );
}

function documentKnowledge(digest: DocumentDigest) {
  return {
    schemaVersion: 2 as const,
    courseId: digest.documentId,
    version: 1,
    nodes: [
      {
        id: `course:${digest.documentId}`,
        label: digest.title,
        description: digest.overview,
        kind: 'course' as const,
        ownership: 'generated' as const,
        sources: [],
      },
      ...digest.concepts.map((concept) => ({
        id: concept.id,
        label: concept.label,
        description: concept.description,
        kind: 'concept' as const,
        ownership: 'generated' as const,
        sources: concept.sources,
      })),
    ],
    relations: digest.relations,
    conflicts: [],
    updatedAt: digest.updatedAt,
    unresolvedQuestions: digest.unresolvedQuestions,
  };
}

function formatTranslationTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function SharedTranslationPanel({
  courseId,
  documentId,
  page,
  canUseAi,
  onSessionExpired,
}: {
  courseId: string;
  documentId: string;
  page: number;
  canUseAi: boolean;
  onSessionExpired?: () => void;
}) {
  const [records, setRecords] = useState<SharedTranslationRecord[]>([]);
  const [targetLanguage, setTargetLanguage] = useState('简体中文');
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatedTranslation, setGeneratedTranslation] = useState<{
    documentId: string;
    record: SharedGeneratedTranslation;
  } | null>(null);
  const translationAbortRef = useRef<AbortController | null>(null);
  const translationRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadSharedTranslations(courseId, documentId)
      .then((payload) => {
        if (!cancelled) setRecords(payload.translations);
      })
      .catch((loadError) => {
        if (cancelled) return;
        if (loadError instanceof SharedApiError && loadError.status === 401) {
          onSessionExpired?.();
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : '译文暂时无法读取，请刷新后重试。',
        );
        setRecords([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, documentId, refreshToken, onSessionExpired]);

  useEffect(
    () => () => {
      translationAbortRef.current?.abort();
      translationAbortRef.current = null;
      translationRequestRef.current += 1;
      setGeneratedTranslation(null);
    },
    [courseId, documentId, page],
  );

  const languages = useMemo(() => {
    const seen = new Set<string>();
    return [...records]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((record) => record.targetLanguage)
      .filter((language) => {
        if (seen.has(language)) return false;
        seen.add(language);
        return true;
      });
  }, [records]);

  useEffect(() => {
    if (canUseAi) return;
    if (languages.length === 0) return;
    let recent = '';
    try {
      recent =
        window.localStorage.getItem(
          `yeyu-shared-translation-language:${documentId}`,
        ) ?? '';
    } catch {
      // Browser storage can be disabled; most recently updated remains valid.
    }
    setTargetLanguage((current) =>
      languages.includes(current)
        ? current
        : recent && languages.includes(recent)
          ? recent
          : languages[0]!,
    );
  }, [canUseAi, documentId, languages]);

  const publishedCurrent = records.find(
    (record) =>
      record.pageNumber === page &&
      record.targetLanguage === targetLanguage.trim(),
  );
  const generatedCurrent =
    generatedTranslation?.documentId === documentId &&
    generatedTranslation.record.pageNumber === page &&
    generatedTranslation.record.targetLanguage === targetLanguage.trim()
      ? generatedTranslation.record
      : undefined;
  const current = generatedCurrent ?? publishedCurrent;

  const selectLanguage = (language: string) => {
    setTargetLanguage(language);
    try {
      window.localStorage.setItem(
        `yeyu-shared-translation-language:${documentId}`,
        language,
      );
    } catch {
      // The choice is still applied for this session.
    }
  };

  const cancelTranslation = () => {
    translationAbortRef.current?.abort();
    translationAbortRef.current = null;
  };

  const generateTranslation = async () => {
    const language = targetLanguage.trim();
    if (!canUseAi || !language || generating) return;
    translationAbortRef.current?.abort();
    const controller = new AbortController();
    const requestId = ++translationRequestRef.current;
    translationAbortRef.current = controller;
    setGenerating(true);
    setError(null);
    try {
      const result = await translateSharedPage(
        courseId,
        documentId,
        page,
        language,
        true,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        requestId !== translationRequestRef.current
      ) {
        return;
      }
      setGeneratedTranslation({ documentId, record: result.translation });
      setRefreshToken((value) => value + 1);
    } catch (translationError) {
      if (
        controller.signal.aborted ||
        requestId !== translationRequestRef.current
      ) {
        return;
      }
      if (
        translationError instanceof SharedApiError &&
        translationError.status === 401
      ) {
        onSessionExpired?.();
      }
      setError(
        translationError instanceof Error
          ? translationError.message
          : '译文生成失败，请稍后重试。',
      );
    } finally {
      if (requestId === translationRequestRef.current) {
        setGenerating(false);
        if (translationAbortRef.current === controller) {
          translationAbortRef.current = null;
        }
      }
    }
  };

  return (
    <section className="flex min-h-0 flex-col" aria-label="页面翻译面板">
      <div className="flex items-center gap-2 border-b border-slate-200/80 px-5 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-slate-800">页面翻译</p>
          <p className="mt-1 text-[11px] text-slate-500">
            {canUseAi
              ? '可请求主电脑生成译文，AI 在主电脑执行。'
              : '只显示主电脑已经完成并发布的译文。'}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="刷新译文"
          onClick={() => setRefreshToken((value) => value + 1)}
          disabled={loading}
        >
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
        </Button>
      </div>
      {canUseAi ? (
        <div className="flex flex-wrap items-end gap-2 border-b border-slate-100 px-5 py-3">
          <div className="min-w-0 flex-1">
            <label className="block text-xs text-slate-600">
              <span className="mb-1 block">目标语言</span>
              <input
                aria-label="译文目标语言"
                className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                value={targetLanguage}
                onChange={(event) => setTargetLanguage(event.target.value)}
                placeholder="例如：简体中文"
                disabled={generating}
              />
            </label>
            {languages.length > 0 ? (
              <select
                aria-label="选择已发布译文语言"
                className="mt-1 h-7 w-full rounded-md border border-slate-200 bg-white px-2 text-[11px] text-slate-600"
                value={languages.includes(targetLanguage) ? targetLanguage : ''}
                onChange={(event) => selectLanguage(event.target.value)}
                disabled={generating}
              >
                <option value="">选择已发布译文（可选）</option>
                {languages.map((language) => (
                  <option key={language} value={language}>
                    {language}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          {generating ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={cancelTranslation}
            >
              <Square /> 取消
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void generateTranslation()}
              disabled={!targetLanguage.trim() || loading}
            >
              <Languages /> {current ? '重新翻译' : '生成译文'}
            </Button>
          )}
        </div>
      ) : languages.length > 0 ? (
        <label className="flex items-center gap-2 px-5 py-3 text-xs text-slate-600">
          <span className="shrink-0">目标语言</span>
          <select
            aria-label="译文目标语言"
            className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800"
            value={targetLanguage}
            onChange={(event) => selectLanguage(event.target.value)}
          >
            {languages.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {loading ? (
          <div className="flex min-h-40 items-center justify-center text-xs text-slate-500">
            <LoaderCircle className="mr-2 size-4 animate-spin" /> 正在读取译文…
          </div>
        ) : error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-xs leading-5 text-rose-700">
            {error}
          </p>
        ) : !current ? (
          <div className="flex min-h-40 flex-col items-center justify-center px-3 text-center">
            <Languages className="size-7 text-slate-300" />
            <p className="mt-3 text-sm font-medium text-slate-700">
              主电脑尚未翻译第 {page} 页
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              {canUseAi
                ? '输入目标语言并生成，完成后即可在这里查看。'
                : '主电脑完成翻译并发布后，点击“刷新译文”即可查看。'}
            </p>
          </div>
        ) : (
          <article className="translation-copy pt-1">
            <p className="mb-4 text-[11px] text-slate-500">
              {current.targetLanguage} ·{' '}
              {formatTranslationTime(current.updatedAt)}
              {current.model ? ` · ${current.model}` : ''}
            </p>
            {current.paragraphs.map((paragraph, index) => (
              <p
                key={`${current.pageNumber}-${current.targetLanguage}-${current.updatedAt}-${index}`}
              >
                {paragraph}
              </p>
            ))}
          </article>
        )}
      </div>
    </section>
  );
}

function SharedChatPanel({
  courseId,
  documentId,
  page,
  canUseAi,
  onSessionExpired,
}: {
  courseId: string;
  documentId: string;
  page: number;
  canUseAi: boolean;
  onSessionExpired?: () => void;
}) {
  const [scope, setScope] = useState<ChatScope>('page');
  const [conversation, setConversation] = useState<PageConversation | null>(
    null,
  );
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const onSessionExpiredRef = useRef(onSessionExpired);

  useEffect(() => {
    onSessionExpiredRef.current = onSessionExpired;
  }, [onSessionExpired]);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    let cancelled = false;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setConversation(null);
    setInput('');
    setPendingQuestion(null);
    setError(null);
    setLoading(canUseAi);
    setSending(false);
    setClearing(false);
    if (!canUseAi) return () => undefined;

    void loadSharedConversation(courseId, documentId, page, scope)
      .then((payload) => {
        if (cancelled || generation !== requestGenerationRef.current) return;
        setConversation(payload.conversation);
      })
      .catch((loadError) => {
        if (cancelled || generation !== requestGenerationRef.current) return;
        if (loadError instanceof SharedApiError && loadError.status === 401) {
          onSessionExpiredRef.current?.();
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : '对话历史暂时无法读取，请稍后重试。',
        );
      })
      .finally(() => {
        if (!cancelled && generation === requestGenerationRef.current) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (requestGenerationRef.current === generation) {
        requestGenerationRef.current += 1;
      }
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    };
  }, [canUseAi, courseId, documentId, page, scope]);

  const sendQuestion = async () => {
    const question = input.trim();
    if (!canUseAi || !question || loading || sending || clearing) return;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = controller;
    setSending(true);
    setPendingQuestion(question);
    setInput('');
    setError(null);
    try {
      const result = await askSharedDocument(
        courseId,
        documentId,
        page,
        scope,
        question,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current
      ) {
        return;
      }
      setConversation(result.conversation);
      setPendingQuestion(null);
    } catch (askError) {
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current
      ) {
        return;
      }
      if (askError instanceof SharedApiError && askError.status === 401) {
        onSessionExpiredRef.current?.();
      }
      setError(
        askError instanceof Error
          ? askError.message
          : '主电脑暂时无法回答，请稍后重试。',
      );
      setInput(question);
      setPendingQuestion(null);
    } finally {
      if (generation === requestGenerationRef.current) {
        setSending(false);
        if (requestAbortRef.current === controller) {
          requestAbortRef.current = null;
        }
      }
    }
  };

  const cancelQuestion = () => {
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setSending(false);
    setPendingQuestion(null);
  };

  const clearConversation = async () => {
    if (!canUseAi || loading || sending || clearing || !conversation) return;
    setClearing(true);
    setError(null);
    try {
      await clearSharedConversation(courseId, documentId, page, scope);
      setConversation(null);
    } catch (clearError) {
      if (clearError instanceof SharedApiError && clearError.status === 401) {
        onSessionExpiredRef.current?.();
      }
      setError(
        clearError instanceof Error
          ? clearError.message
          : '对话清空失败，请稍后重试。',
      );
    } finally {
      setClearing(false);
    }
  };

  const messages = conversation?.messages ?? [];

  return (
    <section
      className="flex min-h-0 flex-col"
      aria-label={
        scope === 'document' ? '全文 AI 答疑' : `第 ${page} 页 AI 答疑`
      }
    >
      <div className="flex items-center gap-2 border-b border-slate-200/80 px-5 py-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
            <MessageCircle className="size-3.5 text-violet-600" /> AI 答疑
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {canUseAi
              ? scope === 'document'
                ? '主电脑基于整份文档回答问题。'
                : `主电脑基于第 ${page} 页回答问题。`
              : '主电脑未开放 AI 能力。'}
          </p>
        </div>
        {canUseAi ? (
          <div className="flex items-center gap-1">
            <select
              aria-label="提问范围"
              className="max-w-24 rounded border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700"
              value={scope}
              onChange={(event) => setScope(event.target.value as ChatScope)}
              disabled={loading || sending || clearing}
            >
              <option value="page">当前页</option>
              <option value="document">全文</option>
            </select>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={
                scope === 'document' ? '清空全文对话' : '清空本页对话'
              }
              onClick={() => void clearConversation()}
              disabled={loading || sending || clearing || messages.length === 0}
            >
              {clearing ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Trash2 />
              )}
            </Button>
          </div>
        ) : null}
      </div>

      {!canUseAi ? (
        <div className="flex min-h-40 flex-1 flex-col items-center justify-center px-6 text-center">
          <MessageCircle className="size-7 text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-700">
            主电脑未开放 AI 答疑
          </p>
          <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
            当前共享会话只提供已生成的课程资料。请在主电脑开启 AI
            能力后重试；API Key 不会传到 Windows。
          </p>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {loading ? (
              <div className="flex min-h-32 items-center justify-center text-xs text-slate-500">
                <LoaderCircle className="mr-2 size-4 animate-spin" />{' '}
                正在读取对话历史…
              </div>
            ) : error && messages.length === 0 && !pendingQuestion ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-xs leading-5 text-rose-700">
                {error}
              </p>
            ) : messages.length === 0 && !pendingQuestion ? (
              <div className="flex min-h-32 flex-col items-center justify-center text-center">
                <MessageCircle className="size-7 text-slate-300" />
                <p className="mt-3 text-sm font-medium text-slate-700">
                  {scope === 'document'
                    ? '就整份文档提问'
                    : `就第 ${page} 页提问`}
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  历史对话会保存在主电脑，页面或范围变化后会重新读取。
                </p>
              </div>
            ) : (
              <>
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[90%] whitespace-pre-wrap rounded-xl px-3 py-2 text-xs leading-5 ${message.role === 'user' ? 'bg-violet-100 text-violet-950' : 'bg-slate-100 text-slate-700'}`}
                    >
                      {message.content}
                    </div>
                  </div>
                ))}
                {pendingQuestion ? (
                  <div className="flex justify-end">
                    <div className="max-w-[90%] whitespace-pre-wrap rounded-xl bg-violet-100 px-3 py-2 text-xs leading-5 text-violet-950">
                      {pendingQuestion}
                    </div>
                  </div>
                ) : null}
                {sending ? (
                  <p className="flex items-center gap-2 text-xs text-slate-500">
                    <LoaderCircle className="size-3.5 animate-spin" />{' '}
                    主电脑正在回答…
                  </p>
                ) : null}
                {error ? (
                  <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
                    {error}
                  </p>
                ) : null}
              </>
            )}
          </div>
          <div className="border-t border-slate-200/80 p-4">
            <textarea
              aria-label="提问内容"
              className="min-h-16 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-800 outline-none placeholder:text-slate-400 focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendQuestion();
                }
              }}
              placeholder={
                scope === 'document' ? '询问整份文档…' : `询问第 ${page} 页…`
              }
              disabled={loading || sending || clearing}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-[11px] text-slate-400">
                Enter 发送，Shift + Enter 换行
              </p>
              {sending ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={cancelQuestion}
                >
                  <Square /> 取消
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void sendQuestion()}
                  disabled={!input.trim() || loading || clearing}
                >
                  <Send /> 发送
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function SharedPdfReader({
  file,
  fileKey,
  courseId,
  documentId,
  digest,
  hasSummary,
  hasMindmap,
  canUseAi = false,
  initialPage = 1,
  onBack,
  onSessionExpired,
}: {
  file: File;
  fileKey: string;
  courseId: string;
  documentId: string;
  digest?: DocumentDigest;
  hasSummary: boolean;
  hasMindmap: boolean;
  canUseAi?: boolean;
  initialPage?: number;
  onBack: () => void;
  onSessionExpired?: () => void;
}) {
  const aiEnabled = canUseAi === true;
  const initialPageTarget = Number.isFinite(initialPage)
    ? Math.max(1, Math.floor(initialPage))
    : 1;
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [page, setPage] = useState(initialPageTarget);
  const [zoom, setZoom] = useState(95);
  const [stageWidth, setStageWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(
    () => new Set([initialPageTarget]),
  );
  const [panel, setPanel] = useState<
    'summary' | 'mindmap' | 'translation' | 'chat'
  >(hasSummary ? 'summary' : hasMindmap ? 'mindmap' : 'translation');
  const stageRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLElement>());
  const pendingPageRef = useRef<number | null>(initialPageTarget);
  const currentPageRef = useRef(initialPageTarget);
  const currentZoomRef = useRef(95);
  const pageCountRef = useRef(0);
  const hostReadingStateRef = useRef<SharedReadingState | null>(null);
  const readingGenerationRef = useRef(0);
  const readingStateReadyRef = useRef(false);
  const readingSyncDisabledRef = useRef(false);
  const readingVersionRef = useRef(0);
  const readingPageDirtyRef = useRef(false);
  const readingZoomDirtyRef = useRef(false);
  const readingSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const readingSaveInFlightRef = useRef(false);
  const scheduleReadingSaveRef = useRef<(generation: number) => void>(
    () => undefined,
  );

  const persistReadingState = useCallback(
    async (generation: number) => {
      if (
        generation !== readingGenerationRef.current ||
        !readingStateReadyRef.current ||
        readingSyncDisabledRef.current ||
        readingSaveInFlightRef.current ||
        (!readingPageDirtyRef.current && !readingZoomDirtyRef.current)
      ) {
        return;
      }

      const savedPage = currentPageRef.current;
      const savedZoom = currentZoomRef.current;
      const expectedVersion = readingVersionRef.current;
      readingPageDirtyRef.current = false;
      readingZoomDirtyRef.current = false;
      readingSaveInFlightRef.current = true;
      try {
        const result = await saveSharedReadingState(courseId, documentId, {
          page: savedPage,
          zoom: savedZoom,
          expectedVersion,
        });
        if (generation === readingGenerationRef.current) {
          readingVersionRef.current = result.state.version;
        }
      } catch (saveError) {
        if (generation !== readingGenerationRef.current) return;
        if (saveError instanceof SharedApiError) {
          if (saveError.status === 409 && saveError.state !== undefined) {
            // Keep the user's current page/zoom. The next actual change will
            // use this newer version instead of retrying the same conflict.
            readingVersionRef.current = saveError.state?.version ?? 0;
          } else if (saveError.status === 401) {
            readingSyncDisabledRef.current = true;
            onSessionExpired?.();
          }
        }
      } finally {
        if (generation === readingGenerationRef.current) {
          readingSaveInFlightRef.current = false;
          if (currentPageRef.current !== savedPage) {
            readingPageDirtyRef.current = true;
          }
          if (currentZoomRef.current !== savedZoom) {
            readingZoomDirtyRef.current = true;
          }
          if (readingPageDirtyRef.current || readingZoomDirtyRef.current) {
            scheduleReadingSaveRef.current(generation);
          }
        }
      }
    },
    [courseId, documentId, onSessionExpired],
  );

  const scheduleReadingSave = useCallback(
    (generation = readingGenerationRef.current) => {
      if (
        generation !== readingGenerationRef.current ||
        !readingStateReadyRef.current ||
        readingSyncDisabledRef.current ||
        (!readingPageDirtyRef.current && !readingZoomDirtyRef.current)
      ) {
        return;
      }
      if (readingSaveTimerRef.current) {
        clearTimeout(readingSaveTimerRef.current);
      }
      readingSaveTimerRef.current = setTimeout(() => {
        readingSaveTimerRef.current = null;
        void persistReadingState(generation);
      }, 600);
    },
    [persistReadingState],
  );
  useEffect(() => {
    scheduleReadingSaveRef.current = scheduleReadingSave;
  }, [scheduleReadingSave]);

  useEffect(() => {
    const generation = ++readingGenerationRef.current;
    let cancelled = false;
    const explicitPage = initialPageTarget > 1;
    const clampPage = (value: number, pageCount = pageCountRef.current) => {
      const normalized = Number.isFinite(value) ? Math.floor(value) : 1;
      const atLeastOne = Math.max(normalized, 1);
      return pageCount > 0 ? Math.min(atLeastOne, pageCount) : atLeastOne;
    };
    const clampZoom = (value: number) => {
      const normalized = Number.isFinite(value) ? Math.round(value) : 95;
      return Math.min(Math.max(normalized, 50), 200);
    };
    const applyReadingState = (state: SharedReadingState | null) => {
      if (cancelled || generation !== readingGenerationRef.current) return;
      hostReadingStateRef.current = state;
      readingVersionRef.current =
        state && Number.isInteger(state.version) && state.version >= 1
          ? state.version
          : 0;
      readingStateReadyRef.current = true;
      readingSyncDisabledRef.current = false;
      if (!readingPageDirtyRef.current) {
        const restoredPage = explicitPage
          ? initialPageTarget
          : (state?.page ?? 1);
        const nextPage = clampPage(restoredPage);
        currentPageRef.current = nextPage;
        pendingPageRef.current = nextPage;
        setPage(nextPage);
        setVisiblePages(new Set([nextPage]));
      }
      if (!readingZoomDirtyRef.current) {
        const nextZoom = clampZoom(state?.zoom ?? 95);
        currentZoomRef.current = nextZoom;
        setZoom(nextZoom);
      }
      scheduleReadingSave(generation);
    };

    const applyReadingDefaultsAfterFailure = (requestError: unknown) => {
      if (cancelled || generation !== readingGenerationRef.current) return;
      hostReadingStateRef.current = null;
      readingVersionRef.current = 0;
      readingStateReadyRef.current = true;
      readingSyncDisabledRef.current =
        requestError instanceof SharedApiError && requestError.status === 401;
      if (!readingPageDirtyRef.current) {
        const nextPage = clampPage(explicitPage ? initialPageTarget : 1);
        currentPageRef.current = nextPage;
        pendingPageRef.current = nextPage;
        setPage(nextPage);
        setVisiblePages(new Set([nextPage]));
      }
      if (!readingZoomDirtyRef.current) {
        currentZoomRef.current = 95;
        setZoom(95);
      }
      if (
        requestError instanceof SharedApiError &&
        requestError.status === 401
      ) {
        onSessionExpired?.();
      }
      scheduleReadingSave(generation);
    };

    setError(null);
    setPdfDoc(null);
    setPageSizes([]);
    currentPageRef.current = initialPageTarget;
    currentZoomRef.current = 95;
    pageCountRef.current = 0;
    hostReadingStateRef.current = null;
    readingStateReadyRef.current = false;
    readingSyncDisabledRef.current = false;
    readingVersionRef.current = 0;
    // A source link is an explicit reading target. Preserve it over the host
    // page and persist it once the host version is known; the ordinary page 1
    // default remains clean and is never written during initialization.
    readingPageDirtyRef.current = explicitPage;
    readingZoomDirtyRef.current = false;
    readingSaveInFlightRef.current = false;
    if (readingSaveTimerRef.current) {
      clearTimeout(readingSaveTimerRef.current);
      readingSaveTimerRef.current = null;
    }
    setPage(initialPageTarget);
    setZoom(95);
    setVisiblePages(new Set([initialPageTarget]));
    pendingPageRef.current = initialPageTarget;
    pageRefs.current.clear();

    void loadSharedReadingState(courseId, documentId)
      .then((payload) => applyReadingState(payload.state ?? null))
      .catch((requestError: unknown) => {
        applyReadingDefaultsAfterFailure(requestError);
      });

    void (async () => {
      try {
        const buffer = await file.arrayBuffer();
        const pdfjs = await loadPdfjs();
        const loaded = await pdfjs.getDocument({
          data: new Uint8Array(buffer.slice(0)),
        }).promise;
        const sizes: PageSize[] = [];
        for (
          let pageNumber = 1;
          pageNumber <= loaded.numPages;
          pageNumber += 1
        ) {
          const pdfPage = await loaded.getPage(pageNumber);
          const viewport = pdfPage.getViewport({ scale: 1 });
          sizes.push({ width: viewport.width, height: viewport.height });
        }
        if (cancelled || generation !== readingGenerationRef.current) return;
        pageCountRef.current = loaded.numPages;
        const firstPage = clampPage(
          explicitPage
            ? initialPageTarget
            : (hostReadingStateRef.current?.page ?? 1),
          loaded.numPages,
        );
        setPageSizes(sizes);
        if (!readingPageDirtyRef.current) {
          currentPageRef.current = firstPage;
          setPage(firstPage);
          setVisiblePages(new Set([firstPage]));
          pendingPageRef.current = firstPage;
        } else {
          const currentPage = clampPage(
            currentPageRef.current,
            loaded.numPages,
          );
          currentPageRef.current = currentPage;
          setPage(currentPage);
          setVisiblePages(new Set([currentPage]));
          pendingPageRef.current = currentPage;
        }
        setPdfDoc(loaded);
      } catch {
        if (!cancelled && generation === readingGenerationRef.current)
          setError('PDF 文件暂时无法解析，可能正在更新或文件已损坏。');
      }
    })();
    return () => {
      cancelled = true;
      if (readingGenerationRef.current === generation) {
        readingGenerationRef.current += 1;
      }
      if (readingSaveTimerRef.current) {
        clearTimeout(readingSaveTimerRef.current);
        readingSaveTimerRef.current = null;
      }
      readingSaveInFlightRef.current = false;
    };
  }, [
    courseId,
    documentId,
    file,
    fileKey,
    initialPageTarget,
    onSessionExpired,
    scheduleReadingSave,
  ]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => setStageWidth(stage.clientWidth);
    const frame = requestAnimationFrame(update);
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [pdfDoc]);

  const pageWidth = stageWidth
    ? Math.max(240, Math.min(stageWidth - 32, 960)) * (zoom / 100)
    : 640;
  const pageHeights = useMemo(
    () =>
      pageSizes.map((size) =>
        pageWidth > 0 ? (size.height / size.width) * pageWidth : 800,
      ),
    [pageSizes, pageWidth],
  );

  // A source link can arrive before PDF.js has committed the page elements.
  // Wait until the complete page layout exists, then scroll the actual target
  // element; changing the numeric page state alone does not move the viewport.
  useLayoutEffect(() => {
    const target = pendingPageRef.current;
    if (!pdfDoc || pageSizes.length !== pdfDoc.numPages || target === null) {
      return;
    }
    let scrollFrame = 0;
    const layoutFrame = requestAnimationFrame(() => {
      scrollFrame = requestAnimationFrame(() => {
        if (pendingPageRef.current !== target) return;
        const element = pageRefs.current.get(target);
        const stage = stageRef.current;
        if (!element || !stage) return;
        const stageRect = stage.getBoundingClientRect();
        const pageRect = element.getBoundingClientRect();
        stage.scrollTo({
          top: Math.max(
            0,
            stage.scrollTop + pageRect.top - stageRect.top - 12,
          ),
          behavior: 'auto',
        });
        pendingPageRef.current = null;
      });
    });
    return () => {
      cancelAnimationFrame(layoutFrame);
      cancelAnimationFrame(scrollFrame);
    };
  }, [pdfDoc, pageSizes.length, pageWidth, visiblePages]);

  const pageNumbers = Array.from(
    { length: pdfDoc?.numPages ?? 0 },
    (_, index) => index + 1,
  );

  useEffect(() => {
    if (!pdfDoc || !stageRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((previous) => {
          const next = new Set(previous);
          let changed = false;
          for (const entry of entries) {
            const number = Number((entry.target as HTMLElement).dataset.page);
            if (!number) continue;
            if (entry.isIntersecting && !next.has(number)) {
              next.add(number);
              changed = true;
            }
          }
          return changed ? next : previous;
        });
      },
      { root: stageRef.current, rootMargin: '1000px 0px' },
    );
    for (const element of pageRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [pdfDoc, pageSizes.length, pageWidth]);

  const goToPage = useCallback(
    (next: number) => {
      const normalized = Number.isFinite(next) ? Math.floor(next) : 1;
      const target = Math.min(Math.max(normalized, 1), pdfDoc?.numPages ?? 1);
      if (target !== currentPageRef.current) {
        readingPageDirtyRef.current = true;
      }
      currentPageRef.current = target;
      pendingPageRef.current = target;
      setPage(target);
      setVisiblePages((previous) => new Set([...previous, target]));
      scheduleReadingSave();
    },
    [pdfDoc?.numPages, scheduleReadingSave],
  );

  const updatePageFromScroll = () => {
    const stage = stageRef.current;
    if (!stage) return;
    pendingPageRef.current = null;
    const stageTop = stage.getBoundingClientRect().top;
    let closest = currentPageRef.current;
    let distance = Number.POSITIVE_INFINITY;
    for (const [number, element] of pageRefs.current) {
      const nextDistance = Math.abs(
        element.getBoundingClientRect().top - stageTop - 12,
      );
      if (nextDistance < distance) {
        closest = number;
        distance = nextDistance;
      }
    }
    setVisiblePages((previous) =>
      previous.has(closest) ? previous : new Set([...previous, closest]),
    );
    if (closest !== currentPageRef.current) {
      currentPageRef.current = closest;
      readingPageDirtyRef.current = true;
      setPage(closest);
      scheduleReadingSave();
    }
  };

  const changeZoom = useCallback(
    (delta: number) => {
      const target = Math.min(
        Math.max(currentZoomRef.current + delta, 50),
        200,
      );
      if (target === currentZoomRef.current) return;
      currentZoomRef.current = target;
      readingZoomDirtyRef.current = true;
      setZoom(target);
      scheduleReadingSave();
    },
    [scheduleReadingSave],
  );

  const hasArtifactPanel = Boolean(digest && (hasSummary || hasMindmap));
  const hasTranslationPanel = Boolean(courseId && documentId);
  const panelContent = hasArtifactPanel || hasTranslationPanel;

  return (
    <main className="flex h-screen min-h-[620px] flex-col overflow-hidden bg-background text-foreground">
      <header className="app-toolbar">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="返回课程"
            onClick={onBack}
          >
            <ChevronLeft />
          </Button>
          <div className="brand-mark" aria-hidden="true">
            <BookOpen className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.18em] text-amber-700 uppercase">
              局域网共享 · 课程资料只读 · 进度同步
            </p>
            <p className="truncate text-sm font-medium text-slate-700">
              {file.name}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="上一页"
            onClick={() => goToPage(page - 1)}
            disabled={!pdfDoc || page <= 1}
          >
            <ChevronLeft />
          </Button>
          <label className="flex h-7 items-center gap-1.5 px-1 text-xs tabular-nums text-slate-600">
            <span className="sr-only">跳转页码</span>
            <input
              className="h-6 w-10 rounded border border-transparent bg-transparent text-center font-semibold text-slate-900 outline-none focus:border-amber-400 focus:bg-amber-50"
              inputMode="numeric"
              value={page}
              onChange={(event) => goToPage(Number(event.target.value) || 1)}
            />
            <span>/ {pdfDoc?.numPages ?? '—'}</span>
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="下一页"
            onClick={() => goToPage(page + 1)}
            disabled={!pdfDoc || page >= (pdfDoc?.numPages ?? 1)}
          >
            <ChevronRight />
          </Button>
        </div>
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="缩小"
            onClick={() => changeZoom(-10)}
            disabled={zoom <= 50}
          >
            <Minus />
          </Button>
          <span className="hidden min-w-10 text-center text-xs text-slate-500 sm:inline">
            {zoom}%
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="放大"
            onClick={() => changeZoom(10)}
            disabled={zoom >= 200}
          >
            <Plus />
          </Button>
        </div>
      </header>

      <section className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <section
            className="reader-pane min-w-0 flex-1"
            aria-label="PDF 原文阅读区"
          >
            <div className="pane-heading">
              <div>
                <p className="pane-eyebrow">原文</p>
                <p className="pane-meta">
                  {pdfDoc
                    ? `${pdfDoc.numPages} 页 · 已从主电脑读取`
                    : '正在读取 PDF…'}
                </p>
              </div>
            </div>
            <div className="reader-workspace">
              {pdfDoc ? (
                <nav className="thumbnail-sidebar" aria-label="PDF 页面预览">
                  <div className="thumbnail-sidebar-heading">
                    <span>页面</span>
                    <span>{pdfDoc.numPages}</span>
                  </div>
                  <div className="thumbnail-scroll">
                    {pageNumbers.map((number) => (
                      <button
                        key={number}
                        type="button"
                        className={`page-thumbnail ${number === page ? 'page-thumbnail-active' : ''}`}
                        aria-label={`查看第 ${number} 页${number === page ? '，当前页' : ''}`}
                        aria-current={number === page ? 'page' : undefined}
                        onClick={() => goToPage(number)}
                      >
                        <span className="thumbnail-paper">
                          <span className="thumbnail-kicker" />
                          <span className="thumbnail-title" />
                          <span className="thumbnail-line w-full" />
                        </span>
                        <span className="thumbnail-page-number">{number}</span>
                      </button>
                    ))}
                  </div>
                </nav>
              ) : null}
              <div
                ref={stageRef}
                className="document-stage"
                aria-label="PDF 连续阅读画布"
                onScroll={updatePageFromScroll}
              >
                {error ? (
                  <div className="flex h-full min-h-80 items-center justify-center px-8 text-center text-sm text-rose-700">
                    {error}
                  </div>
                ) : pdfDoc ? (
                  <div className="document-pages">
                    {pageNumbers.map((number) => {
                      const width = pageWidth;
                      const height = pageHeights[number - 1] || width / 0.707;
                      return (
                        <article
                          key={number}
                          ref={(node) => {
                            if (node) pageRefs.current.set(number, node);
                            else pageRefs.current.delete(number);
                          }}
                          data-page={number}
                          className={`pdf-page ${number === page ? 'pdf-page-current' : ''}`}
                          style={{ width: `${width}px` }}
                          aria-label={`PDF 第 ${number} 页${number === page ? '，当前页' : ''}`}
                        >
                          <div
                            className="relative overflow-hidden bg-white shadow-[0_3px_14px_rgba(15,23,42,0.16)] ring-1 ring-slate-900/5"
                            style={{ height: `${height}px` }}
                          >
                            {visiblePages.has(number) ? (
                              <SharedPdfPage
                                pdfDoc={pdfDoc}
                                pageNumber={number}
                                width={width}
                                height={height}
                              />
                            ) : (
                              <div className="flex h-full items-center justify-center bg-white text-xs text-slate-300">
                                {number}
                              </div>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-slate-500">
                    <LoaderCircle className="mr-2 size-4 animate-spin" />
                    正在准备 PDF…
                  </div>
                )}
              </div>
            </div>
          </section>

          <aside
            className="hidden w-[min(43vw,520px)] min-w-[320px] flex-col border-l border-slate-200 bg-[#fffdf9] lg:flex"
            aria-label="已有课程成果"
          >
            <div className="border-b border-slate-200/80 px-5 py-4">
              <p className="text-xs font-semibold text-slate-800">已有成果</p>
              <p className="mt-1 text-[11px] text-slate-500">
                课程资料本身只读；阅读进度会同步，AI 请求由主电脑执行。
              </p>
            </div>
            {panelContent ? (
              <Tabs
                value={panel}
                onValueChange={(value) =>
                  setPanel(
                    value as 'summary' | 'mindmap' | 'translation' | 'chat',
                  )
                }
                className="min-h-0 flex-1 gap-0"
              >
                <TabsList className="mx-4 mt-3">
                  {hasSummary ? (
                    <TabsTrigger value="summary">
                      <FileText /> PDF 总结
                    </TabsTrigger>
                  ) : null}
                  {hasMindmap ? (
                    <TabsTrigger value="mindmap">
                      <Network /> PDF 脑图
                    </TabsTrigger>
                  ) : null}
                  {hasTranslationPanel ? (
                    <TabsTrigger value="translation">
                      <Languages /> 页面翻译
                    </TabsTrigger>
                  ) : null}
                  {hasTranslationPanel ? (
                    <TabsTrigger value="chat">
                      <MessageCircle /> AI 答疑
                    </TabsTrigger>
                  ) : null}
                </TabsList>
                {hasSummary ? (
                  <TabsContent
                    value="summary"
                    className="min-h-0 overflow-y-auto data-[hidden]:hidden"
                  >
                    <DocumentSummaryPanel
                      digest={digest!}
                      onOpenSource={goToPage}
                    />
                  </TabsContent>
                ) : null}
                {hasMindmap ? (
                  <TabsContent
                    value="mindmap"
                    className="min-h-0 overflow-y-auto data-[hidden]:hidden"
                  >
                    <KnowledgeMindmap
                      knowledge={documentKnowledge(digest!)}
                      onOpenSource={(_, sourcePage) => goToPage(sourcePage)}
                    />
                  </TabsContent>
                ) : null}
                {hasTranslationPanel ? (
                  <TabsContent
                    value="translation"
                    className="min-h-0 overflow-y-auto data-[hidden]:hidden"
                  >
                    <SharedTranslationPanel
                      courseId={courseId}
                      documentId={documentId}
                      page={page}
                      canUseAi={aiEnabled}
                      onSessionExpired={onSessionExpired}
                    />
                  </TabsContent>
                ) : null}
                {hasTranslationPanel ? (
                  <TabsContent
                    value="chat"
                    className="min-h-0 overflow-y-auto data-[hidden]:hidden"
                  >
                    <SharedChatPanel
                      courseId={courseId}
                      documentId={documentId}
                      page={page}
                      canUseAi={aiEnabled}
                      onSessionExpired={onSessionExpired}
                    />
                  </TabsContent>
                ) : null}
              </Tabs>
            ) : (
              <div className="flex min-h-80 flex-col items-center justify-center px-8 text-center">
                <FileText className="size-8 text-slate-300" />
                <h2 className="mt-4 text-sm font-semibold text-slate-700">
                  暂无该 PDF 的可查看成果
                </h2>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  主电脑尚未生成这份 PDF 的总结或脑图；如已开放
                  AI，可在翻译或答疑面板中请求处理。
                </p>
              </div>
            )}
          </aside>
        </div>
        <aside
          className="flex max-h-[38vh] shrink-0 flex-col border-t border-slate-200 bg-[#fffdf9] lg:hidden"
          aria-label="已有课程成果（窄窗口）"
        >
          <div className="border-b border-slate-200/80 px-5 py-3">
            <p className="text-xs font-semibold text-slate-800">已有成果</p>
            <p className="mt-1 text-[11px] text-slate-500">
              窄窗口可在下方切换查看 PDF 总结、脑图、页面翻译或 AI 答疑。
            </p>
          </div>
          {panelContent ? (
            <Tabs
              value={panel}
              onValueChange={(value) =>
                setPanel(
                  value as 'summary' | 'mindmap' | 'translation' | 'chat',
                )
              }
              className="min-h-0 flex-1 gap-0"
            >
              <TabsList className="mx-4 mt-3">
                {hasSummary ? (
                  <TabsTrigger value="summary">
                    <FileText /> PDF 总结
                  </TabsTrigger>
                ) : null}
                {hasMindmap ? (
                  <TabsTrigger value="mindmap">
                    <Network /> PDF 脑图
                  </TabsTrigger>
                ) : null}
                {hasTranslationPanel ? (
                  <TabsTrigger value="translation">
                    <Languages /> 页面翻译
                  </TabsTrigger>
                ) : null}
                {hasTranslationPanel ? (
                  <TabsTrigger value="chat">
                    <MessageCircle /> AI 答疑
                  </TabsTrigger>
                ) : null}
              </TabsList>
              {hasSummary ? (
                <TabsContent
                  value="summary"
                  className="max-h-[32vh] overflow-y-auto data-[hidden]:hidden"
                >
                  <DocumentSummaryPanel
                    digest={digest!}
                    onOpenSource={goToPage}
                  />
                </TabsContent>
              ) : null}
              {hasMindmap ? (
                <TabsContent
                  value="mindmap"
                  className="max-h-[32vh] overflow-y-auto data-[hidden]:hidden"
                >
                  <KnowledgeMindmap
                    knowledge={documentKnowledge(digest!)}
                    onOpenSource={(_, sourcePage) => goToPage(sourcePage)}
                  />
                </TabsContent>
              ) : null}
              {hasTranslationPanel ? (
                <TabsContent
                  value="translation"
                  className="max-h-[32vh] overflow-y-auto data-[hidden]:hidden"
                >
                  <SharedTranslationPanel
                    courseId={courseId}
                    documentId={documentId}
                    page={page}
                    canUseAi={aiEnabled}
                    onSessionExpired={onSessionExpired}
                  />
                </TabsContent>
              ) : null}
              {hasTranslationPanel ? (
                <TabsContent
                  value="chat"
                  className="max-h-[32vh] overflow-y-auto data-[hidden]:hidden"
                >
                  <SharedChatPanel
                    courseId={courseId}
                    documentId={documentId}
                    page={page}
                    canUseAi={aiEnabled}
                    onSessionExpired={onSessionExpired}
                  />
                </TabsContent>
              ) : null}
            </Tabs>
          ) : (
            <div className="flex min-h-40 flex-col items-center justify-center px-8 text-center">
              <FileText className="size-8 text-slate-300" />
              <h2 className="mt-3 text-sm font-semibold text-slate-700">
                暂无该 PDF 的可查看成果
              </h2>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                主电脑尚未生成这份 PDF 的总结或脑图；如已开放
                AI，可在翻译或答疑面板中请求处理。
              </p>
            </div>
          )}
        </aside>
      </section>
      <footer className="status-bar">
        <span>局域网共享 · 课程资料只读 · 阅读进度同步 · {file.name}</span>
        <span className="hidden sm:inline">
          资料由主电脑实时读取，刷新后可获取更新
        </span>
        <span className="tabular-nums">
          第 {page} / {pdfDoc?.numPages ?? '—'} 页
        </span>
      </footer>
    </main>
  );
}
