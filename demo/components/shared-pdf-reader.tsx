'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  Minus,
  Network,
  Plus,
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

export function SharedPdfReader({
  file,
  fileKey,
  digest,
  hasSummary,
  hasMindmap,
  initialPage = 1,
  onBack,
}: {
  file: File;
  fileKey: string;
  digest?: DocumentDigest;
  hasSummary: boolean;
  hasMindmap: boolean;
  initialPage?: number;
  onBack: () => void;
}) {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [page, setPage] = useState(initialPage);
  const [zoom, setZoom] = useState(95);
  const [stageWidth, setStageWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(
    () => new Set([initialPage]),
  );
  const [panel, setPanel] = useState<'summary' | 'mindmap'>(
    hasSummary ? 'summary' : 'mindmap',
  );
  const stageRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLElement>());

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setError(null);
    setPdfDoc(null);
    setPage(initialPage);
    setVisiblePages(new Set([initialPage]));
    void (async () => {
      try {
        const buffer = await file.arrayBuffer();
        const pdfjs = await loadPdfjs();
        loaded = await pdfjs.getDocument({
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
        if (cancelled) return;
        setPageSizes(sizes);
        setPage(Math.min(Math.max(initialPage, 1), loaded.numPages));
        setVisiblePages(
          new Set([Math.min(Math.max(initialPage, 1), loaded.numPages)]),
        );
        setPdfDoc(loaded);
      } catch {
        if (!cancelled)
          setError('PDF 文件暂时无法解析，可能正在更新或文件已损坏。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, fileKey, initialPage]);

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
  }, [pdfDoc, pageSizes.length]);

  const goToPage = useCallback(
    (next: number) => {
      const target = Math.min(Math.max(next, 1), pdfDoc?.numPages ?? 1);
      setPage(target);
      setVisiblePages((previous) => new Set([...previous, target]));
      requestAnimationFrame(() =>
        pageRefs.current
          .get(target)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    },
    [pdfDoc?.numPages],
  );

  const updatePageFromScroll = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const stageTop = stage.getBoundingClientRect().top;
    let closest = page;
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
    if (closest !== page) setPage(closest);
  };

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
              局域网共享 · 只读
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
            onClick={() => setZoom((value) => Math.max(50, value - 10))}
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
            onClick={() => setZoom((value) => Math.min(200, value + 10))}
            disabled={zoom >= 200}
          >
            <Plus />
          </Button>
        </div>
      </header>

      <section className="relative min-h-0 flex-1">
        <div className="flex h-full min-h-0">
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
                          key={`${number}-${Math.round(width)}`}
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
                只读查看，不会触发生成或上传。
              </p>
            </div>
            {digest && (hasSummary || hasMindmap) ? (
              <Tabs
                value={panel}
                onValueChange={(value) =>
                  setPanel(value as 'summary' | 'mindmap')
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
                </TabsList>
                {hasSummary ? (
                  <TabsContent
                    value="summary"
                    className="min-h-0 overflow-y-auto data-[hidden]:hidden"
                  >
                    <DocumentSummaryPanel
                      digest={digest}
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
                      knowledge={documentKnowledge(digest)}
                      onOpenSource={(_, sourcePage) => goToPage(sourcePage)}
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
                  主电脑尚未生成这份 PDF 的总结或脑图。查看端不会发起生成。
                </p>
              </div>
            )}
          </aside>
        </div>
      </section>
      <footer className="status-bar">
        <span>局域网共享 · 只读 · {file.name}</span>
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
