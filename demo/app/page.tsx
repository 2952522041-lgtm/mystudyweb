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
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
  Settings,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { pickCurrentPage, measurePageRects } from '@/lib/current-page';
import { loadPdfjs, type PDFDocumentProxy, type RenderTask } from '@/lib/pdfjs';
import { itemsFromPdfJs, normalizePage, pageHasText } from '@/lib/pdf-text';
import {
  computeFileFingerprint,
  createReaderService,
  createProviderForSettings,
  DEFAULT_SETTINGS,
  loadReaderSettings,
  resolvePageTranslation,
  saveReaderSettings,
  usingRemoteProvider,
  type ReaderSettings,
} from '@/lib/reader-cache';
import { clampPage, fillColumnPageWidth, stepZoom } from '@/lib/reader-model';
import {
  describeTranslationError,
  TranslationError,
  type TranslationErrorCode,
} from '@/lib/translation';

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
  scanUnsupported: boolean;
  restoredPage: number | null;
}

interface PageTranslationState {
  status: 'translating' | 'complete' | 'cached' | 'error';
  paragraphs?: string[];
  errorCode?: TranslationErrorCode;
  errorMessage?: string;
}

function describeFailure(error: unknown): { code: TranslationErrorCode; message: string } {
  if (error instanceof TranslationError) {
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
      const viewport = pdfPage.getViewport({ scale: (width * dpr) / base.width });
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
      <canvas ref={canvasRef} className="block bg-white" aria-label={`第 ${pageNumber} 页内容`} />
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
        <h2 className="text-base font-semibold text-slate-800">导入一份外文 PDF 开始阅读</h2>
        <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">
          左侧阅读原文，右侧自动显示当前页的译文。支持文字型 PDF，文件只在本地解析。
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
  if (!state || state.status === 'translating') {
    return (
      <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
        <span className="mb-5 flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <LoaderCircle className="size-5 animate-spin" />
        </span>
        <h2 className="text-sm font-semibold text-slate-800">正在翻译第 {page} 页</h2>
        <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
          已提取当前页文字，正在生成{targetLanguage}译文…
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
        <h2 className="text-sm font-semibold text-slate-800">第 {page} 页翻译失败</h2>
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
        <p key={paragraph.slice(0, 48) + String(paragraph.length)}>{paragraph}</p>
      ))}
      {remoteProvider ? null : (
        <p className="mt-10 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-xs text-slate-500">
          当前显示的是内置演示译文。在右上角“翻译设置”中配置 OpenAI 兼容服务后，这里将显示真实译文。
        </p>
      )}
    </article>
  );
}

export default function Home() {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [docMeta, setDocMeta] = useState<DocumentMeta | null>(null);
  const [pageSizes, setPageSizes] = useState<PageView[]>([]);
  const [page, setPage] = useState(1);
  const [translationPage, setTranslationPage] = useState(1);
  const [zoom, setZoom] = useState(95);
  const [targetLanguage, setTargetLanguage] = useState<string>('简体中文');
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [draftSettings, setDraftSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [translationStates, setTranslationStates] = useState<Record<string, PageTranslationState>>({});
  const [renderedPages, setRenderedPages] = useState<Set<number>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [translationVisible, setTranslationVisible] = useState(true);
  const [stageWidth, setStageWidth] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const documentStageRef = useRef<HTMLDivElement>(null);
  const pageElementsRef = useRef(new Map<number, HTMLElement>());
  const activeThumbnailRef = useRef<HTMLButtonElement>(null);
  const scrollTargetRef = useRef<number | null>(null);
  const positionedRef = useRef(false);
  const serviceRef = useRef<ReturnType<typeof createReaderService> | null>(null);
  const settingsRef = useRef(settings);
  const bypassCacheRef = useRef(new Set<string>());
  const retryTokenRef = useRef(0);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const translationKey = useCallback(
    (pageNumber: number, language: string) => `${pageNumber}:${language}`,
    [],
  );

  const translationStatesRef = useRef<Record<string, PageTranslationState>>({});
  const updateTranslationState = useCallback(
    (key: string, state: PageTranslationState) => {
      translationStatesRef.current = { ...translationStatesRef.current, [key]: state };
      setTranslationStates(translationStatesRef.current);
    },
    [],
  );

  useEffect(() => {
    serviceRef.current = createReaderService();
    const timer = setTimeout(() => {
      const loaded = loadReaderSettings();
      setSettings(loaded);
      setDraftSettings(loaded);
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
        currentPageWidth > 0 ? (size.height / size.width) * currentPageWidth : 0,
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
            const pageNumber = Number((entry.target as HTMLElement).dataset.page);
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
    for (const element of pageElementsRef.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [pdfDoc, docMeta, pageSizes.length]);

  const goToPage = useCallback(
    (nextPage: number) => {
      const targetPage = clampPage(nextPage, docMeta?.pageCount ?? 1);
      setCopied(false);
      setPage(targetPage);
      scrollTargetRef.current = targetPage;
      requestAnimationFrame(() => {
        pageElementsRef.current.get(targetPage)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    if (!pdfDoc || docMeta?.scanUnsupported) return;
    const timer = setTimeout(() => setTranslationPage(page), TRANSLATION_STABLE_DELAY);
    return () => clearTimeout(timer);
  }, [page, pdfDoc, docMeta?.scanUnsupported]);

  // Current page from scroll geometry, per the largest-visible-area rule.
  const updatePageFromScroll = useCallback(() => {
    const stage = documentStageRef.current;
    if (!stage || pageHeightsPx.length === 0 || pageHeightsPx.some((height) => height === 0)) return;
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
    async (file: File) => {
      setImporting(true);
      setImportError(null);
      try {
        const buffer = await file.arrayBuffer();
        const fingerprint = await computeFileFingerprint(buffer);
        const pdfjs = await loadPdfjs();
        // getDocument may transfer the buffer to the worker, so hand it a copy.
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;

        const sizes: PageView[] = [];
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          const pdfPage = await doc.getPage(pageNumber);
          const viewport = pdfPage.getViewport({ scale: 1 });
          sizes.push({ width: viewport.width, height: viewport.height });
        }

        // Scanned-PDF rule: sample the first pages; no text layer means the
        // MVP cannot translate this document.
        let scanUnsupported = true;
        for (let pageNumber = 1; pageNumber <= Math.min(3, doc.numPages); pageNumber += 1) {
          const pdfPage = await doc.getPage(pageNumber);
          const viewport = pdfPage.getViewport({ scale: 1 });
          const content = await pdfPage.getTextContent();
          if (
            pageHasText(
              itemsFromPdfJs(
                content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>,
                viewport.height,
              ),
            )
          ) {
            scanUnsupported = false;
            break;
          }
        }

        const restored = await serviceRef.current?.progress.load(fingerprint);
        positionedRef.current = false;
        setRenderedPages(new Set());
        setTranslationStates({});
        translationStatesRef.current = {};
        pageElementsRef.current.clear();
        setPdfDoc(doc);
        setPageSizes(sizes);
        setDocMeta({
          fingerprint,
          fileName: file.name,
          pageCount: doc.numPages,
          scanUnsupported,
          restoredPage: restored && restored.lastPage > 1 ? restored.lastPage : null,
        });
        setZoom(restored?.zoom ?? 95);
        setTargetLanguage(restored?.targetLanguage ?? '简体中文');
        setPage(restored?.lastPage ?? 1);
        setTranslationPage(restored?.lastPage ?? 1);
        setImportOpen(false);
      } catch {
        setImportError('无法解析该 PDF 文件，文件可能已损坏或已加密。');
      } finally {
        setImporting(false);
      }
    },
    [],
  );

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

  // Per-page translation pipeline: extract, normalize, cache, translate.
  useEffect(() => {
    if (!pdfDoc || !docMeta || docMeta.scanUnsupported) return;
    const key = translationKey(translationPage, targetLanguage);
    const existing = translationStates[key];
    if (existing && (existing.status === 'complete' || existing.status === 'cached')) return;

    const controller = new AbortController();
    bypassCacheRef.current.delete(key);
    let cancelled = false;
    updateTranslationState(key, { status: 'translating' });

    const runTranslation = async () => {
      try {
        const pdfPage = await pdfDoc.getPage(translationPage);
        const viewport = pdfPage.getViewport({ scale: 1 });
        const content = await pdfPage.getTextContent();
        if (cancelled) return;
        const normalized = normalizePage(
          itemsFromPdfJs(
            content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>,
            viewport.height,
          ),
        );
        if (normalized.text.trim().length === 0) {
          updateTranslationState(key, {
            status: 'error',
            errorCode: 'empty_text',
            errorMessage: describeTranslationError('empty_text'),
          });
          return;
        }
        const provider = createProviderForSettings(settingsRef.current);
        const outcome = await resolvePageTranslation({
          provider,
          cache: serviceRef.current!.cache,
          fingerprint: docMeta.fingerprint,
          request: {
            text: normalized.text,
            sourceLanguage: 'auto',
            targetLanguage,
            pageNumber: translationPage,
          },
          signal: controller.signal,
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
  }, [pdfDoc, docMeta, translationPage, targetLanguage, retryToken, translationKey, translationStates, updateTranslationState]);

  const retranslate = () => {
    const key = translationKey(translationPage, targetLanguage);
    bypassCacheRef.current.add(key);
    retryTokenRef.current += 1;
    setRetryToken(retryTokenRef.current);
    setCopied(false);
  };

  const copyTranslation = async () => {
    const state = translationStates[translationKey(translationPage, targetLanguage)];
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

  const applySettings = () => {
    setSettings(draftSettings);
    saveReaderSettings(draftSettings);
    setSettingsOpen(false);
    // Provider/model changes alter the cache key, so refresh the current page.
    retryTokenRef.current += 1;
    setRetryToken(retryTokenRef.current);
  };

  const pageNumbers = Array.from({ length: docMeta?.pageCount ?? 0 }, (_, index) => index + 1);
  const translationKeyCurrent = translationKey(translationPage, targetLanguage);
  const currentState = translationStates[translationKeyCurrent];
  const isReady = currentState?.status === 'complete' || currentState?.status === 'cached';
  const remoteProvider = usingRemoteProvider(settings);
  const statusLabel = !docMeta
    ? '尚未导入 PDF'
    : docMeta.scanUnsupported
      ? '未检测到文字层，无法翻译'
      : currentState?.status === 'translating'
        ? `正在翻译第 ${translationPage} 页`
        : currentState?.status === 'error'
          ? '翻译失败，可重试'
          : isReady
            ? currentState?.status === 'cached'
              ? '译文来自缓存'
              : '译文已完成'
            : '译文待加载';

  return (
    <TooltipProvider>
      <main className="flex h-screen min-h-[680px] flex-col overflow-hidden bg-background text-foreground">
        <header className="app-toolbar">
          <div className="flex min-w-0 items-center gap-3">
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
            <IconButton label="上一页" onClick={() => goToPage(page - 1)} disabled={!pdfDoc || page === 1}>
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
              <span className="w-11 text-center text-xs tabular-nums text-slate-600">{zoom}%</span>
              <IconButton
                label="放大"
                onClick={() => setZoom(stepZoom(zoom, 1))}
                disabled={zoom === 150}
              >
                <Plus />
              </IconButton>
            </div>
            <IconButton label="翻译设置" onClick={() => setSettingsOpen(true)}>
              <Settings />
            </IconButton>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <FileText />
              {pdfDoc ? '更换 PDF' : '导入 PDF'}
            </Button>
          </div>
        </header>

        <section className="relative min-h-0 flex-1">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize={translationVisible ? '55%' : '100%'} minSize="38%">
              <section className="reader-pane" aria-label="PDF 原文阅读区">
                <div className="pane-heading">
                  <div>
                    <p className="pane-eyebrow">原文</p>
                    <p className="pane-meta">
                      {docMeta
                        ? `${docMeta.pageCount} 页 · ${docMeta.scanUnsupported ? '未检测到文字层' : '文字型 PDF'}`
                        : '等待导入'}
                    </p>
                  </div>
                  {docMeta ? (
                    <span className="status-chip">第 {page} 页正在阅读</span>
                  ) : null}
                </div>
                <div className="reader-workspace">
                  {docMeta ? (
                    <nav className="thumbnail-sidebar" aria-label="PDF 页面预览">
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
                            activeRef={pageNumber === page ? activeThumbnailRef : undefined}
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
                            pageHeightsPx[pageNumber - 1] || (width > 0 ? width / 0.707 : 800);
                          return (
                            <article
                              key={pageNumber}
                              ref={(node) => {
                                if (node) pageElementsRef.current.set(pageNumber, node);
                                else pageElementsRef.current.delete(pageNumber);
                              }}
                              data-page={pageNumber}
                              className={`pdf-page ${pageNumber === page ? 'pdf-page-current' : ''}`}
                              style={width > 0 ? { width: `${width}px` } : undefined}
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
                                    <span className="text-xs text-slate-300">{pageNumber}</span>
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
                  <aside className="translation-pane" aria-label="当前页翻译区">
                    <div className="pane-heading border-b border-slate-200/80">
                      <div>
                        <p className="pane-eyebrow">译文</p>
                        <p className="pane-meta">
                          第 {translationPage} 页 · {targetLanguage}
                          {remoteProvider ? ' · 已连接翻译服务' : ' · 演示模式'}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <IconButton
                          label="复制译文"
                          onClick={copyTranslation}
                          disabled={!isReady}
                        >
                          {copied ? <Check className="text-emerald-600" /> : <Copy />}
                        </IconButton>
                        <IconButton
                          label="重新翻译"
                          onClick={retranslate}
                          disabled={!pdfDoc || docMeta?.scanUnsupported}
                        >
                          <RotateCcw />
                        </IconButton>
                        <IconButton label="收起译文" onClick={() => setTranslationVisible(false)}>
                          <PanelRightClose />
                        </IconButton>
                      </div>
                    </div>

                    <div className="translation-scroll">
                      {docMeta?.scanUnsupported ? (
                        <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
                          <span className="mb-5 flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                            <TriangleAlert className="size-5" />
                          </span>
                          <h2 className="text-sm font-semibold text-slate-800">
                            暂不支持扫描版 PDF
                          </h2>
                          <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
                            前 3 页均未检测到可提取的文字层。当前版本无法对扫描图像翻译，请改用文字型 PDF。
                          </p>
                        </div>
                      ) : pdfDoc ? (
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
                                  {remoteProvider
                                    ? `当前页文字将发送至 ${new URL(settings.baseUrl).host}`
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
                          <h2 className="text-sm font-semibold text-slate-800">译文将显示在这里</h2>
                          <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
                            导入 PDF 后，右侧会自动跟随左侧正在阅读的页面。
                          </p>
                        </div>
                      )}
                    </div>
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
              展开译文
            </Button>
          ) : null}
        </section>

        <footer className="status-bar">
          <div className="flex items-center gap-2">
            <span
              className={`size-1.5 rounded-full ${
                currentState?.status === 'error'
                  ? 'bg-rose-500'
                  : currentState?.status === 'translating'
                    ? 'animate-pulse bg-amber-500'
                    : 'bg-emerald-500'
              }`}
            />
            <span>{statusLabel}</span>
          </div>
          <div className="flex items-center gap-4">
            {docMeta?.restoredPage ? (
              <span>已恢复上次阅读进度（第 {docMeta.restoredPage} 页）</span>
            ) : renderedPages.has(page + 1) ? (
              <span>第 {page + 1} 页已预加载</span>
            ) : null}
            <span className="hidden text-slate-300 sm:inline">PDF 与译文仅保存在本地</span>
          </div>
        </footer>

        <Dialog open={importOpen} onOpenChange={setImportOpen}>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle className="text-lg">导入文字型 PDF</DialogTitle>
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
              <span className="mt-1 text-xs text-slate-500">支持文字型 PDF，扫描版暂不支持</span>
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
                配置真实翻译服务后，只有当前页的文字会发送给该服务；PDF 文件、阅读进度和译文缓存都保存在本地。
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setImportOpen(false)} disabled={importing}>
                取消
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle className="text-lg">翻译设置</DialogTitle>
              <DialogDescription>
                默认使用内置演示译文。配置 OpenAI 兼容服务后即可翻译真实内容。
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="setting-provider" className="text-xs font-medium text-slate-700">
                  翻译服务
                </label>
                <NativeSelect
                  id="setting-provider"
                  value={draftSettings.providerMode}
                  onChange={(event) =>
                    setDraftSettings((previous) => ({
                      ...previous,
                      providerMode: event.target.value as ReaderSettings['providerMode'],
                    }))
                  }
                >
                  <NativeSelectOption value="mock">内置演示（不联网）</NativeSelectOption>
                  <NativeSelectOption value="openai-compatible">
                    OpenAI 兼容接口
                  </NativeSelectOption>
                </NativeSelect>
              </div>

              {draftSettings.providerMode === 'openai-compatible' ? (
                <>
                  <div className="space-y-1.5">
                    <label htmlFor="setting-base-url" className="text-xs font-medium text-slate-700">
                      接口地址
                    </label>
                    <Input
                      id="setting-base-url"
                      value={draftSettings.baseUrl}
                      onChange={(event) =>
                        setDraftSettings((previous) => ({ ...previous, baseUrl: event.target.value }))
                      }
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="setting-api-key" className="text-xs font-medium text-slate-700">
                      API Key
                    </label>
                    <Input
                      id="setting-api-key"
                      type="password"
                      value={draftSettings.apiKey}
                      onChange={(event) =>
                        setDraftSettings((previous) => ({ ...previous, apiKey: event.target.value }))
                      }
                      placeholder="sk-…"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="setting-model" className="text-xs font-medium text-slate-700">
                      模型
                    </label>
                    <Input
                      id="setting-model"
                      value={draftSettings.model}
                      onChange={(event) =>
                        setDraftSettings((previous) => ({ ...previous, model: event.target.value }))
                      }
                      placeholder="gpt-4o-mini"
                    />
                  </div>
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                    API Key 仅保存在本机浏览器中，请求由浏览器直接发往接口地址；请确保该地址允许跨域访问。
                  </p>
                </>
              ) : null}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setSettingsOpen(false)}>
                取消
              </Button>
              <Button onClick={applySettings}>保存设置</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </TooltipProvider>
  );
}
