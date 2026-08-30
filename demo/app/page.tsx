'use client';

import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clipboard,
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
  ShieldCheck,
  Sparkles,
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
import {
  clampPage,
  getTranslation,
  PAGE_COUNT,
  stepZoom,
  translationCopy,
  type TranslationStatus,
} from '@/lib/reader-model';

const sourceParagraphs = [
  'The process of learning is not always visible from the outside. It happens in small moments—when a difficult idea begins to make sense, when two concepts suddenly connect, or when a question becomes clearer.',
  'Good learning environments make space for this process. They reduce unnecessary friction and keep the learner close to the material.',
  'Reading in another language adds a second layer of effort. A helpful translation should support the reader without pulling them away from the original text.',
];

const languageLabels: Record<string, string> = {
  '简体中文': '简体中文',
  '繁體中文': '繁體中文',
  日本語: '日语',
  한국어: '韩语',
};

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

function PaperPage({
  page,
  active,
  zoom,
}: {
  page: number;
  active: boolean;
  zoom: number;
}) {
  return (
    <article
      className={`paper-page ${active ? 'paper-page-active' : ''}`}
      aria-label={`PDF 第 ${page} 页${active ? '，当前页' : ''}`}
      style={{ maxWidth: `${Math.round((660 * zoom) / 95)}px` }}
    >
      <div className="mb-10 flex items-start justify-between border-b border-slate-200 pb-4">
        <div>
          <p className="font-serif text-[10px] uppercase tracking-[0.24em] text-slate-400">
            Chapter {page < 7 ? 2 : 3}
          </p>
          <h2 className="mt-2 font-serif text-2xl font-semibold text-slate-800">
            {page === 4
              ? 'Learning as a continuous process'
              : page < 4
                ? 'Building a stronger foundation'
                : 'Feedback and deliberate practice'}
          </h2>
        </div>
        <span className="font-serif text-xs text-slate-400">{page}</span>
      </div>
      <div className="space-y-4 font-serif text-[15px] leading-7 text-slate-700">
        {sourceParagraphs.slice(0, 2).map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <blockquote className="my-8 border-l-2 border-amber-500 pl-5 italic text-slate-600">
          “Understanding grows through attention, comparison, and return.”
        </blockquote>
        <p>{sourceParagraphs[2]}</p>
      </div>
    </article>
  );
}

function TranslationBody({
  page,
  status,
  onRetry,
}: {
  page: number;
  status: TranslationStatus;
  onRetry: () => void;
}) {
  const translation = getTranslation(page);

  if (status === 'translating') {
    return (
      <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
        <span className="mb-5 flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <LoaderCircle className="size-5 animate-spin" />
        </span>
        <h2 className="text-sm font-semibold text-slate-800">正在翻译第 {page} 页</h2>
        <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
          已提取当前页文字，正在生成{languageLabels['简体中文']}译文…
        </p>
        <div className="mt-7 w-full max-w-sm space-y-3" aria-hidden="true">
          <span className="block h-3 w-4/5 animate-pulse rounded bg-slate-200" />
          <span className="block h-3 w-full animate-pulse rounded bg-slate-100" />
          <span className="block h-3 w-11/12 animate-pulse rounded bg-slate-100" />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
        <span className="mb-5 flex size-11 items-center justify-center rounded-full bg-rose-100 text-rose-700">
          <CircleAlert className="size-5" />
        </span>
        <h2 className="text-sm font-semibold text-slate-800">第 {page} 页翻译失败</h2>
        <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
          模拟网络连接中断。原文和其他已缓存页面不受影响。
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
      <h1>{translation.title}</h1>
      {translation.paragraphs.map((paragraph, index) => (
        <div key={paragraph}>
          <p>{paragraph}</p>
          {index === 1 && translation.quote ? (
            <blockquote>{translation.quote}</blockquote>
          ) : null}
        </div>
      ))}
    </article>
  );
}

export default function Home() {
  const [page, setPage] = useState(4);
  const [pageCount, setPageCount] = useState(PAGE_COUNT);
  const [zoom, setZoom] = useState(95);
  const [targetLanguage, setTargetLanguage] = useState('简体中文');
  const [translationStatus, setTranslationStatus] =
    useState<TranslationStatus>('cached');
  const [cachedKeys, setCachedKeys] = useState(
    () => new Set(['1-简体中文', '2-简体中文', '3-简体中文', '4-简体中文']),
  );
  const [retriedErrorPage, setRetriedErrorPage] = useState(false);
  const [translationVisible, setTranslationVisible] = useState(true);
  const [copied, setCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fileName, setFileName] = useState('Learning How to Learn.pdf');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const key = `${page}-${targetLanguage}`;
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);

    if (cachedKeys.has(key)) {
      statusTimerRef.current = setTimeout(() => setTranslationStatus('cached'), 0);
      return () => {
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      };
    }

    const startTimer = setTimeout(() => setTranslationStatus('translating'), 0);
    statusTimerRef.current = setTimeout(() => {
      if (page === 8 && !retriedErrorPage) {
        setTranslationStatus('error');
        return;
      }
      setCachedKeys((current) => new Set(current).add(key));
      setTranslationStatus('complete');
    }, 780);

    return () => {
      clearTimeout(startTimer);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, [cachedKeys, page, retriedErrorPage, targetLanguage]);

  const goToPage = (nextPage: number) => {
    setCopied(false);
    setPage(clampPage(nextPage, pageCount));
  };

  const retranslate = () => {
    const key = `${page}-${targetLanguage}`;
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    if (page === 8) setRetriedErrorPage(true);
    setTranslationStatus('translating');
    statusTimerRef.current = setTimeout(() => {
      setCachedKeys((current) => new Set(current).add(key));
      setTranslationStatus('complete');
    }, 900);
  };

  const copyTranslation = async () => {
    try {
      await navigator.clipboard.writeText(translationCopy(getTranslation(page)));
    } catch {
      // Clipboard access may be unavailable in embedded previews; the visual flow still completes.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const finishImport = (name = 'Designing for Learning.pdf') => {
    setImporting(true);
    setTimeout(() => {
      setFileName(name);
      setPageCount(name === 'Designing for Learning.pdf' ? 18 : 12);
      setPage(1);
      setImporting(false);
      setImportOpen(false);
    }, 850);
  };

  const visiblePages = Array.from(
    new Set([page - 1, page, page + 1].filter((item) => item >= 1 && item <= pageCount)),
  );
  const isReady = translationStatus === 'cached' || translationStatus === 'complete';

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
              <p className="truncate text-sm font-medium text-slate-700">{fileName}</p>
            </div>
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
            <IconButton label="上一页" onClick={() => goToPage(page - 1)} disabled={page === 1}>
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
              <span className="pr-1">{pageCount}</span>
            </label>
            <IconButton
              label="下一页"
              onClick={() => goToPage(page + 1)}
              disabled={page === pageCount}
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
                <NativeSelectOption value="简体中文">简体中文</NativeSelectOption>
                <NativeSelectOption value="繁體中文">繁體中文</NativeSelectOption>
                <NativeSelectOption value="日本語">日本語</NativeSelectOption>
                <NativeSelectOption value="한국어">한국어</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="hidden items-center rounded-lg border border-slate-200 bg-white p-1 sm:flex">
              <IconButton label="缩小" onClick={() => setZoom(stepZoom(zoom, -1))} disabled={zoom === 75}>
                <Minus />
              </IconButton>
              <span className="w-11 text-center text-xs tabular-nums text-slate-600">{zoom}%</span>
              <IconButton label="放大" onClick={() => setZoom(stepZoom(zoom, 1))} disabled={zoom === 150}>
                <Plus />
              </IconButton>
            </div>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <FileText />
              更换 PDF
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
                    <p className="pane-meta">英文 · 文字型 PDF</p>
                  </div>
                  <span className="status-chip">第 {page} 页正在阅读</span>
                </div>
                <div className="document-scroll">
                  {visiblePages.map((visiblePage) => (
                    <PaperPage
                      key={visiblePage}
                      page={visiblePage}
                      active={visiblePage === page}
                      zoom={zoom}
                    />
                  ))}
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
                          第 {page} 页 · {targetLanguage}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <IconButton label="复制译文" onClick={copyTranslation} disabled={!isReady}>
                          {copied ? <Check className="text-emerald-600" /> : <Copy />}
                        </IconButton>
                        <IconButton label="重新翻译" onClick={retranslate}>
                          <RotateCcw />
                        </IconButton>
                        <IconButton label="收起译文" onClick={() => setTranslationVisible(false)}>
                          <PanelRightClose />
                        </IconButton>
                      </div>
                    </div>

                    <div className="translation-scroll">
                      {isReady ? (
                        <div className="translation-status">
                          <span className="flex size-7 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                            <Sparkles className="size-3.5" />
                          </span>
                          <div>
                            <p className="text-xs font-medium text-slate-700">
                              {copied ? '译文已复制' : '已完成翻译'}
                            </p>
                            <p className="mt-0.5 text-[11px] text-slate-400">
                              {translationStatus === 'cached' ? '来自本地缓存' : '刚刚完成'} · 模拟数据
                            </p>
                          </div>
                        </div>
                      ) : null}
                      <TranslationBody page={page} status={translationStatus} onRetry={retranslate} />
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
                translationStatus === 'error'
                  ? 'bg-rose-500'
                  : translationStatus === 'translating'
                    ? 'animate-pulse bg-amber-500'
                    : 'bg-emerald-500'
              }`}
            />
            <span>
              {translationStatus === 'translating'
                ? `正在翻译第 ${page} 页`
                : translationStatus === 'error'
                  ? '翻译失败，可重试'
                  : '译文已缓存'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span>{page < pageCount ? `第 ${page + 1} 页已预加载` : '已到文档末尾'}</span>
            <span className="hidden text-slate-300 sm:inline">PDF 内容仅保存在本地</span>
          </div>
        </footer>

        <Dialog open={importOpen} onOpenChange={setImportOpen}>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle className="text-lg">导入文字型 PDF</DialogTitle>
              <DialogDescription>
                Demo 会模拟文件解析、页码恢复与第一页翻译，不会上传或读取实际内容。
              </DialogDescription>
            </DialogHeader>

            <button
              className="group mt-2 flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-6 text-center transition hover:border-amber-400 hover:bg-amber-50/50 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <span className="mb-4 flex size-11 items-center justify-center rounded-full bg-white text-slate-600 shadow-sm ring-1 ring-slate-200 transition group-hover:text-amber-700">
                <FileUp className="size-5" />
              </span>
              <span className="text-sm font-semibold text-slate-800">选择本地 PDF 文件</span>
              <span className="mt-1 text-xs text-slate-500">支持文字型 PDF，最大 100 MB</span>
            </button>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) finishImport(file.name);
              }}
            />

            <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-3">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              <p className="text-[11px] leading-5 text-slate-500">
                正式产品只会把当前页文字发送给翻译服务；PDF 文件、阅读进度和译文缓存默认保存在本地。
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setImportOpen(false)} disabled={importing}>
                取消
              </Button>
              <Button onClick={() => finishImport()} disabled={importing}>
                {importing ? <LoaderCircle className="animate-spin" /> : <Clipboard />}
                {importing ? '正在解析…' : '打开演示文档'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </TooltipProvider>
  );
}
