'use client';

import { createProgressivePageSizes, captureReadingAnchor, restoreReadingAnchor, type ProgressivePageSize, type ReadingAnchor } from '@/lib/progressive-page-sizes';
import { alignParagraphs, mapTextItemsToParagraphs, type ParagraphAlignment } from '@/lib/paragraph-alignment';
import { revealParagraph, sourceParagraphIndices } from '@/lib/paragraph-dom';
import { TranslationParagraphs } from '@/components/translation-paragraphs';
import { createPdfImportLifecycle } from '@/lib/pdf-import-lifecycle';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  RefreshCw,
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
import type { SelectionQuestion } from '@/lib/selection-translation';
import { ReaderStatusFacts } from '@/components/reader-status-facts';
import { SelectionToolbar } from '@/components/selection-toolbar';
import { SharedCourseViewer } from '@/components/shared-course-viewer';
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
import {
  DEFAULT_KNOWLEDGE_SETTINGS,
  loadKnowledgeSettings,
  saveKnowledgeSettings,
  type KnowledgeSettings,
} from '@/lib/knowledge-settings';
import { ChatError } from '@/lib/chat';
import {
  loadPdfjs,
  type PDFDocumentProxy,
  type RenderTask,
  type TextLayer,
} from '@/lib/pdfjs';
import { itemsFromPdfJs, normalizePage, pageHasText } from '@/lib/pdf-text';
import { shouldBuildTextLayer, textLayerScale, textLayerTotalScale } from '@/lib/pdf-text-layer';
import {
  createOcrProviderForSettings,
  createOcrService,
  pageNeedsOcr,
  resolvePageOcr,
} from '@/lib/ocr';
import { renderPageImage } from '@/lib/page-vision';
import {
  computeFileFingerprint,
  type DocumentProgress,
  createReaderService,
  createProviderForSettings,
  DEFAULT_SETTINGS,
  findCachedPageTranslation,
  loadReaderSettings,
  readerServiceHost,
  resolvePageTranslation,
  saveReaderSettings,
  usingRemoteProvider,
  type CachedTranslation,
  type PageTranslationOutcome,
  type ReaderSettings,
} from '@/lib/reader-cache';
import {
  cachedTranslationFromShared,
  findRestorableSharedTranslation,
  publishCachedTranslationForReader,
  upsertSharedTranslation,
  type SharedTranslationRecord,
  type TranslationPublicationResult,
} from '@/lib/shared-translation';
import {
  clampPage,
  fillColumnPageWidth,
  nextPageToPrefetch,
  stepZoom,
} from '@/lib/reader-model';
import {
  mapShortcut,
  READER_RIGHT_MODES,
  type ReaderRightModeName,
} from '@/lib/reader-shortcuts';
import {
  countTranslated,
  statusBarParts,
  statusToBadge,
  type TranslationStatus,
} from '@/lib/reader-ui-status';
import {
  describeTranslationError,
  TranslationError,
  type TranslationErrorCode,
} from '@/lib/translation';
import {
  emptyCourseKnowledge,
  mergeDocumentDigest,
} from '@/lib/knowledge/course-merger';
import { isSharedView } from '@/lib/lan-share-api';

const TARGET_LANGUAGES = ['简体中文', '繁體中文', '日本語', '한국어'] as const;
const TRANSLATION_STABLE_DELAY = 300;
const PROGRESS_SAVE_DELAY = 800;
const DEFAULT_ZOOM = 95;

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
  source?: 'indexeddb' | 'course' | 'generated';
  provider?: string;
  model?: string;
  updatedAt?: string;
  cacheEntry?: CachedTranslation;
  persistence?: 'saving' | 'saved' | 'failed';
  persistenceError?: string;
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

interface SourceParagraphs { paragraphs: string[]; mapped: number[] }

function PdfPageCanvas({
  pdfDoc,
  pageNumber,
  width,
  height,
  activeParagraphs,
  revealRequest,
  onParagraphsReady,
  onParagraphActivate,
}: {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  height: number;
  activeParagraphs: number[];
  revealRequest: object | null;
  onParagraphsReady: (page: number, source: SourceParagraphs) => void;
  onParagraphActivate: (page: number, index: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const revealedRequestRef = useRef<object | null>(null);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [renderResult, setRenderResult] = useState<{
    doc: PDFDocumentProxy; page: number; width: number; height: number; attempt: number; failed: boolean;
  } | null>(null);
  const currentRender = renderResult?.doc === pdfDoc && renderResult.page === pageNumber &&
    renderResult.width === width && renderResult.height === height && renderResult.attempt === renderAttempt;
  const rendering = !currentRender;
  const renderError = currentRender && renderResult.failed;
  const [textAvailability, setTextAvailability] = useState<'loading' | 'ready' | 'none' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    let activeTextLayer: TextLayer | null = null;
    textLayerRef.current?.replaceChildren();

    void (async () => {
      const pdfPage = await pdfDoc.getPage(pageNumber);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const base = pdfPage.getViewport({ scale: 1 });
      // Both layers derive from one scale: the canvas backing store adds the
      // DPR on top, and any drift between the two would offset the selection.
      const scale = textLayerScale(width, base.width);
      const viewport = pdfPage.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context unavailable');
      task = pdfPage.render({ canvas, canvasContext: context, viewport });
      await task.promise;
      if (!cancelled) setRenderResult({ doc: pdfDoc, page: pageNumber, width, height, attempt: renderAttempt, failed: false });
    })().catch(() => {
      if (!cancelled) setRenderResult({ doc: pdfDoc, page: pageNumber, width, height, attempt: renderAttempt, failed: true });
    });

    // Selectable text overlay, rebuilt alongside the canvas from the same
    // inputs so its geometry always matches the rendered page box.
    void (async () => {
      const pdfjs = await loadPdfjs();
      const pdfPage = await pdfDoc.getPage(pageNumber);
      const container = textLayerRef.current;
      if (cancelled || !container) return;
      setTextAvailability('loading');
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
      // Scanned pages have no extractable text — keep them canvas-only.
      if (!shouldBuildTextLayer(items)) {
        onParagraphsReady(pageNumber, { paragraphs: [], mapped: [] });
        setTextAvailability('none');
        return;
      }
      container.style.setProperty('--total-scale-factor', String(textLayerTotalScale(width, base.width, pdfPage.userUnit)));
      activeTextLayer = new pdfjs.TextLayer({
        textContentSource: content,
        container,
        viewport: pdfPage.getViewport({ scale }),
      });
      await activeTextLayer.render();
      if (cancelled) return;
      const normalized = normalizePage(items);
      // Sparse selectable text can still trigger OCR (e.g. a scanned page
      // with a short header). OCR paragraphs have no TextLayer geometry.
      const paragraphs = pageNeedsOcr(normalized.text) ? [] : normalized.paragraphs;
      // TextLayer.textDivs preserves raw string-item order (including blanks),
      // whereas the normalizer sorts by geometry. Keep those indices separate.
      const rawItems = content.items.filter((item) => 'str' in item).map((item) =>
        itemsFromPdfJs([item], base.height)[0] ?? { str: '', x: 0, y: 0, width: 0, height: 0 });
      const mapping = mapTextItemsToParagraphs(paragraphs, rawItems);
      const mapped = new Set<number>();
      (activeTextLayer.textDivs ?? []).forEach((span, index) => {
        const indices = mapping[index] ?? [];
        if (indices.length) {
          span.dataset.sourceParagraphs = indices.join(' ');
          indices.forEach((value) => mapped.add(value));
        }
      });
      onParagraphsReady(pageNumber, { paragraphs, mapped: [...mapped] });
      setTextAvailability('ready');
    })().catch(() => {
      // Cancelled rebuilds reject; a missing text layer never blocks reading.
      if (!cancelled) {
        onParagraphsReady(pageNumber, { paragraphs: [], mapped: [] });
        setTextAvailability('error');
      }
    });

    return () => {
      cancelled = true;
      task?.cancel();
      activeTextLayer?.cancel();
    };
  }, [pdfDoc, pageNumber, width, height, onParagraphsReady, renderAttempt]);

  useEffect(() => {
    const spans = textLayerRef.current?.querySelectorAll<HTMLElement>('[data-source-paragraphs]');
    spans?.forEach((span) => span.classList.toggle('paragraph-source-active',
      sourceParagraphIndices(span).some((index) => activeParagraphs.includes(index))));
    if (revealRequest && revealedRequestRef.current !== revealRequest && textAvailability === 'ready') {
      const first = textLayerRef.current?.querySelector<HTMLElement>('.paragraph-source-active');
      if (first) {
        revealParagraph(first, '.document-stage', Array.from(textLayerRef.current?.querySelectorAll<HTMLElement>('.paragraph-source-active') ?? []));
        revealedRequestRef.current = revealRequest;
      }
    }
  }, [activeParagraphs, revealRequest, textAvailability]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="block bg-white"
        aria-label={`第 ${pageNumber} 页内容`}
      />
      <div ref={textLayerRef} className="pdf-text-layer" aria-hidden="true" data-page-number={pageNumber}
        onClick={(event) => {
          // Preserve A1 drag selection and double-click word selection.
          if (event.detail > 1 || window.getSelection()?.toString().trim()) return;
          const span = (event.target as Element).closest('[data-source-paragraphs]');
          const index = span ? sourceParagraphIndices(span)[0] : undefined;
          if (index !== undefined) onParagraphActivate(pageNumber, index);
        }} />
      {textAvailability === 'none' || textAvailability === 'error' ? (
        <span className="absolute right-2 bottom-2 rounded bg-slate-100 px-2 py-1 text-xs text-slate-500">
          {textAvailability === 'none' ? '该页无可选文字' : '该页文字层加载失败，请重试'}
        </span>
      ) : null}
      {renderError ? (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-4 text-sm text-slate-700">
          <TriangleAlert className="size-6 text-amber-600" />
          <p>第 {pageNumber} 页渲染失败，请重试。</p>
          <Button variant="outline" size="sm" onClick={() => setRenderAttempt((attempt) => attempt + 1)}>重试渲染第 {pageNumber} 页</Button>
        </div>
      ) : null}
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
  translationStatus,
  onSelect,
  activeRef,
}: {
  pdfDoc: PDFDocumentProxy;
  page: number;
  active: boolean;
  translationStatus?: TranslationStatus;
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

  const badge = translationStatus ? statusToBadge(translationStatus) : null;

  return (
    <button
      ref={activeRef}
      type="button"
      className={`page-thumbnail ${active ? 'page-thumbnail-active' : ''}`}
      aria-label={`查看第 ${page} 页${active ? '，当前页' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
    >
      <span className="thumbnail-thumb">
        <span className="thumbnail-paper" aria-hidden="true" ref={holderRef}>
          {visible ? (
            <canvas ref={canvasRef} className="h-full w-full object-cover" />
          ) : (
            <span className="thumbnail-line w-full" />
          )}
        </span>
        {badge ? (
          <span
            className={`thumbnail-status-badge thumbnail-status-badge-${badge.tone}`}
            aria-label={`第 ${page} 页翻译状态：${badge.label}`}
          >
            {badge.label}
          </span>
        ) : null}
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
  onRetrySave,
  onOpenSettings,
  alignment,
  activeParagraphs,
  onParagraphActivate,
  revealRequest,
}: {
  page: number;
  targetLanguage: string;
  state: PageTranslationState | undefined;
  remoteProvider: boolean;
  onRetry: () => void;
  onRetrySave: () => void;
  onOpenSettings: () => void;
  alignment: ParagraphAlignment;
  activeParagraphs: number[];
  onParagraphActivate: (index: number) => void;
  revealRequest: object | null;
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
          <TranslationParagraphs paragraphs={state.paragraphs} />
          <output
            className="flex items-center gap-2 text-xs text-amber-700"
            aria-live="polite"
            aria-label="翻译中"
          >
            <LoaderCircle className="size-3.5 animate-spin" />
            正在翻译…
          </output>
        </article>
      );
    }
    return (
      <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
        <span className="mb-5 flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <LoaderCircle className="size-5 animate-spin" />
        </span>
        <output aria-live="polite" className="text-sm font-semibold text-slate-800">
          {state?.status === 'recognizing'
            ? `正在识别第 ${page} 页`
            : `正在翻译第 ${page} 页`}
        </output>
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
          <span role="alert">{state.errorMessage ?? '翻译服务出现错误。'}</span>
        </p>
        <Button className="mt-6" size="sm" onClick={onRetry}>
          <RotateCcw />
          重新翻译
        </Button>
        <Button className="mt-2" size="sm" variant="outline" onClick={onOpenSettings}>检查或更换服务</Button>
      </div>
    );
  }

  return (
    <article className="translation-copy">
      <p className="paragraph-alignment-note">
        {alignment.mode === 'unavailable'
          ? '该页原文段落暂不可定位（文字层未就绪或无可选文字）。'
          : alignment.mode === 'estimated'
            ? '段落数量不同，按顺序、长度和共有词估算对应；可能高亮多个段落，请核对原文。'
            : '按段落顺序对照；点击原文或译文可双向定位。'}
        {alignment.mode !== 'unavailable' && alignment.targetToSource.some((group, index) => !group.length && state.paragraphs?.[index]?.trim())
          ? ' 部分原文无法定位，对应译文未启用跳转。' : ''}
      </p>
      <TranslationParagraphs paragraphs={state.paragraphs ?? []} alignment={alignment}
        active={activeParagraphs} onActivate={onParagraphActivate} revealRequest={revealRequest} />
      {state.model ? (
        <p className="mt-6 text-[11px] text-slate-400">
          模型：{state.model}
          {state.source === 'course'
            ? ' · 已从课程目录恢复'
            : state.source === 'indexeddb'
              ? ' · 本机缓存'
              : ''}
        </p>
      ) : null}
      {state.persistence === 'failed' ? (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700"
        >
          <p>译文已生成，保存到课程目录失败</p>
          <p className="mt-1 text-[11px] text-rose-600/80">
            {state.persistenceError ?? '请检查课程目录后重试。'}
          </p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={onRetrySave}
          >
            <RefreshCw />
            重试保存
          </Button>
        </div>
      ) : null}
      {remoteProvider ||
      state.source === 'course' ||
      state.source === 'indexeddb' ? null : (
        <p className="mt-10 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-xs text-slate-500">
          当前显示的是内置演示译文。在“阅读服务设置 → 页面翻译”中配置 OpenAI
          兼容服务后，这里将显示真实译文。
          <button type="button" className="ml-2 underline" onClick={onOpenSettings}>配置翻译服务</button>
        </p>
      )}
    </article>
  );
}

function PdfReader({
  initialFile,
  courseContext,
  onOpenCourses,
  suspended = false,
  onStandaloneImport,
}: {
  initialFile?: File | null;
  courseContext?: CourseReaderContext | null;
  onOpenCourses: () => void;
  /** True while the course library covers this reader; the DOM stays mounted. */
  suspended?: boolean;
  /** Called when a PDF is imported from this reader's own import dialog. */
  onStandaloneImport?: (file: File) => void;
}) {
  const sizeLoaderRef = useRef<ReturnType<typeof createProgressivePageSizes> | null>(null);
  const importLifecycleRef = useRef(createPdfImportLifecycle<PDFDocumentProxy>());
  const consumedInitialFileRef = useRef<File | null>(null);
  useEffect(() => {
    const lifecycle = importLifecycleRef.current;
    return () => { lifecycle.dispose(); sizeLoaderRef.current?.cancel(); };
  }, []);
  const [sourceParagraphs, setSourceParagraphs] = useState<Record<number, SourceParagraphs>>({});
  const [paragraphSelection, setParagraphSelection] = useState<{
    page: number; language: string; side: 'source' | 'target'; index: number;
  } | null>(null);
  const rememberSourceParagraphs = useCallback((pageNumber: number, source: SourceParagraphs) => {
    setSourceParagraphs((current) => ({ ...current, [pageNumber]: source }));
  }, []);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [docMeta, setDocMeta] = useState<DocumentMeta | null>(null);
  const [pageSizes, setPageSizes] = useState<ProgressivePageSize[]>([]);
  const [page, setPage] = useState(1);
  const [translationPage, setTranslationPage] = useState(1);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [targetLanguage, setTargetLanguage] = useState<string>('简体中文');
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [chatSettings, setChatSettings] = useState<ChatSettings>(
    DEFAULT_CHAT_SETTINGS,
  );
  const [knowledgeSettings, setKnowledgeSettings] = useState<KnowledgeSettings>(
    DEFAULT_KNOWLEDGE_SETTINGS,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('translation');
  const [rightMode, setRightMode] = useState<ReaderRightModeName>(
    courseContext?.digest ? 'summary' : 'translation',
  );
  const [translationStates, setTranslationStates] = useState<
    Record<string, PageTranslationState>
  >({});
  const [publishedTranslations, setPublishedTranslations] = useState<
    SharedTranslationRecord[]
  >([]);
  const [renderedPages, setRenderedPages] = useState<Set<number>>(
    () => new Set(),
  );
  const [copied, setCopied] = useState(false);
  const [selectionQuestion, setSelectionQuestion] = useState<SelectionQuestion | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [progressRecovery, setProgressRecovery] = useState<{
    fingerprint: string; requestedPage?: number; isCurrent: () => boolean;
  } | null>(null);
  const [recoveringProgress, setRecoveringProgress] = useState(false);
  const [translationVisible, setTranslationVisible] = useState(true);
  const [stageWidth, setStageWidth] = useState(0);
  const [prefetchedTranslationPage, setPrefetchedTranslationPage] = useState<
    number | null
  >(null);

  const readerRootRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const documentStageRef = useRef<HTMLDivElement>(null);
  const pageElementsRef = useRef(new Map<number, HTMLElement>());
  const activeThumbnailRef = useRef<HTMLButtonElement>(null);
  const scrollTargetRef = useRef<number | null>(null);
  const positionedRef = useRef(false);
  const sizeAnchorRef = useRef<ReadingAnchor | null>(null);
  const geometryRef = useRef<{ tops: number[]; heights: number[] }>({ tops: [], heights: [] });
  const serviceRef = useRef<ReturnType<typeof createReaderService> | null>(
    null,
  );
  const ocrCacheRef = useRef<ReturnType<typeof createOcrService> | null>(null);
  const settingsRef = useRef(settings);
  const chatSettingsRef = useRef(chatSettings);
  const onStandaloneImportRef = useRef(onStandaloneImport);
  const bypassCacheRef = useRef(new Set<string>());
  const prefetchedTranslationsRef = useRef(new Set<string>());
  const retryTokenRef = useRef(0);
  const [retryToken, setRetryToken] = useState(0);
  const pageRef = useRef(page);
  const suspendedRef = useRef(suspended);
  const settingsOpenRef = useRef(settingsOpen);
  const courseDocumentIdRef = useRef<string | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    chatSettingsRef.current = chatSettings;
  }, [chatSettings]);

  useEffect(() => {
    onStandaloneImportRef.current = onStandaloneImport;
  }, [onStandaloneImport]);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    suspendedRef.current = suspended;
  }, [suspended]);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  const glossary = courseContext?.glossary;
  const termFingerprint = courseContext?.glossaryFingerprint ?? '';
  const translationKey = useCallback(
    (pageNumber: number, language: string) => `${pageNumber}:${language}:${termFingerprint}`,
    [termFingerprint],
  );

  const publishCourseTranslation = useCallback(
    async (
      cached: CachedTranslation,
    ): Promise<TranslationPublicationResult> => {
      const storage = courseContext?.storage;
      const document = courseContext?.document;
      if (
        !storage?.publishTranslation ||
        !document ||
        courseDocumentIdRef.current !== document.id ||
        document.fingerprint !== cached.fingerprint
      )
        return { status: 'skipped' };
      // The built-in provider is a UI demo and must never become a shared
      // course artifact. Standalone PDFs have no course storage and also stop
      // here, so temporary reader data remains local.
      if (cached.provider === 'mock') return { status: 'skipped' };
      return publishCachedTranslationForReader(storage, cached, document.id);
    },
    [courseContext?.document, courseContext?.storage],
  );

  const rememberPublishedTranslation = useCallback(
    (cached: CachedTranslation) => {
      const document = courseContext?.document;
      if (
        !document ||
        courseDocumentIdRef.current !== document.id ||
        document.fingerprint !== cached.fingerprint
      ) {
        return;
      }
      setPublishedTranslations((current) =>
        upsertSharedTranslation(current, cached, document.id),
      );
    },
    [courseContext?.document],
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
      setKnowledgeSettings(loadKnowledgeSettings());
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

  useLayoutEffect(() => {
    const stage = documentStageRef.current;
    if (stage && sizeAnchorRef.current) {
      stage.scrollTop = restoreReadingAnchor(sizeAnchorRef.current, pageTops, pageHeightsPx);
      sizeAnchorRef.current = null;
    }
    geometryRef.current = { tops: pageTops, heights: pageHeightsPx };
  }, [pageTops, pageHeightsPx]);

  useEffect(() => {
    for (const visiblePage of renderedPages) void sizeLoaderRef.current?.load(visiblePage);
  }, [renderedPages]);

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
      setSelectionQuestion(null);
      setParagraphSelection(null);
      setCopied(false);
      setPage(targetPage);
      scrollTargetRef.current = targetPage;
      sizeAnchorRef.current = { page: targetPage, fraction: 0 };
      void sizeLoaderRef.current?.load(targetPage);
      requestAnimationFrame(() => {
        pageElementsRef.current
          .get(targetPage)
          ?.scrollIntoView({ behavior: 'auto', block: 'start' });
        scrollTargetRef.current = null;
        sizeAnchorRef.current = null;
      });
    },
    [docMeta?.pageCount],
  );

  // Keyboard shortcuts: key→action mapping stays pure in lib/reader-shortcuts;
  // refs keep this subscription stable across page turns and zoom changes.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcut = mapShortcut(event);
      if (!shortcut) return;
      // Portalled dialogs and other screens keep their own keyboard handling.
      if (event.target !== document.body &&
          !readerRootRef.current?.contains(event.target as Node)) return;
      // While the settings dialog owns the screen, only dismiss applies.
      if (shortcut.action !== 'dismiss' && (settingsOpenRef.current || importOpen || shortcutsOpen || !pdfDoc)) return;
      // The reader stays mounted behind the course library; ignore keys there.
      if (suspendedRef.current) return;

      switch (shortcut.action) {
        case 'nextPage':
          goToPage(pageRef.current + 1);
          break;
        case 'prevPage':
          goToPage(pageRef.current - 1);
          break;
        case 'firstPage':
          goToPage(1);
          break;
        case 'lastPage':
          goToPage(Number.MAX_SAFE_INTEGER);
          break;
        case 'zoomIn':
          setZoom((current) => stepZoom(current, 1));
          break;
        case 'zoomOut':
          setZoom((current) => stepZoom(current, -1));
          break;
        case 'zoomReset':
          setZoom(DEFAULT_ZOOM);
          break;
        case 'toggleRightMode':
          setRightMode(READER_RIGHT_MODES[shortcut.mode]);
          setTranslationVisible(true);
          break;
        case 'toggleRightPanel':
          setTranslationVisible((visible) => !visible);
          break;
        case 'dismiss':
          setSettingsOpen(false);
          setShortcutsOpen(false);
          setImportOpen(false);
          window.getSelection()?.removeAllRanges();
          break;
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goToPage, importOpen, shortcutsOpen, pdfDoc]);

  useEffect(() => {
    if (!pdfDoc || !stageWidth || positionedRef.current) return;
    positionedRef.current = true;
    pageElementsRef.current.get(page)?.scrollIntoView({ block: 'start' });
  }, [pdfDoc, page, stageWidth]);

  useEffect(() => {
    activeThumbnailRef.current?.scrollIntoView({ block: 'nearest' });
  }, [page]);

  // A display:none subtree loses its scroll position, so when the reader comes
  // back from behind the course library, re-anchor on the page being read.
  const anchorOnResumeRef = useRef(false);
  useEffect(() => {
    if (suspended) {
      anchorOnResumeRef.current = true;
      return;
    }
    if (!anchorOnResumeRef.current) return;
    anchorOnResumeRef.current = false;
    const frame = requestAnimationFrame(() => {
      pageElementsRef.current.get(page)?.scrollIntoView({ block: 'start' });
      activeThumbnailRef.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [suspended, page]);

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

  const handleFile = useCallback(
    async (
      file: File,
      requestedPage?: number,
      origin: 'home' | 'dialog' = 'home',
    ) => {
      const job = importLifecycleRef.current.begin();
      // A standalone import can happen while the previous course context is
      // still clearing in the parent. Disable course restore/publication
      // immediately so an identical temporary PDF cannot write the course.
      courseDocumentIdRef.current = null;
      setImporting(true);
      setImportError(null);
      try {
        const buffer = await file.arrayBuffer();
        const fingerprint = await computeFileFingerprint(buffer);
        const pdfjs = await loadPdfjs();
        if (!job.isCurrent()) return;
        // getDocument may transfer the buffer to the worker, so hand it a copy.
        const loadingTask = pdfjs.getDocument({
          data: new Uint8Array(buffer.slice(0)),
        });
        if (!job.ownTask(loadingTask)) return;
        const doc = await loadingTask.promise;
        if (!job.resolved(doc)) return;

        const firstPage = await doc.getPage(1);
        if (!job.isCurrent()) return;
        const firstViewport = firstPage.getViewport({ scale: 1 });

        // Scanned-PDF rule: sample the first pages; no text layer means the
        // MVP cannot translate this document.
        let scanDetected = true;
        for (
          let pageNumber = 1;
          pageNumber <= Math.min(3, doc.numPages);
          pageNumber += 1
        ) {
          const pdfPage = await doc.getPage(pageNumber);
          if (!job.isCurrent()) return;
          const viewport = pdfPage.getViewport({ scale: 1 });
          const content = await pdfPage.getTextContent();
          if (!job.isCurrent()) return;
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

        let restored: DocumentProgress | undefined;
        let progressReadFailed = false;
        try {
          restored = await serviceRef.current?.progress.load(fingerprint);
        } catch {
          progressReadFailed = true;
        }
        let restoredTranslations: SharedTranslationRecord[] = [];
        const courseStorage = courseContext?.storage;
        const contextDocument = courseContext?.document;
        const courseDocument =
          contextDocument?.fingerprint === fingerprint ? contextDocument : null;
        if (
          origin !== 'dialog' &&
          courseDocument &&
          courseStorage?.listTranslations
        ) {
          try {
            restoredTranslations = await courseStorage.listTranslations(
              courseDocument.id,
            );
          } catch {
            // A transient translation-directory read failure must not block
            // opening the PDF; a later retry/reopen can recover the records.
          }
        }
        if (!job.commit(doc)) return;
        setRecoveringProgress(false);
        setProgressRecovery(progressReadFailed ? { fingerprint, requestedPage, isCurrent: job.isCurrent } : null);
        positionedRef.current = false;
        setRenderedPages(new Set());
        setTranslationStates({});
        setSelectionQuestion(null);
        setSourceParagraphs({});
        setParagraphSelection(null);
        translationStatesRef.current = {};
        setPublishedTranslations(restoredTranslations);
        courseDocumentIdRef.current =
          origin !== 'dialog' ? (courseDocument?.id ?? null) : null;
        prefetchedTranslationsRef.current.clear();
        setPrefetchedTranslationPage(null);
        pageElementsRef.current.clear();
        sizeLoaderRef.current?.cancel();
        sizeAnchorRef.current = null;
        const sizeLoader = createProgressivePageSizes(doc, firstViewport, (sizes) => {
          const stage = documentStageRef.current;
          if (stage && !sizeAnchorRef.current) {
            const geometry = geometryRef.current;
            sizeAnchorRef.current = captureReadingAnchor(stage.scrollTop, geometry.tops, geometry.heights, scrollTargetRef.current);
          }
          setPageSizes(sizes);
        });
        sizeLoaderRef.current = sizeLoader;
        setPdfDoc(doc);
        setPageSizes(sizeLoader.initial);
        setDocMeta({
          fingerprint,
          fileName: file.name,
          pageCount: doc.numPages,
          scanDetected,
          restoredPage:
            restored && restored.lastPage > 1 ? restored.lastPage : null,
        });
        setZoom(restored?.zoom ?? DEFAULT_ZOOM);
        setTargetLanguage(restored?.targetLanguage ?? '简体中文');
        const openingPage = clampPage(
          requestedPage ?? restored?.lastPage ?? 1,
          doc.numPages,
        );
        sizeAnchorRef.current = { page: openingPage, fraction: 0 };
        void sizeLoader.load(openingPage);
        void sizeLoader.complete();
        setPage(openingPage);
        setTranslationPage(openingPage);
        if (origin === 'dialog') onStandaloneImportRef.current?.(file);
        setImportOpen(false);
      } catch {
        if (!job.isCurrent()) return;
        setImportError('无法解析该 PDF 文件，文件可能已损坏或已加密。');
      } finally {
        if (job.isCurrent()) setImporting(false);
        job.finish();
      }
    },
    [courseContext],
  );

  useEffect(() => {
    if (initialFile && consumedInitialFileRef.current !== initialFile) {
      const timer = setTimeout(() => {
        // Consume the file handoff when it starts, including while pending.
        // Context refresh/clearing must not reopen an old course PDF. Marking
        // inside the timer also leaves StrictMode cleanup free to cancel it.
        consumedInitialFileRef.current = initialFile;
        void handleFile(initialFile, courseContext?.initialPage);
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [courseContext?.initialPage, handleFile, initialFile]);

  const retryProgressRecovery = async () => {
    if (!progressRecovery || recoveringProgress) return;
    const recovery = progressRecovery;
    setRecoveringProgress(true);
    try {
      const restored = await serviceRef.current?.progress.load(recovery.fingerprint);
      if (!recovery.isCurrent()) return;
      if (restored) {
        setZoom(restored.zoom);
        setTargetLanguage(restored.targetLanguage);
        goToPage(recovery.requestedPage ?? restored.lastPage);
        setDocMeta((current) => current ? { ...current, restoredPage: restored.lastPage > 1 ? restored.lastPage : null } : current);
      }
      setProgressRecovery(null);
    } catch {
      // Keep the recovery actions available; the opened PDF remains usable.
    } finally {
      if (recovery.isCurrent()) setRecoveringProgress(false);
    }
  };

  // Do not overwrite unread progress until recovery succeeds or is ignored.
  // Persist reading progress for this fingerprint.
  useEffect(() => {
    if (!pdfDoc || !docMeta || progressRecovery) return;
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
  }, [pdfDoc, docMeta, page, zoom, targetLanguage, progressRecovery]);

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
        const provider = createProviderForSettings(settingsRef.current);
        const finishOutcome = async (outcome: PageTranslationOutcome) => {
          if (cancelled) return;
          const publication =
            outcome.source === 'course'
              ? ({ status: 'skipped' } satisfies TranslationPublicationResult)
              : await publishCourseTranslation(outcome.cacheEntry);
          if (cancelled) return;
          if (publication.status === 'saved') {
            rememberPublishedTranslation(outcome.cacheEntry);
          }
          updateTranslationState(key, {
            status: outcome.status,
            paragraphs: outcome.result.paragraphs,
            source: outcome.source,
            provider: outcome.result.provider,
            model: outcome.result.model,
            updatedAt: outcome.cacheEntry.updatedAt,
            cacheEntry: outcome.cacheEntry,
            persistence: publication.status === 'failed' ? 'failed' : 'saved',
            persistenceError: publication.error,
          });
        };

        if (!bypassRequested) {
          const exactCached = await findCachedPageTranslation({
            glossaryFingerprint: termFingerprint,
            cache: serviceRef.current!.cache,
            fingerprint: docMeta.fingerprint,
            pageNumber: translationPage,
            targetLanguage,
            provider: provider.id,
            model: provider.model,
          });
          if (exactCached) {
            await finishOutcome({
              status: 'cached',
              source: 'indexeddb',
              result: {
                paragraphs: exactCached.paragraphs,
                provider: exactCached.provider,
                model: exactCached.model,
              },
              cacheEntry: exactCached,
            });
            return;
          }

          const restored = findRestorableSharedTranslation(
            publishedTranslations,
            {
              glossaryFingerprint: termFingerprint,
              fingerprint: docMeta.fingerprint,
              pageNumber: translationPage,
              targetLanguage,
            },
          );
          if (restored) {
            const cacheEntry = cachedTranslationFromShared(restored);
            await finishOutcome({
              status: 'cached',
              source: 'course',
              result: {
                paragraphs: cacheEntry.paragraphs,
                provider: cacheEntry.provider,
                model: cacheEntry.model,
              },
              cacheEntry,
            });
            return;
          }
        }

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
        const outcome = await resolvePageTranslation({
          provider,
          cache: serviceRef.current!.cache,
          fingerprint: docMeta.fingerprint,
          request: {
            glossary,
            text: sourceText,
            sourceLanguage: 'auto',
            targetLanguage,
            pageNumber: translationPage,
          },
          signal: controller.signal,
          bypassCache: bypassRequested,
          publishedTranslations,
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
        await finishOutcome(outcome);
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
    publishCourseTranslation,
    rememberPublishedTranslation,
    publishedTranslations,
    glossary,
    termFingerprint,
  ]);

  const retranslate = () => {
    setParagraphSelection(null);
    const key = translationKey(translationPage, targetLanguage);
    bypassCacheRef.current.add(key);
    retryTokenRef.current += 1;
    setRetryToken(retryTokenRef.current);
    setCopied(false);
  };

  const retrySave = () => {
    const key = translationKey(translationPage, targetLanguage);
    const state = translationStatesRef.current[key];
    if (!state?.cacheEntry || state.persistence !== 'failed') return;
    const cacheEntry = state.cacheEntry;
    updateTranslationState(key, {
      ...state,
      persistence: 'saving',
      persistenceError: undefined,
    });
    void publishCourseTranslation(cacheEntry).then((publication) => {
      const latest = translationStatesRef.current[key];
      if (latest?.cacheEntry !== cacheEntry) return;
      if (publication.status === 'saved') {
        rememberPublishedTranslation(cacheEntry);
      }
      updateTranslationState(key, {
        ...latest,
        persistence: publication.status === 'failed' ? 'failed' : 'saved',
        persistenceError: publication.error,
      });
    });
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
    nextKnowledgeSettings: KnowledgeSettings,
  ) => {
    const translationChanged =
      JSON.stringify(settings) !== JSON.stringify(nextSettings);
    const ocrChanged =
      JSON.stringify(chatSettings) !== JSON.stringify(nextChatSettings);
    setSettings(nextSettings);
    setChatSettings(nextChatSettings);
    setKnowledgeSettings(nextKnowledgeSettings);
    saveReaderSettings(nextSettings);
    saveChatSettings(nextChatSettings);
    saveKnowledgeSettings(nextKnowledgeSettings);
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
  // rightMode is the user's intent; clamp it to what the current document
  // offers, so summary/mindmap never linger on a document without course
  // results (e.g. after importing a new PDF inside the reader).
  const activeMode =
    rightMode === 'summary' || rightMode === 'mindmap'
      ? courseContext?.digest
        ? rightMode
        : 'translation'
      : rightMode;
  const translationKeyCurrent = translationKey(translationPage, targetLanguage);
  const currentState = translationStates[translationKeyCurrent];
  const isReady =
    currentState?.status === 'complete' || currentState?.status === 'cached';
  const paragraphAlignment = useMemo(() => {
    const source = sourceParagraphs[translationPage];
    const alignment = alignParagraphs(source?.paragraphs ?? [], isReady ? currentState?.paragraphs ?? [] : []);
    // A text mismatch must not jump to fabricated coordinates. Disable a
    // target group unless all its source paragraphs have real TextLayer spans.
    alignment.targetToSource = alignment.targetToSource.map((group) =>
      group.every((index) => source?.mapped.includes(index)) ? group : []);
    alignment.sourceToTarget = alignment.sourceToTarget.map((group) =>
      group.filter((index) => alignment.targetToSource[index].length > 0));
    if (!alignment.targetToSource.some((group) => group.length)) alignment.mode = 'unavailable';
    return alignment;
  }, [sourceParagraphs, translationPage, isReady, currentState?.paragraphs]);
  const { activeSourceParagraphs, activeTargetParagraphs } = useMemo(() => {
    if (!paragraphSelection || paragraphSelection.page !== translationPage || paragraphSelection.language !== targetLanguage) {
      return { activeSourceParagraphs: [], activeTargetParagraphs: [] };
    }
    const { side, index } = paragraphSelection;
    const source = side === 'target' ? paragraphAlignment.targetToSource[index] ?? [] : [index];
    const target = side === 'source' ? paragraphAlignment.sourceToTarget[index] ?? [] : [index];
    return { activeSourceParagraphs: target.length ? source : [], activeTargetParagraphs: source.length ? target : [] };
  }, [paragraphSelection, translationPage, targetLanguage, paragraphAlignment]);
  const activateSourceParagraph = useCallback((pageNumber: number, index: number) => {
    setParagraphSelection({ page: pageNumber, language: targetLanguage, side: 'source', index });
    setPage(pageNumber);
    setTranslationPage(pageNumber);
    setRightMode('translation');
    setTranslationVisible(true);
  }, [targetLanguage]);
  const remoteProvider = usingRemoteProvider(settings);
  const remoteProviderHost = remoteProvider
    ? readerServiceHost(settings.baseUrl)
    : null;
  const translationProgress = countTranslated(
    translationStates,
    docMeta?.pageCount ?? 0,
    targetLanguage,
  );
  const translationProgressLabel = `已翻译 ${translationProgress.done} / 总页数 ${translationProgress.total}`;
  const statusBarItems = statusBarParts({
    page,
    pageCount: docMeta?.pageCount ?? 0,
    zoom,
    mode: activeMode,
    translated: translationProgress,
    cacheState: translationStates[translationKey(page, targetLanguage)],
  });
  const statusLabel = !docMeta
    ? '尚未导入 PDF'
    : currentState?.status === 'recognizing'
      ? `正在 OCR 识别第 ${translationPage} 页`
      : currentState?.status === 'translating'
        ? `正在翻译第 ${translationPage} 页`
        : currentState?.status === 'error'
          ? '翻译失败，可重试'
          : currentState?.persistence === 'saving'
            ? '正在保存译文…'
            : currentState?.persistence === 'failed'
              ? '译文已生成，保存到课程目录失败'
              : isReady
                ? currentState?.status === 'cached'
                  ? currentState.source === 'course'
                    ? '译文已从课程目录恢复'
                    : '译文来自缓存'
                  : '译文已完成'
                : '译文待加载';
  const translationDetailLabel =
    currentState?.source === 'course'
      ? `已从课程目录恢复${currentState.model ? ` · 原模型：${currentState.model}` : ''}`
      : currentState?.source === 'indexeddb'
        ? `已命中本机缓存${currentState.model ? ` · 原模型：${currentState.model}` : ''}`
        : docMeta?.scanDetected
          ? '扫描页图像仅在 OCR 时发送给已配置视觉模型'
          : remoteProvider
            ? `当前页文字将发送至 ${remoteProviderHost ?? '所配置服务'}`
            : '演示模式 · 不发送任何数据';

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
      termFingerprint,
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
          const outcome = await resolvePageTranslation({
            provider,
            cache: serviceRef.current!.cache,
            fingerprint: docMeta.fingerprint,
            request: {
              glossary,
              text: normalized.text,
              sourceLanguage: 'auto',
              targetLanguage,
              pageNumber: nextPage,
            },
            signal: controller.signal,
            publishedTranslations,
          });
          if (!controller.signal.aborted) {
            if (outcome.source !== 'course') {
              const publication = await publishCourseTranslation(
                outcome.cacheEntry,
              );
              if (publication.status === 'saved') {
                rememberPublishedTranslation(outcome.cacheEntry);
              }
            }
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
  }, [
    pdfDoc,
    docMeta,
    isReady,
    translationPage,
    targetLanguage,
    retryToken,
    publishCourseTranslation,
    rememberPublishedTranslation,
    publishedTranslations,
    glossary,
    termFingerprint,
  ]);

  const openSettings = (tab: SettingsTab = 'translation') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  return (
    <TooltipProvider>
      <main ref={readerRootRef} className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
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
                onChange={(event) => { setParagraphSelection(null); setTargetLanguage(event.target.value); }}
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
        {progressRecovery ? (
          <div role="alert" className="flex items-center gap-3 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900">
            <span>阅读进度恢复失败：无法读取本地存储。PDF 已正常打开。</span>
            <Button size="sm" variant="outline" disabled={recoveringProgress} onClick={() => void retryProgressRecovery()}>
              {recoveringProgress ? '正在恢复…' : '重试恢复进度'}
            </Button>
            <Button size="sm" variant="ghost" disabled={recoveringProgress} onClick={() => setProgressRecovery(null)}>忽略并继续阅读</Button>
          </div>
        ) : null}

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
                            translationStatus={
                              translationStates[
                                translationKey(pageNumber, targetLanguage)
                              ]?.status
                            }
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
                    style={{ overflowAnchor: 'none' }}
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
                                {renderedPages.has(pageNumber) && pageSizes[pageNumber - 1]?.ready ? (
                                  <PdfPageCanvas
                                    key={`${pageNumber}-${width}`}
                                    pdfDoc={pdfDoc}
                                    pageNumber={pageNumber}
                                    width={width}
                                    height={height}
                                    activeParagraphs={pageNumber === translationPage ? activeSourceParagraphs : []}
                                    revealRequest={pageNumber === translationPage && paragraphSelection?.side === 'target' ? paragraphSelection : null}
                                    onParagraphsReady={rememberSourceParagraphs}
                                    onParagraphActivate={activateSourceParagraph}
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center bg-white">
                                    <span className="text-xs text-slate-300">
                                      {pageSizes[pageNumber - 1]?.error ? <button type="button" onClick={() => void sizeLoaderRef.current?.load(pageNumber)}>页面尺寸加载失败，点击重试</button> : pageNumber}
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
                      value={activeMode}
                      onValueChange={(value) =>
                        setRightMode(value as ReaderRightModeName)
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
                            {activeMode === 'translation'
                              ? `第 ${translationPage} 页 · ${targetLanguage}${remoteProvider ? ' · 已连接翻译服务' : ' · 演示模式'}`
                              : activeMode === 'chat'
                                ? `第 ${translationPage} 页 · 文字与视觉上下文`
                                : `整份 PDF · 已保存到课程文件夹`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          {activeMode === 'translation' &&
                          translationProgress.total > 0 ? (
                            <span
                              className="translation-progress-chip"
                              aria-label={`翻译进度：已翻译 ${translationProgress.done} 页，共 ${translationProgress.total} 页`}
                            >
                              {translationProgressLabel}
                            </span>
                          ) : null}
                          {activeMode === 'translation' ? (
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
                                      {translationDetailLabel}
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
                                onRetrySave={retrySave}
                                onOpenSettings={() => openSettings(currentState?.errorMessage?.includes('OCR') ? 'chat' : 'translation')}
                                alignment={paragraphAlignment}
                                activeParagraphs={activeTargetParagraphs}
                                revealRequest={paragraphSelection?.side === 'source' ? paragraphSelection : null}
                                onParagraphActivate={(index) => setParagraphSelection({
                                  page: translationPage, language: targetLanguage, side: 'target', index,
                                })}
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
                          onNavigate={goToPage}
                          settings={chatSettings}
                          selectionQuestion={selectionQuestion}
                          onSelectionQuestionHandled={() => setSelectionQuestion(null)}
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

          {pdfDoc && docMeta && !suspended && !settingsOpen && !importOpen ? <SelectionToolbar
            glossary={glossary}
            key={docMeta.fingerprint}
            rootRef={documentStageRef}
            settings={settings}
            targetLanguage={targetLanguage}
            onExplain={(selection) => {
              goToPage(selection.pageNumber);
              setTranslationPage(selection.pageNumber);
              setTranslationVisible(true);
              setRightMode('chat');
              setSelectionQuestion({ id: Date.now(), fingerprint: docMeta.fingerprint,
                pageNumber: selection.pageNumber, text: selection.text });
            }}
          /> : null}
        </section>

        <footer className="status-bar" aria-label="阅读器状态栏">
          <div className="flex items-center gap-2">
            <span
              className={`size-1.5 rounded-full ${
                activeMode === 'chat'
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
              {statusLabel}
            </span>
          </div>
          <ReaderStatusFacts parts={statusBarItems} />
          <button type="button" className="rounded px-1 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-amber-600" onClick={() => setShortcutsOpen(true)}>快捷键说明</button>
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

        <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[480px]">
            <DialogHeader><DialogTitle>阅读快捷键</DialogTitle>
              <DialogDescription>输入框、下拉框和编辑器内不触发阅读快捷键；弹窗打开时暂停阅读快捷键。</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm">
              <dt>← / → · PageUp / PageDown</dt><dd>上一页 / 下一页</dd>
              <dt>Home / End</dt><dd>首页 / 末页</dd>
              <dt>+ / − / 0</dt><dd>放大 / 缩小 / 默认缩放</dd>
              <dt>Alt + 1 / 2 / 3 / 4</dt><dd>翻译 / 答疑 / 总结 / 脑图</dd>
              <dt>F · Ctrl + Shift + F</dt><dd>收起 / 展开右栏</dd>
              <dt>Esc</dt><dd>关闭弹窗或清除选区</dd>
            </dl>
            <DialogFooter><Button onClick={() => setShortcutsOpen(false)}>知道了</Button></DialogFooter>
          </DialogContent>
        </Dialog>

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
                if (file) void handleFile(file, undefined, 'dialog');
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
            knowledgeSettings={knowledgeSettings}
            onClose={() => setSettingsOpen(false)}
            onSave={applySettings}
          />
        ) : null}
      </main>
    </TooltipProvider>
  );
}

function DesktopHome() {
  const [view, setView] = useState<'courses' | 'reader'>('courses');
  const [readerFile, setReaderFile] = useState<File | null>(null);
  const [readerContext, setReaderContext] =
    useState<CourseReaderContext | null>(null);

  return (
    <>
      {/* The reader stays mounted behind the course library, so a PDF imported
          into the reader (and its in-session translations) survives the round
          trip; hidden + inert keeps it out of layout, focus and the a11y tree. */}
      <div hidden={view !== 'reader'} inert={view !== 'reader'}>
        <PdfReader
          initialFile={readerFile}
          courseContext={readerContext}
          onOpenCourses={() => setView('courses')}
          suspended={view !== 'reader'}
          onStandaloneImport={() => setReaderContext(null)}
        />
      </div>
      {view === 'courses' ? (
        <TooltipProvider>
          <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#f5f7fa]">
            <header className="flex h-15 shrink-0 items-center justify-between border-b border-white/10 bg-[#243a59] px-5 text-white">
              <div className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-400 to-indigo-500 shadow-sm">
                  <BookOpen className="size-4" />
                </span>
                <span className="text-sm font-semibold tracking-wide">
                  页语
                </span>
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
      ) : null}
    </>
  );
}

export default function Home() {
  if (isSharedView()) return <SharedCourseViewer />;
  return <DesktopHome />;
}
