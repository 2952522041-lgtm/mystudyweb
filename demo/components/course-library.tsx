'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  Clock3,
  FilePlus2,
  FileText,
  Folder,
  FolderCheck,
  FolderPlus,
  GitMerge,
  LibraryBig,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';

import { CourseImportDialog } from '@/components/course-import-dialog';
import { KnowledgeMindmap } from '@/components/knowledge-mindmap';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BrowserDirectoryStorage } from '@/lib/course-storage/browser-directory-storage';
import {
  loadRecentCourses,
  saveRecentCourse,
  type RecentCourse,
} from '@/lib/course-storage/recent-courses';
import type {
  CourseBundle,
  DirectoryPickerWindow,
  DocumentDigest,
  DocumentRecord,
  ImportOptions,
} from '@/lib/course-storage/types';
import { extractDocumentDigest } from '@/lib/knowledge/document-digest';

export interface CourseReaderContext {
  courseName: string;
  document: DocumentRecord;
  digest?: DocumentDigest;
  initialPage?: number;
  onBack: () => void;
}

interface CourseEntry {
  recent: RecentCourse;
  storage: BrowserDirectoryStorage;
  bundle: CourseBundle | null;
  permission: 'granted' | 'prompt' | 'denied' | 'error';
}

function permissionLabel(permission: CourseEntry['permission']): string {
  if (permission === 'granted') return '已连接';
  if (permission === 'prompt') return '需要重新授权';
  if (permission === 'denied') return '权限已拒绝';
  return '文件夹异常';
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function Metric({
  icon,
  value,
  label,
  tone = 'blue',
}: {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  tone?: 'blue' | 'green' | 'violet' | 'amber';
}) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700',
    green: 'bg-emerald-50 text-emerald-700',
    violet: 'bg-violet-50 text-violet-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
      <span
        className={`flex size-9 items-center justify-center rounded-xl [&_svg]:size-4 ${tones[tone]}`}
      >
        {icon}
      </span>
      <span>
        <span className="block text-lg font-bold leading-none text-slate-800">
          {value}
        </span>
        <span className="mt-1.5 block text-[11px] text-slate-500">{label}</span>
      </span>
    </div>
  );
}

export function CourseLibrary({
  onOpenDocument,
}: {
  onOpenDocument: (file: File, context: CourseReaderContext) => void;
}) {
  const [entries, setEntries] = useState<CourseEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [courseName, setCourseName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof window !== 'undefined' &&
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const recentCourses = await loadRecentCourses();
        const loaded = await Promise.all(
          recentCourses.map(async (recent): Promise<CourseEntry> => {
            const storage = new BrowserDirectoryStorage(recent.handle);
            try {
              const permission = recent.handle.queryPermission
                ? await recent.handle.queryPermission({ mode: 'readwrite' })
                : 'prompt';
              if (permission !== 'granted') {
                return { recent, storage, bundle: null, permission };
              }
              return {
                recent,
                storage,
                bundle: await storage.load(),
                permission: 'granted',
              };
            } catch {
              return { recent, storage, bundle: null, permission: 'error' };
            }
          }),
        );
        if (!cancelled) {
          setEntries(loaded);
          setActiveId(loaded[0]?.recent.id ?? null);
        }
      } catch {
        if (!cancelled) setError('最近课程记录暂时无法读取。');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const active = entries.find((entry) => entry.recent.id === activeId) ?? null;
  const bundle = active?.bundle ?? null;
  const includedCount =
    bundle?.manifest.documents.filter((document) => document.includedInCourse)
      .length ?? 0;
  const conceptCount =
    bundle?.knowledge.nodes.filter((node) => node.kind !== 'course').length ??
    0;

  const setEntryBundle = (id: string, nextBundle: CourseBundle) => {
    setEntries((previous) =>
      previous.map((entry) =>
        entry.recent.id === id
          ? {
              ...entry,
              bundle: nextBundle,
              permission: 'granted',
              recent: {
                ...entry.recent,
                name: nextBundle.manifest.name,
                updatedAt: nextBundle.manifest.updatedAt,
              },
            }
          : entry,
      ),
    );
  };

  const connectHandle = async (mode: 'create' | 'existing') => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) return;
    setBusy(true);
    setError(null);
    try {
      const handle = await picker({ mode: 'readwrite' });
      const storage = new BrowserDirectoryStorage(handle);
      const nextBundle =
        mode === 'create'
          ? await storage.initialize(courseName.trim() || handle.name)
          : await storage.load();
      const recent: RecentCourse = {
        id: nextBundle.manifest.id,
        name: nextBundle.manifest.name,
        handle,
        updatedAt: nextBundle.manifest.updatedAt,
      };
      await saveRecentCourse(recent);
      setEntries((previous) => [
        { recent, storage, bundle: nextBundle, permission: 'granted' },
        ...previous.filter((entry) => entry.recent.id !== recent.id),
      ]);
      setActiveId(recent.id);
      setCreateOpen(false);
      setCourseName('');
      setMessage(
        mode === 'create'
          ? `课程“${nextBundle.manifest.name}”已在本地文件夹创建。`
          : `已连接课程“${nextBundle.manifest.name}”。`,
      );
    } catch (connectError) {
      if ((connectError as DOMException).name !== 'AbortError') {
        setError(
          connectError instanceof Error
            ? connectError.message
            : '无法连接课程文件夹。',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const reauthorize = async (entry: CourseEntry) => {
    setBusy(true);
    setError(null);
    try {
      const permission = entry.recent.handle.requestPermission
        ? await entry.recent.handle.requestPermission({ mode: 'readwrite' })
        : 'denied';
      if (permission !== 'granted')
        throw new Error('没有获得该文件夹的读写权限。');
      const nextBundle = await entry.storage.load();
      setEntryBundle(entry.recent.id, nextBundle);
    } catch (permissionError) {
      setError(
        permissionError instanceof Error
          ? permissionError.message
          : '重新授权失败。',
      );
    } finally {
      setBusy(false);
    }
  };

  const reloadActive = async () => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      setEntryBundle(active.recent.id, await active.storage.load());
      setMessage('已重新读取课程文件夹中的最新版本。');
    } catch (reloadError) {
      setError(
        reloadError instanceof Error ? reloadError.message : '重新加载失败。',
      );
    } finally {
      setBusy(false);
    }
  };

  const importPdf = async (
    file: File,
    options: ImportOptions,
    onProgress: (message: string, percent: number) => void,
  ) => {
    if (!active?.bundle) throw new Error('请先连接课程文件夹。');
    onProgress('正在提取 PDF 文字并建立内部摘要', 8);
    const digest = await extractDocumentDigest(file, (page, count) => {
      onProgress(
        `正在分析第 ${page} / ${count} 页`,
        8 + Math.round((page / count) * 62),
      );
    });
    onProgress('正在复制 PDF 并生成本地成果', 76);
    const result = await active.storage.importDocument(
      file,
      digest,
      options,
      active.bundle.manifest.revision,
    );
    onProgress('正在提交课程新版本', 94);
    setEntryBundle(active.recent.id, result.bundle);
    await saveRecentCourse({
      ...active.recent,
      name: result.bundle.manifest.name,
      updatedAt: result.bundle.manifest.updatedAt,
    });
    setMessage(
      options.mergeIntoCourse
        ? 'PDF 已导入，并已更新课程总总结和总脑图。'
        : 'PDF 已导入，暂未纳入课程知识库。',
    );
  };

  const mutateDocument = async (
    documentId: string,
    action: 'merge' | 'artifacts',
  ) => {
    if (!active?.bundle) return;
    setBusy(true);
    setError(null);
    try {
      const next =
        action === 'merge'
          ? await active.storage.mergeDocument(
              documentId,
              active.bundle.manifest.revision,
            )
          : await active.storage.updateDocumentArtifacts(
              documentId,
              active.bundle.manifest.revision,
            );
      setEntryBundle(active.recent.id, next);
      setMessage(
        action === 'merge'
          ? '这份 PDF 已并入课程总结和脑图。'
          : '已生成这份 PDF 的总结和脑图。',
      );
    } catch (mutationError) {
      setError(
        mutationError instanceof Error ? mutationError.message : '操作失败。',
      );
    } finally {
      setBusy(false);
    }
  };

  const openDocument = async (
    document: DocumentRecord,
    initialPage?: number,
  ) => {
    if (!active?.bundle) return;
    setBusy(true);
    setError(null);
    try {
      const file = await active.storage.openPdf(document.id);
      onOpenDocument(file, {
        courseName: active.bundle.manifest.name,
        document,
        digest: active.bundle.digests[document.id],
        initialPage,
        onBack: () => undefined,
      });
    } catch (openError) {
      setError(
        openError instanceof Error ? openError.message : '无法打开 PDF。',
      );
    } finally {
      setBusy(false);
    }
  };

  const sourceDocuments = useMemo(
    () =>
      new Map(
        bundle?.manifest.documents.map((document) => [document.id, document]),
      ),
    [bundle?.manifest.documents],
  );

  return (
    <div className="flex min-h-0 flex-1 bg-[#f5f7fa] text-slate-800">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-[#fafbfc] p-4 md:flex">
        <div className="flex items-center justify-between px-2 py-2">
          <p className="text-[11px] font-bold tracking-[0.13em] text-slate-500 uppercase">
            我的课程
          </p>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="创建课程"
            onClick={() => setCreateOpen(true)}
          >
            <Plus />
          </Button>
        </div>
        <div className="mt-2 space-y-1">
          {entries.map((entry) => (
            <button
              key={entry.recent.id}
              type="button"
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${entry.recent.id === activeId ? 'border-slate-200 bg-white shadow-sm' : 'border-transparent hover:bg-white'}`}
              onClick={() => setActiveId(entry.recent.id)}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-100 font-bold text-violet-700">
                {entry.recent.name.slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {entry.recent.name}
                </span>
                <span className="mt-0.5 block text-[10px] text-slate-500">
                  {entry.bundle?.manifest.documents.length ?? 0} 份 PDF ·{' '}
                  {permissionLabel(entry.permission)}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="mt-auto rounded-xl border border-slate-200 bg-white p-4">
          <p className="flex items-center gap-2 text-xs font-semibold text-slate-700">
            <ShieldCheck className="size-4 text-emerald-600" /> 本地文件夹模式
          </p>
          <p className="mt-2 text-[10px] leading-4 text-slate-500">
            课程资料只写入你授权的目录。浏览器数据被清除后，重新连接原文件夹即可恢复。
          </p>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto px-4 py-6 sm:px-7 lg:px-10">
        <div className="mx-auto max-w-7xl">
          {loading ? (
            <div className="flex min-h-[65vh] items-center justify-center text-sm text-slate-500">
              <LoaderCircle className="mr-2 size-4 animate-spin" />{' '}
              正在读取本地课程…
            </div>
          ) : !supported ? (
            <div className="mx-auto mt-20 max-w-lg rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-sm">
              <TriangleAlert className="mx-auto size-8 text-amber-600" />
              <h1 className="mt-4 text-xl font-semibold">
                当前浏览器不支持本地课程文件夹
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-500">
                请使用最新版桌面 Chrome 或 Edge
                打开本应用。当前版本不会静默改用浏览器内部存储。
              </p>
            </div>
          ) : entries.length === 0 ? (
            <div className="mx-auto mt-14 max-w-2xl rounded-3xl border border-slate-200 bg-white px-8 py-14 text-center shadow-sm">
              <span className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-violet-50 text-violet-600">
                <LibraryBig className="size-7" />
              </span>
              <h1 className="mt-6 text-2xl font-semibold tracking-tight">
                建立你的本地课程知识库
              </h1>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-7 text-slate-500">
                一门课程可包含多份
                PDF，并持续生成带页码来源的课程总结和脑图。文件夹是唯一可信数据源。
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Button onClick={() => setCreateOpen(true)}>
                  <FolderPlus /> 创建本地课程
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void connectHandle('existing')}
                >
                  <FolderCheck /> 连接已有课程
                </Button>
              </div>
            </div>
          ) : active && !bundle ? (
            <div className="mx-auto mt-20 max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <Folder className="mx-auto size-9 text-violet-600" />
              <h1 className="mt-4 text-xl font-semibold">
                {active.recent.name}
              </h1>
              <p className="mt-2 text-sm text-slate-500">
                {active.permission === 'error'
                  ? '课程文件夹内容异常，请重新连接原目录。'
                  : '浏览器需要你再次确认这个文件夹的读写权限。'}
              </p>
              <div className="mt-7 flex justify-center gap-3">
                {active.permission !== 'error' ? (
                  <Button
                    onClick={() => void reauthorize(active)}
                    disabled={busy}
                  >
                    <FolderCheck /> 重新授权
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  onClick={() => void connectHandle('existing')}
                  disabled={busy}
                >
                  重新连接原文件夹
                </Button>
              </div>
            </div>
          ) : bundle && active ? (
            <>
              <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
                <div>
                  <p className="text-xs text-slate-500">
                    本地课程 / {bundle.manifest.name}
                  </p>
                  <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
                    {bundle.manifest.name}
                  </h1>
                  <p className="mt-1 text-xs text-slate-500">
                    版本 {bundle.manifest.revision} · 文件夹{' '}
                    {active.storage.label}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                    <span className="size-2 rounded-full bg-emerald-500" />{' '}
                    已连接
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void reloadActive()}
                    disabled={busy}
                  >
                    <RefreshCw className={busy ? 'animate-spin' : ''} />{' '}
                    重新加载
                  </Button>
                  <Button size="sm" onClick={() => setImportOpen(true)}>
                    <FilePlus2 /> 导入 PDF
                  </Button>
                </div>
              </div>

              {error || message ? (
                <div
                  role="status"
                  className={`mt-5 flex items-center gap-2 rounded-xl border px-4 py-3 text-xs ${error ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}
                >
                  {error ? (
                    <TriangleAlert className="size-4" />
                  ) : (
                    <Check className="size-4" />
                  )}
                  <span className="flex-1">{error ?? message}</span>
                  <button
                    type="button"
                    className="font-semibold"
                    onClick={() => {
                      setError(null);
                      setMessage(null);
                    }}
                  >
                    关闭
                  </button>
                </div>
              ) : null}

              <section className="mt-6 grid overflow-hidden rounded-2xl border border-slate-200 bg-white sm:grid-cols-4">
                <Metric
                  icon={<FileText />}
                  value={bundle.manifest.documents.length}
                  label="课程 PDF"
                />
                <Metric
                  icon={<GitMerge />}
                  value={includedCount}
                  label="已纳入课程"
                  tone="green"
                />
                <Metric
                  icon={<Network />}
                  value={conceptCount}
                  label="知识节点"
                  tone="violet"
                />
                <Metric
                  icon={<Clock3 />}
                  value={`v${bundle.knowledge.version}`}
                  label={`更新于 ${formatUpdatedAt(bundle.manifest.updatedAt)}`}
                  tone="amber"
                />
              </section>

              <Tabs
                defaultValue="summary"
                className="mt-5 gap-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
              >
                <TabsList
                  variant="line"
                  className="h-13 w-full justify-start gap-3 border-b border-slate-200 px-4"
                >
                  <TabsTrigger value="summary" className="flex-none px-3">
                    <Sparkles /> 课程总总结
                  </TabsTrigger>
                  <TabsTrigger value="mindmap" className="flex-none px-3">
                    <Network /> 课程脑图
                  </TabsTrigger>
                  <TabsTrigger value="documents" className="flex-none px-3">
                    <FileText /> PDF 资料 {bundle.manifest.documents.length}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="summary" className="min-h-[520px]">
                  {includedCount === 0 ? (
                    <div className="flex min-h-[500px] flex-col items-center justify-center px-6 text-center">
                      <Sparkles className="size-8 text-violet-500" />
                      <h2 className="mt-5 text-base font-semibold">
                        课程总结尚未包含资料
                      </h2>
                      <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">
                        导入第一份 PDF
                        后，可生成独立成果，并将内部摘要合并到课程总总结和总脑图。
                      </p>
                      <Button
                        className="mt-6"
                        onClick={() => setImportOpen(true)}
                      >
                        <FilePlus2 /> 导入第一份 PDF
                      </Button>
                    </div>
                  ) : (
                    <div className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
                      <article className="px-6 py-8 sm:px-10">
                        <p className="text-xs font-bold tracking-[0.12em] text-violet-600 uppercase">
                          课程总总结
                        </p>
                        <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                          {bundle.manifest.name}知识框架
                        </h2>
                        <p className="mt-1 text-xs text-slate-500">
                          版本 {bundle.knowledge.version} · 汇总 {includedCount}{' '}
                          份 PDF
                        </p>
                        <div className="mt-9 space-y-9">
                          {bundle.knowledge.nodes
                            .filter((node) => node.kind !== 'course')
                            .slice(0, 12)
                            .map((node, index) => (
                              <section key={node.id}>
                                <h3 className="text-sm font-semibold text-slate-900">
                                  {index + 1}. {node.label}
                                </h3>
                                <p className="mt-2 text-sm leading-7 text-slate-600">
                                  {node.description}
                                </p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {node.sources.slice(0, 3).map((source) => (
                                    <Button
                                      key={`${source.documentId}-${source.pageStart}`}
                                      variant="outline"
                                      size="xs"
                                      className="text-blue-700"
                                      onClick={() => {
                                        const document = sourceDocuments.get(
                                          source.documentId,
                                        );
                                        if (document)
                                          void openDocument(
                                            document,
                                            source.pageStart,
                                          );
                                      }}
                                    >
                                      {source.fileName} · 第 {source.pageStart}{' '}
                                      页
                                    </Button>
                                  ))}
                                </div>
                              </section>
                            ))}
                        </div>
                      </article>
                      <aside className="border-t border-slate-200 bg-slate-50/70 p-6 lg:border-t-0 lg:border-l">
                        <h3 className="text-xs font-semibold text-slate-800">
                          本次课程版本
                        </h3>
                        <div className="mt-4 space-y-3 text-xs text-slate-600">
                          <p className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
                            + {conceptCount} 个可追溯知识节点
                          </p>
                          <p className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
                            ✓ {includedCount} 份 PDF 来源已合并
                          </p>
                          <p className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
                            ! {bundle.knowledge.conflicts.length} 个资料冲突
                          </p>
                        </div>
                        <p className="mt-6 text-[11px] leading-5 text-slate-500">
                          每次更新前都会把上一版课程成果保存到 History 目录。
                        </p>
                      </aside>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="mindmap">
                  <KnowledgeMindmap
                    knowledge={bundle.knowledge}
                    onOpenSource={(documentId, page) => {
                      const document = sourceDocuments.get(documentId);
                      if (document) void openDocument(document, page);
                    }}
                  />
                </TabsContent>

                <TabsContent
                  value="documents"
                  className="min-h-[500px] p-5 sm:p-7"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-semibold">课程资料</h2>
                      <p className="mt-1 text-xs text-slate-500">
                        独立成果与是否纳入课程知识库可以分别控制。
                      </p>
                    </div>
                    <Button size="sm" onClick={() => setImportOpen(true)}>
                      <FilePlus2 /> 导入 PDF
                    </Button>
                  </div>
                  {bundle.manifest.documents.length === 0 ? (
                    <div className="flex min-h-80 flex-col items-center justify-center text-center">
                      <FileText className="size-8 text-slate-400" />
                      <h3 className="mt-4 text-sm font-semibold">
                        还没有 PDF 资料
                      </h3>
                      <p className="mt-2 text-xs text-slate-500">
                        导入时可分别选择生成单 PDF 成果和并入课程。
                      </p>
                    </div>
                  ) : (
                    <div className="mt-6 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
                      {bundle.manifest.documents.map((document) => (
                        <div
                          key={document.id}
                          className="grid gap-4 bg-white px-4 py-4 lg:grid-cols-[minmax(220px,1fr)_190px_190px_auto] lg:items-center"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-[10px] font-bold text-rose-700">
                              PDF
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold">
                                {document.fileName}
                              </span>
                              <span className="mt-1 block text-[10px] text-slate-500">
                                {document.pageCount} 页 · 已复制到课程文件夹
                              </span>
                            </span>
                          </div>
                          <span
                            className={`flex items-center gap-2 text-xs ${document.includedInCourse ? 'text-emerald-700' : 'text-amber-700'}`}
                          >
                            {document.includedInCourse ? (
                              <Check className="size-4" />
                            ) : (
                              <TriangleAlert className="size-4" />
                            )}
                            {document.includedInCourse
                              ? '已纳入课程'
                              : '尚未纳入课程知识库'}
                          </span>
                          <span className="flex items-center gap-2 text-xs text-slate-600">
                            {document.hasSummary && document.hasMindmap ? (
                              <Check className="size-4 text-emerald-600" />
                            ) : (
                              <span className="size-4 text-center">—</span>
                            )}
                            {document.hasSummary && document.hasMindmap
                              ? '总结与脑图已生成'
                              : '未生成独立成果'}
                          </span>
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => void openDocument(document)}
                            >
                              <BookOpen /> 打开
                            </Button>
                            {!document.includedInCourse ? (
                              <Button
                                size="xs"
                                onClick={() =>
                                  void mutateDocument(document.id, 'merge')
                                }
                                disabled={busy}
                              >
                                <GitMerge /> 并入课程
                              </Button>
                            ) : null}
                            {!document.hasSummary || !document.hasMindmap ? (
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() =>
                                  void mutateDocument(document.id, 'artifacts')
                                }
                                disabled={busy}
                              >
                                生成成果
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </>
          ) : null}
        </div>
      </main>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>创建本地课程</DialogTitle>
            <DialogDescription>
              所选文件夹将成为这门课程的唯一可信数据来源。
            </DialogDescription>
          </DialogHeader>
          <label className="mt-2 space-y-2">
            <span className="text-xs font-semibold text-slate-700">
              课程名称
            </span>
            <Input
              value={courseName}
              onChange={(event) => setCourseName(event.target.value)}
              placeholder="例如：机器学习"
              autoFocus
            />
          </label>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-500">
            创建后会建立
            course.json、课程总结、课程脑图、PDFs、Documents、History
            和“我的课程笔记.md”。用户笔记不会被自动覆盖。
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              onClick={() => void connectHandle('create')}
              disabled={!courseName.trim() || busy}
            >
              {busy ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <FolderPlus />
              )}
              选择文件夹并创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CourseImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={importPdf}
      />
    </div>
  );
}
