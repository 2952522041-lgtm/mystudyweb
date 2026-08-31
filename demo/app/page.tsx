'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Copy,
  FileText,
  FileUp,
  Languages,
  LoaderCircle,
  LibraryBig,
  MessageCircle,
  Minus,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
  Settings,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { AIChatPanel } from '@/components/ai-chat-panel';
import {
  CourseLibrary,
  type CourseReaderContext,
} from '@/components/course-library';
import { DocumentSummaryPanel } from '@/components/document-summary-panel';
import { KnowledgeMindmap } from '@/components/knowledge-mindmap';
import {
  ReaderSettingsDialog,
  type SettingsTab,
} from '@/components/reader-settings-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { pickCurrentPage, measurePageRects } from '@/lib/current-page';
import {
  chatSettingsConfigured,
  DEFAULT_CHAT_SETTINGS,
  loadChatSettings,
  saveChatSettings,
  type ChatSettings,
} from '@/lib/chat-cache';
import { ChatError } from '@/lib/chat';
import { loadPdfjs, type PDFDocumentProxy, type RenderTask } from '@/lib/pdfjs';
import { itemsFromPdfJs, normalizePage, pageHasText } from '@/lib/pdf-text';
import {
  createOcrProviderForSettings,
  createOcrService,
  pageNeedsOcr,
  resolvePageOcr,
} from '@/lib/ocr';
import { renderPageImage } from '@/lib/page-vision';
import {
  computeFileFingerprint,
  createReaderService,
  createProviderForSettings,
  DEFAULT_SETTINGS,
  loadReaderSettings,
  readerServiceHost,
  resolvePageTranslation,
  saveReaderSettings,
  usingRemoteProvider,
  type ReaderSettings,
} from '@/lib/reader-cache';
import {
  clampPage,
  fillColumnPageWidth,
  nextPageToPrefetch,
  stepZoom,
} from '@/lib/reader-model';
import {
  describeTranslationError,
  TranslationError,
  type TranslationErrorCode,
} from '@/lib/translation';
import {
  emptyCourseKnowledge,
  mergeDocumentDigest,
} from '@/lib/knowledge/course-merger';

const TARGET_LANGUAGES = ['简体中文', '繁體中文', '日本語', '한국어'] as const;
const TRANSLATION_STABLE_DELAY = 300;
const PROGRESS_SAVE_DELAY = 800;

interface PageView {
  width: number;
  height: number;
}

interface DocumentMeta {
  fingerprint: string;
  fileName: string;
  pageCount: number;
  scanDetected: boolean;
  restoredPage: number | null;
}

interface PageTranslationState {
  status: 'recognizing' | 'translating' | 'complete' | 'cached' | 'error';
  paragraphs?: string[];
  errorCode?: TranslationErrorCode;
  errorMessage?: string;
}

function describeFailure(error: unknown): {
  code: TranslationErrorCode;
  message: string;
} {
  if (error instanceof TranslationError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ChatError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'unknown', message: describeTranslationError('unknown') };
}

function IconButton({
  label,
  children,
  onClick,
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PdfPageCanvas({
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
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;

    void (async () => {
      const pdfPage = await pdfDoc.getPage(pageNumber);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({
        scale: (width * dpr) / base.width,
      });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      task = pdfPage.render({ canvas, canvasContext: context, viewport });
      await task.promise;
      if (!cancelled) setRendering(false);
    })().catch(() => {
      if (!cancelled) setRendering(false);
    });

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdfDoc, pageNumber, width, height]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="block bg-white"
        aria-label={`第 ${pageNumber} 页内容`}
      />
      {rendering ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white">
          <LoaderCircle className="size-6 animate-spin text-slate-400" />
        </div>
      ) : null}
    </>
  );
}

function PdfPageThumbnail({
  pdfDoc,
  page,
  active,
  onSelect,
  activeRef,
}: {
  pdfDoc: PDFDocumentProxy;
  page: number;
  active: boolean;
  onSelect: () => void;
  activeRef?: React.Ref<HTMLButtonElement>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const holderRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    void (async () => {
      const pdfPage = await pdfDoc.getPage(page);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const targetWidth = 72 * Math.min(window.devicePixelRatio || 1, 2);
      const viewport = pdfPage.getViewport({ scale: targetWidth / base.width });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) return;
      task = pdfPage.render({ canvas, canvasContext: context, viewport });
      await task.promise;
    })().catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdfDoc, page, visible]);

  return (
    <button
      ref={activeRef}
      type="button"
      className={`page-thumbnail ${active ? 'page-thumbnail-active' : ''}`}
      aria-label={`查看第 ${page} 页${active ? '，当前页' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
    >
      <span className="thumbnail-paper" aria-hidden="true" ref={holderRef}>
        {visible ? (
          <canvas ref={canvasRef} className="h-full w-full object-cover" />
        ) : (
          <span className="thumbnail-line w-full" />
        )}
      </span>
      <span className="thumbnail-page-number">{page}</span>
    </button>
  );
}

function WelcomeStage({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-white text-slate-500 shadow-sm ring-1 ring-slate-200">
        <FileUp className="size-6" />
      </span>
      <div>
        <h2 className="text-base font-semibold text-slate-800">
          导入一份外文 PDF 开始阅读
        </h2>
        <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">
          左侧阅读原文，右侧自动显示当前页的译文。文字型 PDF
          本地提取，扫描或手写页面可使用视觉 OCR。
        </p>
      </div>
      <Button onClick={onImport}>
        <FileUp />
        选择 PDF 文件
      </Button>
    </div>
  );
}

function TranslationBody({
  page,
  targetLanguage,
  state,
  remoteProvider,
  onRetry,
}: {
  page: number;
  targetLanguage: string;
  state: PageTranslationState | undefined;
  remoteProvider: boolean;
  onRetry: () => void;
}) {
  if (
    !state ||
    state.status === 'translating' ||
    state.status === 'recognizing'
  ) {
    if (state?.paragraphs && state.paragraphs.length > 0) {
      // Streaming: show paragraphs as they arrive instead of a blank wait.
      return (
        <article className="translation-copy">
          {state.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 48) + String(paragraph.length)}>
              {paragraph}
            </p>
          ))}
          <p
            className="flex items-center gap-2 text-xs text-amber-700"
            aria-label="翻译中"
          >
            <LoaderCircle className="size-3.5 animate-spin" />
            正在翻译…
          </p>
        </article>
      );
    }
    return (
      <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
        <span className="mb-5 flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <LoaderCircle className="size-5 animate-spin" />
        </span>
        <h2 className="text-sm font-semibold text-slate-800">
          {state?.status === 'recognizing'
            ? `正在识别第 ${page} 页`
            : `正在翻译第 ${page} 页`}
        </h2>
        <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
          {state?.status === 'recognizing'
            ? '正在用视觉模型转录扫描或手写内容，识别结果会缓存在本机…'
            : `已提取当前页文字，正在生成${targetLanguage}译文…`}
        </p>
        <div className="mt-7 w-full max-w-sm space-y-3" aria-hidden="true">
          <span className="block h-3 w-4/5 animate-pulse rounded bg-slate-200" />
          <span className="block h-3 w-full animate-pulse rounded bg-slate-100" />
          <span className="block h-3 w-11/12 animate-pulse rounded bg-slate-100" />
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
        <span className="mb-5 flex size-11 items-center justify-center rounded-full bg-rose-100 text-rose-700">
          <CircleAlert className="size-5" />
        </span>
        <h2 className="text-sm font-semibold text-slate-800">
          第 {page} 页翻译失败
        </h2>
        <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
          {state.errorMessage ?? '翻译服务出现错误。'}
        </p>
        <Button className="mt-6" size="sm" onClick={onRetry}>
          <RotateCcw />
          重新翻译
        </Button>
      </div>
    );
  }

  return (
    <article className="translation-copy">
      {state.paragraphs?.map((paragraph) => (
        <p key={paragraph.slice(0, 48) + String(paragraph.length)}>
          {paragraph}
        </p>
      ))}
      {remoteProvider ? null : (
        <p className="mt-10 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-xs text-slate-500">
          当前显示的是内置演示译文。在右上角“翻译设置”中配置 OpenAI
          兼容服务后，这里将显示真实译文。
        </p>
      )}
    </article>
  );
}

function PdfReader({
  initialFile,
  courseContext,
  onOpenCourses,
}: {
  initialFile?: File | null;
  courseContext?: CourseReaderContext | null;
  onOpenCourses: () => void;
}) {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [docMeta, setDocMeta] = useState<DocumentMeta | null>(null);
  const [pageSizes, setPageSizes] = useState<PageView[]>([]);
  const [page, setPage] = useState(1);
  const [translationPage, setTranslationPage] = useState(1);
  const [zoom, setZoom] = useState(95);
  const [targetLanguage, setTargetLanguage] = useState<string>('简体中文');
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [chatSettings, setChatSettings] = useState<ChatSettings>(
    DEFAULT_CHAT_SETTINGS,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('translation');
  const [rightMode, setRightMode] = useState<
    'translation' | 'chat' | 'summary' | 'mindmap'
  >(courseContext?.digest ? 'summary' : 'translation');
  const [translationStates, setTranslationStates] = useState<
    Record<string, PageTranslationState>
  >({});
  const [renderedPages, setRenderedPages] = useState<Set<number>>(
    () => new Set(),
  );
  const [copied, setCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [translationVisible, setTranslationVisible] = useState(true);
  const [stageWidth, setStageWidth] = useState(0);
  const [prefetchedTranslationPage, setPrefetchedTranslationPage] = useState<
    number | null
  >(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const documentStageRef = useRef<HTMLDivElement>(null);
  const pageElementsRef = useRef(new Map<number, HTMLElement>());
  const activeThumbnailRef = useRef<HTMLButtonElement>(null);
  const scrollTargetRef = useRef<number | null>(null);
  const positionedRef = useRef(false);
  const serviceRef = useRef<ReturnType<typeof createReaderService> | null>(
    null,
  );
  const ocrCacheRef = useRef<ReturnType<typeof createOcrService> | null>(null);
  const settingsRef = useRef(settings);
  const chatSettingsRef = useRef(chatSettings);
  const bypassCacheRef = useRef(new Set<string>());
  const prefetchedTranslationsRef = useRef(new Set<string>());
  const retryTokenRef = useRef(0);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    chatSettingsRef.current = chatSettings;
  }, [chatSettings]);

  const translationKey = useCallback(
    (pageNumber: number, language: string) => `${pageNumber}:${language}`,
    [],
  );

  const translationStatesRef = useRef<Record<string, PageTranslationState>>({});
  const updateTranslationState = useCallback(
    (key: string, state: PageTranslationState) => {
      translationStatesRef.current = {
        ...translationStatesRef.current,
        [key]: state,
      };
      setTranslationStates(translationStatesRef.current);
    },
    [],
  );

  useEffect(() => {
    serviceRef.current = createReaderService();
    ocrCacheRef.current = createOcrService();
    const timer = setTimeout(() => {
      const loaded = loadReaderSettings();
      setSettings(loaded);
      setChatSettings(loadChatSettings());
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const stage = documentStageRef.current;
    if (!stage) return;
    const updateStageSize = () => setStageWidth(stage.clientWidth);
    const frame = requestAnimationFrame(updateStageSize);
    const observer = new ResizeObserver(updateStageSize);
    observer.observe(stage);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const currentPageWidth = fillColumnPageWidth(stageWidth, zoom);
  const pageHeightsPx = useMemo(
    () =>
      pageSizes.map((size) =>
        currentPageWidth > 0
          ? (size.height / size.width) * currentPageWidth
          : 0,
      ),
    [pageSizes, currentPageWidth],
  );
  const pageTops = useMemo(() => {
    const tops: number[] = [];
    let offset = 12;
    for (const height of pageHeightsPx) {
      tops.push(offset);
      offset += height + 8;
    }
    return tops;
  }, [pageHeightsPx]);

  // Render pages near the viewport, release far ones.
  useEffect(() => {
    const stage = documentStageRef.current;
    if (!stage || !pdfDoc) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setRenderedPages((previous) => {
          const next = new Set(previous);
          let changed = false;
          for (const entry of entries) {
            const pageNumber = Number(
              (entry.target as HTMLElement).dataset.page,
            );
            if (!pageNumber) continue;
            if (entry.isIntersecting && !next.has(pageNumber)) {
              next.add(pageNumber);
              changed = true;
            } else if (!entry.isIntersecting && next.has(pageNumber)) {
              next.delete(pageNumber);
              changed = true;
            }
          }
          return changed ? next : previous;
        });
      },
      { root: stage, rootMargin: '1200px 0px' },
    );
    for (const element of pageElementsRef.current.values())
      observer.observe(element);
    return () => observer.disconnect();
  }, [pdfDoc, docMeta, pageSizes.length]);

  const goToPage = useCallback(
    (nextPage: number) => {
      const targetPage = clampPage(nextPage, docMeta?.pageCount ?? 1);
      setCopied(false);
      setPage(targetPage);
      scrollTargetRef.current = targetPage;
      requestAnimationFrame(() => {
        pageElementsRef.current
          .get(targetPage)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    [docMeta?.pageCount],
  );

  useEffect(() => {
    if (!stageWidth || positionedRef.current) return;
    positionedRef.current = true;
    pageElementsRef.current.get(page)?.scrollIntoView({ block: 'start' });
  }, [page, stageWidth]);

  useEffect(() => {
    activeThumbnailRef.current?.scrollIntoView({ block: 'nearest' });
  }, [page]);

  // Display page and translated page are decoupled: translation waits for a
  // stable page so fast scrolling does not fire requests.
  useEffect(() => {
    if (!pdfDoc) return;
    const timer = setTimeout(
      () => setTranslationPage(page),
      TRANSLATION_STABLE_DELAY,
    );
    return () => clearTimeout(timer);
  }, [page, pdfDoc, docMeta?.scanDetected]);

  // Current page from scroll geometry, per the largest-visible-area rule.
  const updatePageFromScroll = useCallback(() => {
    const stage = documentStageRef.current;
    if (
      !stage ||
      pageHeightsPx.length === 0 ||
      pageHeightsPx.some((height) => height === 0)
    )
      return;
    const rects = measurePageRects(
      {
        scrollTop: stage.scrollTop - 12,
        clientHeight: stage.clientHeight,
        pageTops,
      },
      pageHeightsPx,
    );
    const current = pickCurrentPage(rects, stage.clientHeight);
    if (current && current !== page) {
      setCopied(false);
      setPage(current);
    }
  }, [page, pageHeightsPx, pageTops]);

  const handleFile = useCallback(async (file: File, requestedPage?: number) => {
    setImporting(true);
    setImportError(null);
    try {
      const buffer = await file.arrayBuffer();
      const fingerprint = await computeFileFingerprint(buffer);
      const pdfjs = await loadPdfjs();
      // getDocument may transfer the buffer to the worker, so hand it a copy.
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer.slice(0)),
      }).promise;

      const sizes: PageView[] = [];
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        const pdfPage = await doc.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale: 1 });
        sizes.push({ width: viewport.width, height: viewport.height });
      }

      // Scanned-PDF rule: sample the first pages; no text layer means the
      // MVP cannot translate this document.
      let scanDetected = true;
      for (
        let pageNumber = 1;
        pageNumber <= Math.min(3, doc.numPages);
        pageNumber += 1
      ) {
        const pdfPage = await doc.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale: 1 });
        const content = await pdfPage.getTextContent();
        if (
          pageHasText(
            itemsFromPdfJs(
              content.items as Array<{
                str?: string;
                transform?: number[];
                width?: number;
                height?: number;
              }>,
              viewport.height,
            ),
          )
        ) {
          scanDetected = false;
          break;
        }
      }

      const restored = await serviceRef.current?.progress.load(fingerprint);
      positionedRef.current = false;
      setRenderedPages(new Set());
      setTranslationStates({});
      translationStatesRef.current = {};
      prefetchedTranslationsRef.current.clear();
      setPrefetchedTranslationPage(null);
      pageElementsRef.current.clear();
      setPdfDoc(doc);
      setPageSizes(sizes);
      setDocMeta({
        fingerprint,
        fileName: file.name,
        pageCount: doc.numPages,
        scanDetected,
        restoredPage:
          restored && restored.lastPage > 1 ? restored.lastPage : null,
      });
      setZoom(restored?.zoom ?? 95);
      setTargetLanguage(restored?.targetLanguage ?? '简体中文');
      const openingPage = clampPage(
        requestedPage ?? restored?.lastPage ?? 1,
        doc.numPages,
      );
      setPage(openingPage);
      setTranslationPage(openingPage);
      setImportOpen(false);
    } catch {
      setImportError('无法解析该 PDF 文件，文件可能已损坏或已加密。');
    } finally {
      setImporting(false);
    }
  }, []);

  useEffect(() => {
    if (initialFile) {
      const timer = setTimeout(() => {
        void handleFile(initialFile, courseContext?.initialPage);
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [courseContext?.initialPage, handleFile, initialFile]);

  // Persist reading progress for this fingerprint.
  useEffect(() => {
    if (!pdfDoc || !docMeta) return;
    const timer = setTimeout(() => {
      void serviceRef.current?.progress.save({
        fingerprint: docMeta.fingerprint,
        fileName: docMeta.fileName,
        pageCount: docMeta.pageCount,
        lastPage: page,
        zoom,
        targetLanguage,
        updatedAt: new Date().toISOString(),
      });
    }, PROGRESS_SAVE_DELAY);
    return () => clearTimeout(timer);
  }, [pdfDoc, docMeta, page, zoom, targetLanguage]);

  // Per-page pipeline: extract a text layer, fall back to cached visual OCR,
  // then use the existing translation cache/provider.
  useEffect(() => {
    if (!pdfDoc || !docMeta) return;
    const key = translationKey(translationPage, targetLanguage);
    const bypassRequested = bypassCacheRef.current.delete(key);
    const existing = translationStatesRef.current[key];
    if (
      !bypassRequested &&
      existing &&
      (existing.status === 'complete' || existing.status === 'cached')
    ) {
      return;
    }

    const controller = new AbortController();
    bypassCacheRef.current.delete(key);
    let cancelled = false;
    updateTranslationState(key, {
      status: docMeta.scanDetected ? 'recognizing' : 'translating',
    });

    const runTranslation = async () => {
      try {
        const pdfPage = await pdfDoc.getPage(translationPage);
        const viewport = pdfPage.getViewport({ scale: 1 });
        const content = await pdfPage.getTextContent();
        if (cancelled) return;
        const normalized = normalizePage(
          itemsFromPdfJs(
            content.items as Array<{
              str?: string;
              transform?: number[];
              width?: number;
              height?: number;
            }>,
            viewport.height,
          ),
        );
        let sourceText = normalized.text;
        if (pageNeedsOcr(sourceText)) {
          const currentChatSettings = chatSettingsRef.current;
          if (!chatSettingsConfigured(currentChatSettings)) {
            updateTranslationState(key, {
              status: 'error',
              errorCode: 'auth',
              errorMessage:
                '当前页需要扫描件 OCR。请在“AI 答疑”设置中配置 API Key 和支持图片输入的视觉模型。',
            });
            return;
          }
          updateTranslationState(key, { status: 'recognizing' });
          const pageImage = await renderPageImage(pdfDoc, translationPage, {
            signal: controller.signal,
            maxDimension: 2200,
            maxPixels: 4_000_000,
          });
          const ocrOutcome = await resolvePageOcr({
            provider: createOcrProviderForSettings(currentChatSettings),
            cache: ocrCacheRef.current!,
            request: {
              fingerprint: docMeta.fingerprint,
              pageNumber: translationPage,
              pageImage,
            },
            signal: controller.signal,
            bypassCache: bypassRequested,
          });
          sourceText = ocrOutcome.result.text;
          if (cancelled) return;
          updateTranslationState(key, { status: 'translating' });
        }
        const provider = createProviderForSettings(settingsRef.current);
        const outcome = await resolvePageTranslation({
          provider,
          cache: serviceRef.current!.cache,
          fingerprint: docMeta.fingerprint,
          request: {
            text: sourceText,
            sourceLanguage: 'auto',
            targetLanguage,
            pageNumber: translationPage,
          },
          signal: controller.signal,
          bypassCache: bypassRequested,
          onPartial: (paragraphs) => {
            if (!cancelled && paragraphs.length > 0) {
              updateTranslationState(key, {
                status: 'translating',
                paragraphs,
              });
            }
          },
        });
        if (cancelled) return;
        updateTranslationState(key, {
          status: outcome.status,
          paragraphs: outcome.result.paragraphs,
        });
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        const failure = describeFailure(error);
        updateTranslationState(key, {
          status: 'error',
          errorCode: failure.code,
          errorMessage: failure.message,
        });
      }
    };
    void runTranslation();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    pdfDoc,
    docMeta,
    translationPage,
    targetLanguage,
    retryToken,
    translationKey,
    updateTranslationState,
  ]);

  const retranslate = () => {
    const key = translationKey(translationPage, targetLanguage);
    bypassCacheRef.current.add(key);
    retryTokenRef.current += 1;
    setRetryToken(retryTokenRef.current);
    setCopied(false);
  };

  const copyTranslation = async () => {
    const state =
      translationStates[translationKey(translationPage, targetLanguage)];
    const text = (state?.paragraphs ?? []).join('\n\n');
    if (text.length === 0) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard may be unavailable; the visual feedback still completes.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const applySettings = (
    nextSettings: ReaderSettings,
    nextChatSettings: ChatSettings,
  ) => {
    const translationChanged =
      JSON.stringify(settings) !== JSON.stringify(nextSettings);
    const ocrChanged =
      JSON.stringify(chatSettings) !== JSON.stringify(nextChatSettings);
    setSettings(nextSettings);
    setChatSettings(nextChatSettings);
    saveReaderSettings(nextSettings);
    saveChatSettings(nextChatSettings);
    setSettingsOpen(false);
    if (translationChanged || ocrChanged) {
      // Translation or OCR provider/model changes alter cache identity: drop
      // session states so the visible page uses the new configuration.
      translationStatesRef.current = {};
      setTranslationStates({});
      prefetchedTranslationsRef.current.clear();
      setPrefetchedTranslationPage(null);
      retryTokenRef.current += 1;
      setRetryToken(retryTokenRef.current);
    }
  };

  const pageNumbers = Array.from(
    { length: docMeta?.pageCount ?? 0 },
    (_, index) => index + 1,
  );
  const translationKeyCurrent = translationKey(translationPage, targetLanguage);
  const currentState = translationStates[translationKeyCurrent];
  const isReady =
    currentState?.status === 'complete' || currentState?.status === 'cached';
  const remoteProvider = usingRemoteProvider(settings);
  const remoteProviderHost = remoteProvider
    ? readerServiceHost(settings.baseUrl)
    : null;
  const statusLabel = !docMeta
    ? '尚未导入 PDF'
    : currentState?.status === 'recognizing'
      ? `正在 OCR 识别第 ${translationPage} 页`
      : currentState?.status === 'translating'
        ? `正在翻译第 ${translationPage} 页`
        : currentState?.status === 'error'
          ? '翻译失败，可重试'
          : isReady
            ? currentState?.status === 'cached'
              ? '译文来自缓存'
              : '译文已完成'
            : '译文待加载';

  // Once the current translation is ready, quietly prepare the next page so
  // sequential reading usually becomes an immediate cache hit.
  useEffect(() => {
    if (!pdfDoc || !docMeta || docMeta.scanDetected || !isReady) return;
    const nextPage = nextPageToPrefetch(translationPage, docMeta.pageCount);
    if (!nextPage) return;
    const provider = createProviderForSettings(settingsRef.current);
    const prefetchedTranslations = prefetchedTranslationsRef.current;
    const identity = [
      docMeta.fingerprint,
      nextPage,
      targetLanguage,
      provider.id,
      provider.model,
    ].join(':');
    if (prefetchedTranslations.has(identity)) return;

    const controller = new AbortController();
    let completed = false;
    const timer = setTimeout(() => {
      prefetchedTranslations.add(identity);
      void (async () => {
        try {
          const pdfPage = await pdfDoc.getPage(nextPage);
          const viewport = pdfPage.getViewport({ scale: 1 });
          const content = await pdfPage.getTextContent();
          const normalized = normalizePage(
            itemsFromPdfJs(
              content.items as Array<{
                str?: string;
                transform?: number[];
                width?: number;
                height?: number;
              }>,
              viewport.height,
            ),
          );
          if (normalized.text.trim().length === 0 || controller.signal.aborted)
            return;
          await resolvePageTranslation({
            provider,
            cache: serviceRef.current!.cache,
            fingerprint: docMeta.fingerprint,
            request: {
              text: normalized.text,
              sourceLanguage: 'auto',
              targetLanguage,
              pageNumber: nextPage,
            },
            signal: controller.signal,
          });
          if (!controller.signal.aborted) {
            completed = true;
            setPrefetchedTranslationPage(nextPage);
          }
        } catch {
          if (!controller.signal.aborted)
            prefetchedTranslations.delete(identity);
        }
      })();
    }, 150);

    return () => {
      clearTimeout(timer);
      controller.abort();
      if (!completed) prefetchedTranslations.delete(identity);
    };
  }, [pdfDoc, docMeta, isReady, translationPage, targetLanguage, retryToken]);

  const openSettings = (tab: SettingsTab = 'translation') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  return (
    <TooltipProvider>
      <main className="flex h-screen min-h-[680px] flex-col overflow-hidden bg-background text-foreground">
        <header className="app-toolbar">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="返回课程知识库"
              onClick={onOpenCourses}
            >
              <ChevronLeft />
            </Button>
            <div className="brand-mark" aria-hidden="true">
              <BookOpen className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.18em] text-amber-700 uppercase">
                页语
              </p>
              <p className="truncate text-sm font-medium text-slate-700">
                {docMeta?.fileName ?? '未打开文档'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
            <IconButton
              label="上一页"
              onClick={() => goToPage(page - 1)}
              disabled={!pdfDoc || page === 1}
            >
              <ChevronLeft />
            </IconButton>
            <label className="flex h-7 items-center gap-1.5 px-1 text-xs tabular-nums text-slate-600">
              <span className="sr-only">跳转页码</span>
              <input
                className="h-6 w-8 rounded border border-transparent bg-transparent text-center font-semibold text-slate-900 outline-none focus:border-amber-400 focus:bg-amber-50"
                inputMode="numeric"
                value={page}
                onChange={(event) => goToPage(Number(event.target.value) || 1)}
              />
              <span className="text-slate-300">/</span>
              <span className="pr-1">{docMeta?.pageCount ?? '—'}</span>
            </label>
            <IconButton
              label="下一页"
              onClick={() => goToPage(page + 1)}
              disabled={!pdfDoc || page === docMeta?.pageCount}
            >
              <ChevronRight />
            </IconButton>
          </div>

          <div className="flex items-center justify-end gap-2">
            <div className="hidden items-center gap-1.5 md:flex">
              <Languages className="size-3.5 text-slate-400" />
              <span className="text-[11px] text-slate-400">自动识别 →</span>
              <NativeSelect
                size="sm"
                aria-label="目标语言"
                value={targetLanguage}
                onChange={(event) => setTargetLanguage(event.target.value)}
              >
                {TARGET_LANGUAGES.map((language) => (
                  <NativeSelectOption key={language} value={language}>
                    {language}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="hidden items-center rounded-lg border border-slate-200 bg-white p-1 sm:flex">
              <IconButton
                label="缩小"
                onClick={() => setZoom(stepZoom(zoom, -1))}
                disabled={zoom === 75}
              >
                <Minus />
              </IconButton>
              <span className="w-11 text-center text-xs tabular-nums text-slate-600">
                {zoom}%
              </span>
              <IconButton
                label="放大"
                onClick={() => setZoom(stepZoom(zoom, 1))}
                disabled={zoom === 150}
              >
                <Plus />
              </IconButton>
            </div>
            <IconButton
              label="阅读服务设置"
              onClick={() => openSettings('translation')}
            >
              <Settings />
            </IconButton>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportOpen(true)}
            >
              <FileText />
              {pdfDoc ? '更换 PDF' : '导入 PDF'}
            </Button>
          </div>
        </header>

        <section className="relative min-h-0 flex-1">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel
              defaultSize={translationVisible ? '55%' : '100%'}
              minSize="38%"
            >
              <section className="reader-pane" aria-label="PDF 原文阅读区">
                <div className="pane-heading">
                  <div>
                    <p className="pane-eyebrow">原文</p>
                    <p className="pane-meta">
                      {docMeta
                        ? `${docMeta.pageCount} 页 · ${docMeta.scanDetected ? '扫描件 · 可用视觉 OCR' : '文字型 PDF'}`
                        : '等待导入'}
                    </p>
                  </div>
                  {docMeta ? (
                    <span className="status-chip">第 {page} 页正在阅读</span>
                  ) : null}
                </div>
                <div className="reader-workspace">
                  {docMeta ? (
                    <nav
                      className="thumbnail-sidebar"
                      aria-label="PDF 页面预览"
                    >
                      <div className="thumbnail-sidebar-heading">
                        <span>页面</span>
                        <span>{docMeta.pageCount}</span>
                      </div>
                      <div className="thumbnail-scroll">
                        {pageNumbers.map((pageNumber) => (
                          <PdfPageThumbnail
                            key={pageNumber}
                            pdfDoc={pdfDoc!}
                            page={pageNumber}
                            active={pageNumber === page}
                            activeRef={
                              pageNumber === page
                                ? activeThumbnailRef
                                : undefined
                            }
                            onSelect={() => goToPage(pageNumber)}
                          />
                        ))}
                      </div>
                    </nav>
                  ) : null}

                  <div
                    ref={documentStageRef}
                    className="document-stage"
                    aria-label="PDF 连续阅读画布"
                    onScroll={updatePageFromScroll}
                  >
                    {pdfDoc && docMeta ? (
                      <div className="document-pages">
                        {pageNumbers.map((pageNumber) => {
                          const width = currentPageWidth;
                          const height =
                            pageHeightsPx[pageNumber - 1] ||
                            (width > 0 ? width / 0.707 : 800);
                          return (
                            <article
                              key={pageNumber}
                              ref={(node) => {
                                if (node)
                                  pageElementsRef.current.set(pageNumber, node);
                                else pageElementsRef.current.delete(pageNumber);
                              }}
                              data-page={pageNumber}
                              className={`pdf-page ${pageNumber === page ? 'pdf-page-current' : ''}`}
                              style={
                                width > 0 ? { width: `${width}px` } : undefined
                              }
                              aria-label={`PDF 第 ${pageNumber} 页${pageNumber === page ? '，当前页' : ''}`}
                            >
                              <div
                                className="relative overflow-hidden bg-white shadow-[0_3px_14px_rgba(15,23,42,0.16)] ring-1 ring-slate-900/5"
                                style={{ height: `${height}px` }}
                              >
                                {renderedPages.has(pageNumber) ? (
                                  <PdfPageCanvas
                                    key={`${pageNumber}-${width}`}
                                    pdfDoc={pdfDoc}
                                    pageNumber={pageNumber}
                                    width={width}
                                    height={height}
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center bg-white">
                                    <span className="text-xs text-slate-300">
                                      {pageNumber}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <WelcomeStage onImport={() => setImportOpen(true)} />
                    )}
                  </div>
                </div>
              </section>
            </ResizablePanel>

            {translationVisible ? (
              <>
                <ResizableHandle withHandle className="bg-slate-200" />
                <ResizablePanel defaultSize="45%" minSize="30%">
                  <aside
                    className="translation-pane"
                    aria-label="当前页阅读辅助区"
                  >
                    <Tabs
                      className="h-full min-h-0 gap-0"
                      value={rightMode}
                      onValueChange={(value) =>
                        setRightMode(
                          value as
                            | 'translation'
                            | 'chat'
                            | 'summary'
                            | 'mindmap',
                        )
                      }
                    >
                      <div className="pane-heading border-b border-slate-200/80">
                        <div className="min-w-0">
                          <TabsList className="h-8">
                            <TabsTrigger
                              value="translation"
                              className="px-3 text-xs"
                            >
                              <Languages />
                              页面翻译
                            </TabsTrigger>
                            <TabsTrigger value="chat" className="px-3 text-xs">
                              <MessageCircle />
                              AI 答疑
                            </TabsTrigger>
                            {courseContext?.digest ? (
                              <>
                                <TabsTrigger
                                  value="summary"
                                  className="px-3 text-xs"
                                >
                                  <FileText />
                                  PDF 总结
                                </TabsTrigger>
                                <TabsTrigger
                                  value="mindmap"
                                  className="px-3 text-xs"
                                >
                                  <Network />
                                  PDF 脑图
                                </TabsTrigger>
                              </>
                            ) : null}
                          </TabsList>
                          <p className="pane-meta truncate">
                            {rightMode === 'translation'
                              ? `第 ${translationPage} 页 · ${targetLanguage}${remoteProvider ? ' · 已连接翻译服务' : ' · 演示模式'}`
                              : rightMode === 'chat'
                                ? `第 ${translationPage} 页 · 文字与视觉上下文`
                                : `整份 PDF · 已保存到课程文件夹`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          {rightMode === 'translation' ? (
                            <>
                              <IconButton
                                label="复制译文"
                                onClick={copyTranslation}
                                disabled={!isReady}
                              >
                                {copied ? (
                                  <Check className="text-emerald-600" />
                                ) : (
                                  <Copy />
                                )}
                              </IconButton>
                              <IconButton
                                label="重新翻译"
                                onClick={retranslate}
                                disabled={!pdfDoc}
                              >
                                <RotateCcw />
                              </IconButton>
                            </>
                          ) : null}
                          <IconButton
                            label="收起阅读辅助区"
                            onClick={() => setTranslationVisible(false)}
                          >
                            <PanelRightClose />
                          </IconButton>
                        </div>
                      </div>

                      <TabsContent
                        value="translation"
                        keepMounted
                        className="min-h-0 overflow-hidden data-[hidden]:hidden"
                      >
                        <div className="translation-scroll h-full">
                          {pdfDoc ? (
                            <>
                              {currentState?.status === 'error' ? null : (
                                <div className="translation-status">
                                  <span className="flex size-7 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                                    <CircleHelp className="size-3.5" />
                                  </span>
                                  <div>
                                    <p className="text-xs font-medium text-slate-700">
                                      {copied ? '译文已复制' : statusLabel}
                                    </p>
                                    <p className="mt-0.5 text-[11px] text-slate-400">
                                      {docMeta?.scanDetected
                                        ? '扫描页图像仅在 OCR 时发送给已配置视觉模型'
                                        : remoteProvider
                                          ? `当前页文字将发送至 ${remoteProviderHost ?? '所配置服务'}`
                                          : '演示模式 · 不发送任何数据'}
                                    </p>
                                  </div>
                                </div>
                              )}
                              <TranslationBody
                                page={translationPage}
                                targetLanguage={targetLanguage}
                                state={currentState}
                                remoteProvider={remoteProvider}
                                onRetry={retranslate}
                              />
                            </>
                          ) : (
                            <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
                              <span className="mb-5 flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                                <FileText className="size-5" />
                              </span>
                              <h2 className="text-sm font-semibold text-slate-800">
                                译文将显示在这里
                              </h2>
                              <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
                                导入 PDF 后，右侧会自动跟随左侧正在阅读的页面。
                              </p>
                            </div>
                          )}
                        </div>
                      </TabsContent>

                      <TabsContent
                        value="chat"
                        keepMounted
                        className="flex min-h-0 flex-col overflow-hidden data-[hidden]:hidden"
                      >
                        <AIChatPanel
                          pdfDoc={pdfDoc}
                          fingerprint={docMeta?.fingerprint ?? null}
                          pageNumber={translationPage}
                          settings={chatSettings}
                          onOpenSettings={() => openSettings('chat')}
                        />
                      </TabsContent>

                      {courseContext?.digest ? (
                        <TabsContent
                          value="summary"
                          keepMounted
                          className="min-h-0 overflow-y-auto data-[hidden]:hidden"
                        >
                          <DocumentSummaryPanel
                            digest={courseContext.digest}
                            onOpenSource={goToPage}
                          />
                        </TabsContent>
                      ) : null}

                      {courseContext?.digest ? (
                        <TabsContent
                          value="mindmap"
                          keepMounted
                          className="min-h-0 overflow-y-auto data-[hidden]:hidden"
                        >
                          <KnowledgeMindmap
                            knowledge={mergeDocumentDigest(
                              emptyCourseKnowledge(
                                courseContext.document.id,
                                courseContext.digest.title,
                                courseContext.digest.updatedAt,
                              ),
                              courseContext.digest,
                              courseContext.digest.updatedAt,
                            )}
                            onOpenSource={(_, sourcePage) =>
                              goToPage(sourcePage)
                            }
                          />
                        </TabsContent>
                      ) : null}
                    </Tabs>
                  </aside>
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>

          {!translationVisible ? (
            <Button
              className="absolute top-3 right-3 shadow-md"
              size="sm"
              onClick={() => setTranslationVisible(true)}
            >
              <PanelRightOpen />
              展开阅读辅助
            </Button>
          ) : null}
        </section>

        <footer className="status-bar">
          <div className="flex items-center gap-2">
            <span
              className={`size-1.5 rounded-full ${
                rightMode === 'chat'
                  ? 'bg-violet-500'
                  : currentState?.status === 'error'
                    ? 'bg-rose-500'
                    : currentState?.status === 'translating' ||
                        currentState?.status === 'recognizing'
                      ? 'animate-pulse bg-amber-500'
                      : 'bg-emerald-500'
              }`}
            />
            <span>
              {rightMode === 'chat'
                ? docMeta
                  ? `AI 答疑已绑定第 ${translationPage} 页`
                  : '导入 PDF 后可使用 AI 答疑'
                : rightMode === 'summary'
                  ? 'PDF 总结已保存到课程文件夹'
                  : rightMode === 'mindmap'
                    ? 'PDF 脑图已保存到课程文件夹'
                    : statusLabel}
            </span>
          </div>
          <div className="flex items-center gap-4">
            {docMeta?.restoredPage ? (
              <span>已恢复上次阅读进度（第 {docMeta.restoredPage} 页）</span>
            ) : prefetchedTranslationPage === page + 1 ? (
              <span>第 {page + 1} 页译文已预取</span>
            ) : renderedPages.has(page + 1) ? (
              <span>第 {page + 1} 页已预加载</span>
            ) : null}
            <span className="hidden text-slate-300 sm:inline">
              PDF、OCR 结果、译文与对话仅保存在本机
            </span>
          </div>
        </footer>

        <Dialog open={importOpen} onOpenChange={setImportOpen}>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle className="text-lg">导入 PDF</DialogTitle>
              <DialogDescription>
                文件在本地浏览器中解析，不会上传。译文与阅读进度保存在本机。
              </DialogDescription>
            </DialogHeader>

            <button
              className="group mt-2 flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-6 text-center transition hover:border-amber-400 hover:bg-amber-50/50 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
            >
              <span className="mb-4 flex size-11 items-center justify-center rounded-full bg-white text-slate-600 shadow-sm ring-1 ring-slate-200 transition group-hover:text-amber-700">
                <FileUp className="size-5" />
              </span>
              <span className="text-sm font-semibold text-slate-800">
                {importing ? '正在解析 PDF…' : '选择本地 PDF 文件'}
              </span>
              <span className="mt-1 text-xs text-slate-500">
                支持文字型、扫描件和手写 PDF
              </span>
            </button>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                event.target.value = '';
              }}
            />

            {importError ? (
              <p className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                <TriangleAlert className="size-4 shrink-0" />
                {importError}
              </p>
            ) : null}

            <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-3">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              <p className="text-[11px] leading-5 text-slate-500">
                文字型 PDF 只发送当前页文字。扫描或手写页面需要 OCR
                时，会把当前页图像发送给“AI 答疑”中配置的视觉模型。PDF
                文件、阅读进度、识别结果、译文和对话都保存在本机。
              </p>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setImportOpen(false)}
                disabled={importing}
              >
                取消
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {settingsOpen ? (
          <ReaderSettingsDialog
            initialTab={settingsTab}
            translationSettings={settings}
            chatSettings={chatSettings}
            onClose={() => setSettingsOpen(false)}
            onSave={applySettings}
          />
        ) : null}
      </main>
    </TooltipProvider>
  );
}

export default function Home() {
  const [view, setView] = useState<'courses' | 'reader'>('courses');
  const [readerFile, setReaderFile] = useState<File | null>(null);
  const [readerContext, setReaderContext] =
    useState<CourseReaderContext | null>(null);

  if (view === 'reader') {
    return (
      <PdfReader
        initialFile={readerFile}
        courseContext={readerContext}
        onOpenCourses={() => setView('courses')}
      />
    );
  }

  return (
    <TooltipProvider>
      <main className="flex h-screen min-h-[680px] flex-col overflow-hidden bg-[#f5f7fa]">
        <header className="flex h-15 shrink-0 items-center justify-between border-b border-white/10 bg-[#243a59] px-5 text-white">
          <div className="flex items-center gap-3">
            <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-400 to-indigo-500 shadow-sm">
              <BookOpen className="size-4" />
            </span>
            <span className="text-sm font-semibold tracking-wide">页语</span>
          </div>
          <nav className="flex h-full items-center" aria-label="主导航">
            <button
              type="button"
              className="flex h-full items-center gap-2 border-b-2 border-violet-300 px-4 text-sm font-medium"
            >
              <LibraryBig className="size-4" /> 课程知识库
            </button>
            <button
              type="button"
              className="flex h-full items-center gap-2 border-b-2 border-transparent px-4 text-sm text-slate-300 hover:text-white"
              onClick={() => setView('reader')}
            >
              <FileText className="size-4" /> PDF 阅读器
            </button>
          </nav>
          <div className="w-24" aria-hidden="true" />
        </header>
        <CourseLibrary
          onOpenDocument={(file, context) => {
            setReaderFile(file);
            setReaderContext({
              ...context,
              onBack: () => setView('courses'),
            });
            setView('reader');
          }}
        />
      </main>
    </TooltipProvider>
  );
}
