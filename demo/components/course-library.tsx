'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  Clock3,
  Copy,
  FilePlus2,
  FileText,
  Folder,
  FolderCheck,
  FolderPlus,
  Globe2,
  GitMerge,
  LibraryBig,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

import { knowledgeStageMessage } from '@/lib/knowledge/synthesis-progress';
import type { SynthesisDiagnostic } from '@/lib/knowledge/hierarchical-synthesis';
import { CourseGlossary } from '@/components/course-glossary';
import {
  EMPTY_GLOSSARY,
  glossaryFingerprint,
  parseGlossary,
  type Glossary,
} from '@/lib/glossary';
import { CourseImportDialog } from '@/components/course-import-dialog';
import { DocumentProcessingStatus } from '@/components/document-processing-status';
import { processingIsActive, type BackgroundImports } from '@/lib/background-imports';
import { createBackgroundProcessor } from '@/lib/background-processor';
import { registerTaskControl,removeTaskCourse,updateTaskBundle } from '@/lib/background-task-store';
import { KnowledgeMarkdown, KnowledgeSection } from '@/components/knowledge-section';
import { KnowledgeMindmap } from '@/components/knowledge-mindmap';
import { CourseNotesPanel } from '@/components/course-notes-panel';
import { CourseHistoryPanel } from '@/components/course-history-panel';
import { MarkdownActions, StudyActions } from '@/components/study-actions';
import { renderCourseSummary } from '@/lib/knowledge/artifact-renderer';
import { appendStudyNote, artifactStatus, selectStudyDocuments, type DocumentSort } from '@/lib/course-storage/study-tools';
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
import { DesktopCourseStorage } from '@/lib/course-storage/desktop-course-storage';
import {
  loadRecentCourses,
  removeRecentCourse,
  saveRecentCourse,
  type RecentCourse,
} from '@/lib/course-storage/recent-courses';
import type {
  AiCourseKnowledge,
  BrowserDirectoryHandle,
  CourseBundle,
  CourseStorage,
  DirectoryPickerWindow,
  DocumentDigest,
  DocumentRecord,
  ImportOptions,
  SourceReference,
} from '@/lib/course-storage/types';
import { createReaderService, type DocumentProgress } from '@/lib/reader-cache';
import { publishCachedTranslation } from '@/lib/shared-translation';
import { loadChatSettings, type ChatSettings } from '@/lib/chat-cache';
import type { ChatScope } from '@/lib/chat-cache';
import {
  askSharedDocument,
  clearSharedConversation,
  getSharedConversation,
  translateSharedPage,
} from '@/lib/host-shared-actions';
import { loadKnowledgeSettings } from '@/lib/knowledge-settings';
import type { PageImageInput } from '@/lib/chat';
import { sha256Hex, stableDocumentId } from '@/lib/course-storage/file-utils';
import { buildCourseAiContext } from '@/lib/course-ai-context';
import type { LanShareStatus } from '@/electron/api';
import {
  createKnowledgeProviderForSettings,
  describeKnowledgeError,
} from '@/lib/knowledge/ai-knowledge-provider';
import { extractPdfPages, inspectPdf } from '@/lib/knowledge/document-digest';
import {
  createOcrProviderForSettings,
  createOcrService,
  resolvePageOcr,
} from '@/lib/ocr';
import {
  locateEntity,
  monotonicImportPercent,
  readCourseLocator,
  readDocumentLocator,
  readPage,
  type CourseImportProgress,
  type CourseImportStage,
  type CourseControlItem,
  type CourseLibraryControl,
} from '@/lib/yeyu-mcp-control';

export interface CourseReaderContext {
  glossary?: Glossary;
  glossaryFingerprint?: string;
  /** Short course-level material shared by page/document AI questions. */
  courseContext?: string;
  courseId: string;
  courseName: string;
  document: DocumentRecord;
  digest?: DocumentDigest;
  initialPage?: number;
  initialQuestion?: string;
  onBack: () => void;
  storage?: CourseStorage;
}

interface CourseEntry {
  id: string;
  name: string;
  updatedAt: string;
  /** 仅浏览器模式存在；桌面课程来自工作区磁盘扫描，无需目录句柄。 */
  handle?: BrowserDirectoryHandle;
  storage: CourseStorage;
  bundle: CourseBundle | null;
  permission: 'granted' | 'prompt' | 'denied' | 'error';
}

interface ImportProgressRuntime {
  progress: CourseImportProgress;
  startedAtMs: number;
  stageStartedAtMs: number;
}

function snapshotImportProgress(
  runtime: ImportProgressRuntime,
  now = Date.now(),
): CourseImportProgress {
  if (!runtime.progress.active) return runtime.progress;
  return {
    ...runtime.progress,
    elapsedMs: Math.max(runtime.progress.elapsedMs, now - runtime.startedAtMs),
    stageElapsedMs: Math.max(
      runtime.progress.stageElapsedMs,
      now - runtime.stageStartedAtMs,
    ),
  };
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
  onControlReady,
  onBundleUpdated,
}: {
  onOpenDocument: (file: File, context: CourseReaderContext) => void;
  onControlReady?: (control: CourseLibraryControl | null) => void;
  onBundleUpdated?: (bundle: CourseBundle) => void;
}) {
  const [entries, setEntries] = useState<CourseEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [studyTab, setStudyTab] = useState('summary');
  const [documentQuery, setDocumentQuery] = useState('');
  const [documentSort, setDocumentSort] = useState<DocumentSort>('recent-read');
  const [readingProgress, setReadingProgress] = useState<DocumentProgress[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [courseName, setCourseName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [generationAbort, setGenerationAbort] = useState<AbortController | null>(null);
  const [generationCourseId, setGenerationCourseId] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState<(() => void) | null>(null);
  const [generationDiagnostics, setGenerationDiagnostics] = useState<SynthesisDiagnostic[]>([]);
  const onDiagnostic = (diagnostic: SynthesisDiagnostic) => setGenerationDiagnostics(previous => [...previous, diagnostic]);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: 'course'; entry: CourseEntry }
    | { kind: 'document'; document: DocumentRecord }
    | null
  >(null);
  const [shareStatus, setShareStatus] = useState<LanShareStatus>({
    running: false,
    port: null,
    addresses: [],
  });
  const [shareOpen, setShareOpen] = useState(false);
  const [sharePassword, setSharePassword] = useState('');
  const [sharePort, setSharePort] = useState('37891');
  const [sharePermissions, setSharePermissions] = useState({
    importPdf: true,
    ai: true,
    manage: false,
  });
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const controlTaskRef = useRef(false);
  const sharedActionControllersRef = useRef(new Map<string, AbortController>());
  const [importProgress, setImportProgress] = useState<
    CourseImportProgress | undefined
  >(undefined);
  const importProgressRef = useRef<ImportProgressRuntime | null>(null);
  const backgroundRef = useRef<BackgroundImports | null>(null);
  if (!backgroundRef.current) backgroundRef.current = createBackgroundProcessor({
    onBundle: (id, next) => setEntryBundle(id, next),
    onProgress: message => setMessage(message),
    onError: message => setError(message),
    execute: !(typeof window !== 'undefined' && window.yeyuDesktop?.getBackgroundSnapshot),
    onWake: () => { void window.yeyuDesktop?.wakeBackgroundTasks?.().catch(() => undefined); },
  });
  useEffect(() => {
    const worker = backgroundRef.current!;
    worker.resume();
    const unregister = window.yeyuDesktop?.controlBackgroundTask ? undefined : registerTaskControl(command => worker.control(command));
    return () => { worker.stop(); unregister?.(); };
  }, []);
  useEffect(() => {
    const worker = backgroundRef.current!;
    for (const entry of entries) if (entry.bundle && entry.permission === 'granted') {
      worker.register(entry.id, entry.storage);
      if (!window.yeyuDesktop?.getBackgroundSnapshot) updateTaskBundle(entry.bundle);
    }
    worker.wake();
  }, [entries]);
  useEffect(() => {
    const api = window.yeyuDesktop;
    if (!api?.onCoursesChanged) return;
    let live = true;
    const refresh = async (directoryName: string) => {
      const entry = entries.find(item => item.storage.label === directoryName);
      if (!entry) return;
      try {
        const next = await entry.storage.load();
        if (live) setEntries(previous => {
          const current = previous.find(item => item.id === entry.id);
          if (!current || (current.bundle && current.bundle.manifest.revision >= next.manifest.revision)) return previous;
          return previous.map(item => item.id === entry.id ? {...item,bundle:next,name:next.manifest.name,updatedAt:next.manifest.updatedAt} : item);
        });
        if (live && next.manifest.revision > (entry.bundle?.manifest.revision ?? -1)) onBundleUpdated?.(next);
      } catch { /* The next notification or explicit refresh can recover a disconnected course. */ }
    };
    const unsubscribe = api.onCoursesChanged(({directoryName}) => { void refresh(directoryName); });
    return () => {live=false;unsubscribe();};
  },[entries,onBundleUpdated]);

  const beginImportProgress = (fileName: string) => {
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const progress: CourseImportProgress = {
      active: true,
      fileName,
      stage: 'checking',
      message: '准备导入 PDF',
      percent: 0,
      startedAt: timestamp,
      elapsedMs: 0,
      stageStartedAt: timestamp,
      stageElapsedMs: 0,
    };
    importProgressRef.current = {
      progress,
      startedAtMs: now,
      stageStartedAtMs: now,
    };
    setImportProgress(progress);
  };

  const updateImportProgress = (
    message: string,
    percent: number,
    stage: CourseImportStage,
  ) => {
    const runtime = importProgressRef.current;
    if (!runtime?.progress.active) return;
    const now = Date.now();
    const previous = snapshotImportProgress(runtime, now);
    if (runtime.progress.stage !== stage) runtime.stageStartedAtMs = now;
    const stageStartedAt = new Date(runtime.stageStartedAtMs).toISOString();
    runtime.progress = {
      ...previous,
      active: true,
      stage,
      message,
      percent: monotonicImportPercent(previous.percent, percent),
      stageStartedAt,
      stageElapsedMs: Math.max(0, now - runtime.stageStartedAtMs),
    };
    setImportProgress(runtime.progress);
  };

  const finishImportProgress = (
    stage: 'completed' | 'failed',
    message: string,
    percent?: number,
  ) => {
    const runtime = importProgressRef.current;
    if (!runtime) return;
    const now = Date.now();
    const previous = snapshotImportProgress(runtime, now);
    if (runtime.progress.stage !== stage) runtime.stageStartedAtMs = now;
    runtime.progress = {
      ...previous,
      active: false,
      stage,
      message,
      percent:
        percent === undefined
          ? previous.percent
          : monotonicImportPercent(previous.percent, percent),
      stageStartedAt: new Date(runtime.stageStartedAtMs).toISOString(),
      stageElapsedMs: Math.max(0, now - runtime.stageStartedAtMs),
    };
    setImportProgress(runtime.progress);
  };

  const currentImportProgress = () => {
    const runtime = importProgressRef.current;
    return runtime ? snapshotImportProgress(runtime) : importProgress;
  };

  const desktopApi =
    typeof window !== 'undefined' ? window.yeyuDesktop : undefined;
  const isDesktop = Boolean(desktopApi);

  const supported =
    isDesktop ||
    (typeof window !== 'undefined' &&
      typeof (window as DirectoryPickerWindow).showDirectoryPicker ===
        'function');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (desktopApi) {
          // 桌面模式：启动即用固定工作区，课程以磁盘扫描结果为准。
          const info = await desktopApi.getWorkspaceInfo();
          const courses = await desktopApi.listCourses();
          const loaded: CourseEntry[] = await Promise.all(
            courses.map(async (course): Promise<CourseEntry> => {
              const storage = new DesktopCourseStorage(
                desktopApi,
                course.directoryName,
              );
              try {
                return {
                  id: course.manifest.id,
                  name: course.manifest.name,
                  updatedAt: course.manifest.updatedAt,
                  storage,
                  bundle: await storage.load(),
                  permission: 'granted',
                };
              } catch {
                return {
                  id: course.manifest.id,
                  name: course.manifest.name,
                  updatedAt: course.manifest.updatedAt,
                  storage,
                  bundle: null,
                  permission: 'error',
                };
              }
            }),
          );
          if (!cancelled) {
            setWorkspaceRoot(info.root);
            setEntries(loaded);
            setActiveId(loaded[0]?.id ?? null);
          }
          return;
        }
        const recentCourses = await loadRecentCourses();
        const loaded = await Promise.all(
          recentCourses.map(async (recent): Promise<CourseEntry> => {
            const storage = new BrowserDirectoryStorage(recent.handle);
            try {
              const permission = recent.handle.queryPermission
                ? await recent.handle.queryPermission({ mode: 'readwrite' })
                : 'prompt';
              if (permission !== 'granted') {
                return {
                  id: recent.id,
                  name: recent.name,
                  updatedAt: recent.updatedAt,
                  handle: recent.handle,
                  storage,
                  bundle: null,
                  permission,
                };
              }
              return {
                id: recent.id,
                name: recent.name,
                updatedAt: recent.updatedAt,
                handle: recent.handle,
                storage,
                bundle: await storage.load(),
                permission: 'granted',
              };
            } catch {
              return {
                id: recent.id,
                name: recent.name,
                updatedAt: recent.updatedAt,
                handle: recent.handle,
                storage,
                bundle: null,
                permission: 'error',
              };
            }
          }),
        );
        if (!cancelled) {
          setEntries(loaded);
          setActiveId(loaded[0]?.id ?? null);
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

  useEffect(() => {
    if (!desktopApi?.getLanShareStatus) return;
    void desktopApi
      .getLanShareStatus()
      .then(setShareStatus)
      .catch(() => undefined);
  }, []);

  const active = entries.find((entry) => entry.id === activeId) ?? null;
  const bundle = active?.bundle ?? null;
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      const documents = bundle?.manifest.documents ?? [];
      void Promise.all(documents.map(document => createReaderService().progress.load(document.fingerprint)))
        .then(values => {if (!cancelled) setReadingProgress(values.filter((value): value is DocumentProgress => Boolean(value)));})
        .catch(() => {if (!cancelled) setReadingProgress([]);});
    };
    refresh(); window.addEventListener('focus', refresh); window.addEventListener('reader-progress-updated', refresh);
    return () => {cancelled = true; window.removeEventListener('focus', refresh); window.removeEventListener('reader-progress-updated', refresh);};
  }, [bundle?.manifest.documents]);
  const visibleDocuments = selectStudyDocuments(bundle?.manifest.documents ?? [], readingProgress, documentQuery, documentSort);
  const recentDocuments = selectStudyDocuments(bundle?.manifest.documents ?? [], readingProgress).filter(document => readingProgress.some(progress => progress.fingerprint === document.fingerprint)).slice(0,3);
  const backgroundBusy = Boolean(bundle?.manifest.documents.some(doc => processingIsActive(doc.processing)));
  const includedCount =
    bundle?.manifest.documents.filter((document) => document.includedInCourse)
      .length ?? 0;
  const conceptCount =
    bundle?.knowledge.nodes.filter((node) => node.kind !== 'course').length ??
    0;

  const setEntryBundle = (id: string, nextBundle: CourseBundle) => {
    onBundleUpdated?.(nextBundle);
    setEntries((previous) =>
      previous.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              bundle: nextBundle,
              permission: 'granted',
              name: nextBundle.manifest.name,
              updatedAt: nextBundle.manifest.updatedAt,
            }
          : entry,
      ),
    );
  };

  const createDesktopCourse = async () => {
    if (!desktopApi) return;
    setBusy(true);
    setError(null);
    try {
      const { directoryName } = await desktopApi.createCourseDirectory(
        courseName.trim(),
      );
      const storage = new DesktopCourseStorage(desktopApi, directoryName);
      const nextBundle = await storage.withWriteLock(() => storage.initialize(courseName.trim()));
      setEntries((previous) => [
        {
          id: nextBundle.manifest.id,
          name: nextBundle.manifest.name,
          updatedAt: nextBundle.manifest.updatedAt,
          storage,
          bundle: nextBundle,
          permission: 'granted',
        },
        ...previous.filter((entry) => entry.id !== nextBundle.manifest.id),
      ]);
      setActiveId(nextBundle.manifest.id);
      setCreateOpen(false);
      setCourseName('');
      setMessage(`课程“${nextBundle.manifest.name}”已在工作区创建。`);
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : '无法创建课程。',
      );
    } finally {
      setBusy(false);
    }
  };

  const connectHandle = async (mode: 'create' | 'existing') => {
    if (isDesktop) {
      await createDesktopCourse();
      return;
    }
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
        {
          id: recent.id,
          name: recent.name,
          updatedAt: recent.updatedAt,
          handle,
          storage,
          bundle: nextBundle,
          permission: 'granted',
        },
        ...previous.filter((entry) => entry.id !== recent.id),
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
    if (!entry.handle) return;
    setBusy(true);
    setError(null);
    try {
      const permission = entry.handle.requestPermission
        ? await entry.handle.requestPermission({ mode: 'readwrite' })
        : 'denied';
      if (permission !== 'granted')
        throw new Error('没有获得该文件夹的读写权限。');
      const nextBundle = await entry.storage.load();
      setEntryBundle(entry.id, nextBundle);
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
      setEntryBundle(active.id, await active.storage.load());
      setMessage(
        isDesktop
          ? '已重新读取工作区课程目录中的最新版本。'
          : '已重新读取课程文件夹中的最新版本。',
      );
    } catch (reloadError) {
      setError(
        reloadError instanceof Error ? reloadError.message : '重新加载失败。',
      );
    } finally {
      setBusy(false);
    }
  };

  const startLanShare = async () => {
    if (!desktopApi?.startLanShare) return;
    const port = Number(sharePort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setShareError('端口必须是 1024–65535 之间的整数。');
      return;
    }
    setShareBusy(true);
    setShareError(null);
    try {
      const status = await desktopApi.startLanShare(
        sharePassword,
        port,
        sharePermissions,
      );
      setShareStatus(status);
      setSharePassword('');
      setMessage('局域网共享已开启。请保持主电脑上的页语运行且不要休眠。');
    } catch (shareStartError) {
      setShareError(
        shareStartError instanceof Error
          ? shareStartError.message
          : '局域网共享启动失败。',
      );
    } finally {
      setShareBusy(false);
    }
  };

  const stopLanShare = async () => {
    if (!desktopApi?.stopLanShare) return;
    setShareBusy(true);
    setShareError(null);
    try {
      await desktopApi.stopLanShare();
      setShareStatus({ running: false, port: null, addresses: [] });
      setMessage('局域网共享已关闭，之前的查看端会话已经失效。');
    } catch (shareStopError) {
      setShareError(
        shareStopError instanceof Error
          ? shareStopError.message
          : '局域网共享关闭失败。',
      );
    } finally {
      setShareBusy(false);
    }
  };

  const copyShareAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1600);
    } catch {
      setShareError('无法复制地址，请手动选择并复制。');
    }
  };

  const publishExistingTranslations = async () => {
    if (!active?.bundle || !active.storage.publishTranslation) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const documents = new Map(
        active.bundle.manifest.documents.map((document) => [
          document.fingerprint,
          document,
        ]),
      );
      const cached = await createReaderService().cache.list();
      const published = new Set<string>();
      const failures: string[] = [];
      for (const entry of cached) {
        const document = documents.get(entry.fingerprint);
        if (
          !document ||
          entry.provider === 'mock' ||
          entry.paragraphs.length === 0
        ) {
          continue;
        }
        if (entry.pageNumber < 1 || entry.pageNumber > document.pageCount) {
          failures.push(
            `${document.fileName} 第 ${entry.pageNumber} 页页码无效`,
          );
          continue;
        }
        try {
          if (
            await publishCachedTranslation(active.storage, entry, document.id)
          ) {
            published.add(`${entry.targetLanguage}:${entry.pageNumber}`);
          }
        } catch (publishError) {
          failures.push(
            `${document.fileName} 第 ${entry.pageNumber} 页：${publishError instanceof Error ? publishError.message : '格式不正确'}`,
          );
        }
      }
      const suffix =
        failures.length > 0
          ? `失败 ${failures.length} 项：${failures.slice(0, 2).join('；')}${failures.length > 2 ? '；…' : ''}`
          : '没有失败记录。';
      setMessage(
        `已发布 ${published.size} 个语言/页码译文记录（可重复执行且幂等）。${suffix}`,
      );
    } catch (publishError) {
      setError(
        publishError instanceof Error
          ? publishError.message
          : '读取本机译文缓存失败。',
      );
    } finally {
      setBusy(false);
    }
  };

  const makeOcrRecognizer = (chatSettings: ChatSettings) => {
    const ocrProvider = createOcrProviderForSettings(chatSettings);
    const ocrCache = createOcrService();
    return (request: {
      fingerprint: string;
      pageNumber: number;
      pageImage: PageImageInput;
      signal?: AbortSignal;
    }) =>
      resolvePageOcr({
        provider: ocrProvider,
        cache: ocrCache,
        request,
        signal: request.signal,
      }).then((resolved) => resolved.result.text);
  };

  const importPdfForEntry = async (
    entry: CourseEntry,
    file: File,
    options: ImportOptions,
    onProgress: (message: string, percent: number) => void,
    signal?: AbortSignal,
    _onImportDiagnostic?: (diagnostic: SynthesisDiagnostic) => void,
  ) => {
    if (!entry.bundle) throw new Error('目标课程当前无法读取。');
    const worker = backgroundRef.current!;
    worker.register(entry.id, entry.storage);
    worker.hold();
    beginImportProgress(file.name);
    setError(null);
    const report = (message: string, percent: number, stage: CourseImportStage) => {
      updateImportProgress(message, percent, stage);
      onProgress(message, percent);
    };
    try {
      report('检查 PDF 内容指纹', 5, 'checking');
      const fingerprint = await sha256Hex(await file.arrayBuffer());
      const initial = await entry.storage.load();
      const existing = initial.manifest.documents.find(doc => doc.fingerprint === fingerprint);
      if (existing) {
        setEntryBundle(entry.id, initial);
        const message = existing.processing
          ? 'PDF 已存在，未重复保存；后台整理状态保留，可在资料列表查看或重试。'
          : 'PDF 已存在，已跳过；未进行文字提取或 AI 分析。';
        setMessage(message);
        finishImportProgress('completed', message, 100);
        return message;
      }
      report('读取 PDF 页数（不进行 OCR 或 AI 分析）', 25, 'checking');
      const metadata = await inspectPdf(file, signal);
      if (signal?.aborted) throw new Error('保存已取消。');
      report('保存 PDF 到课程文件夹', 90, 'saving');
      const result = await worker.mutate(entry.id, async (storage, current) => {
        const duplicate = current.manifest.documents.find(doc => doc.fingerprint === metadata.fingerprint);
        if (duplicate) return {bundle:current, document:duplicate};
        if (signal?.aborted) throw new Error('保存已取消。');
        return storage.savePdf(file, metadata, options, current.manifest.revision);
      });
      setEntryBundle(entry.id, result.bundle);
      const message = result.document.processing
        ? 'PDF 已保存，可立即阅读；AI 整理已加入后台队列。'
        : 'PDF 已保存，可立即阅读；未安排 AI 整理。';
      setMessage(message);
      finishImportProgress('completed', message, 100);
      return message;
    } catch (error) {
      finishImportProgress('failed', 'PDF 保存失败');
      throw error;
    } finally { worker.release(); }
  };

  const importPdf = async (
    file: File,
    options: ImportOptions,
    onProgress: (message: string, percent: number) => void,
    signal?: AbortSignal,
    onImportDiagnostic?: (diagnostic: SynthesisDiagnostic) => void,
  ) => {
    if (!active) throw new Error('请先连接课程文件夹。');
    if (busy || controlTaskRef.current) {
      throw new Error('页语正在执行另一项课程任务，请稍后重试。');
    }
    controlTaskRef.current = true;
    try {
      return await importPdfForEntry(
        active,
        file,
        options,
        onProgress,
        signal,
        onImportDiagnostic,
      );
    } finally {
      controlTaskRef.current = false;
    }
  };

  const regenerateDocument = async (document: DocumentRecord, retry = false) => {
    if (!active?.bundle) return;
    const expectedRevision = active.bundle.manifest.revision;
    if (backgroundBusy) { setError('本课程正在后台整理，可继续阅读；完成后可手动重新生成。'); return; }
    setBusy(true);
    setError(null);
    setRetryGeneration(null);
    setGenerationDiagnostics([]);
    setGenerationCourseId(activeId);
    const controller = new AbortController();
    setGenerationAbort(controller);
    try {
      const glossary = await active.storage.loadGlossary?.() ?? EMPTY_GLOSSARY;
      const provider = createKnowledgeProviderForSettings(
        loadKnowledgeSettings(),
      );
      const chatSettings = loadChatSettings();
      setMessage('正在读取课程中的 PDF 并提取文字…');
      const file = await active.storage.openPdf(document.id);
      const recognizePage = makeOcrRecognizer(chatSettings);
      const extracted = await extractPdfPages(file, {
        signal: controller.signal,
        onProgress: (page, count, stage) => {
          setMessage(
            stage === 'ocr'
              ? `正在用视觉模型识别第 ${page} / ${count} 页（OCR）`
              : `正在提取第 ${page} / ${count} 页文字`,
          );
        },
        recognizePage,
      });
      // 主动重新生成绕过缓存；失败/取消后的重试复用已完成层。
      const digest = await provider.analyzeDocument({
        signal: controller.signal, onDiagnostic,
        glossary,
        fingerprint: extracted.fingerprint,
        fileName: file.name,
        documentId: stableDocumentId(extracted.fingerprint),
        pages: extracted.pages,
        bypassCache: !retry,
        resume: retry,
        onStage: (stage, detail) => setMessage(knowledgeStageMessage(stage, detail)),
      });
      if (controller.signal.aborted) throw new Error('生成已取消；旧成果保留，已完成层可在重试时复用。');
      setGenerationAbort(null);
      const next = await backgroundRef.current!.mutate(active.id, storage => {
        if (controller.signal.aborted) throw new Error('生成已取消。');
        return storage.updateDocumentArtifacts(document.id, expectedRevision, digest);
      });
      setEntryBundle(active.id, next);
      setMessage('已用 AI 重新生成这份 PDF 的总结和脑图。');
    } catch (mutationError) {
      setError(describeKnowledgeError(mutationError));
      setRetryGeneration(() => () => void regenerateDocument(document, true));
    } finally {
      setGenerationAbort(null);
      setBusy(false);
    }
  };

  const mergeDocumentWithAi = async (document: DocumentRecord) => {
    if (!active?.bundle) return;
    if (backgroundBusy) { setError('本课程正在后台整理，将自动统一汇总。'); return; }
    setBusy(true);
    setError(null);
    setRetryGeneration(null);
    setGenerationDiagnostics([]);
    setGenerationCourseId(activeId);
    const controller = new AbortController();
    setGenerationAbort(controller);
    try {
      const bundle = active.bundle;
      const glossary = await active.storage.loadGlossary?.() ?? EMPTY_GLOSSARY;
      const provider = createKnowledgeProviderForSettings(
        loadKnowledgeSettings(),
      );
      setMessage('AI 正在综合课程总总结与总脑图…');
      const includedDigests = bundle.manifest.documents
        .filter(
          (item) =>
            (item.includedInCourse || item.id === document.id) &&
            bundle.digests[item.id],
        )
        .map((item) => bundle.digests[item.id]);
      const aiKnowledge = await provider.synthesizeCourseKnowledge({
        signal: controller.signal, onDiagnostic,
        onStage: (stage, detail) => setMessage(knowledgeStageMessage(stage, detail)),
        glossary,
        courseId: bundle.manifest.id,
        courseName: bundle.manifest.name,
        digests: includedDigests,
        userNodeLabels: bundle.knowledge.nodes
          .filter((node) => node.ownership === 'user')
          .map((node) => node.label),
      });
      if (controller.signal.aborted) throw new Error('生成已取消；旧成果保留，已完成层可在重试时复用。');
      setGenerationAbort(null);
      const next = await backgroundRef.current!.mutate(active.id, storage => {
        if (controller.signal.aborted) throw new Error('生成已取消。');
        return storage.mergeDocument(document.id, bundle.manifest.revision, aiKnowledge);
      });
      setEntryBundle(active.id, next);
      setMessage('这份 PDF 已并入 AI 综合的课程总结和脑图。');
    } catch (mutationError) {
      setError(describeKnowledgeError(mutationError));
      setRetryGeneration(() => () => void mergeDocumentWithAi(document));
    } finally {
      setGenerationAbort(null);
      setBusy(false);
    }
  };

  const openDocumentForEntry = async (
    entry: CourseEntry,
    document: DocumentRecord,
    initialPage?: number,
    propagateError = false,
    initialQuestion?: string,
  ) => {
    if (!entry.bundle) throw new Error('目标课程当前无法读取。');
    setBusy(true);
    setError(null);
    try {
      const file = await entry.storage.openPdf(document.id);
      const glossary = await entry.storage.loadGlossary?.() ?? EMPTY_GLOSSARY;
      onOpenDocument(file, {
        glossary,
        glossaryFingerprint: await glossaryFingerprint(glossary),
        courseContext: buildCourseAiContext(entry.bundle, glossary),
        courseId: entry.bundle.manifest.id,
        courseName: entry.bundle.manifest.name,
        document,
        digest: entry.bundle.digests[document.id],
        initialPage,
        initialQuestion,
        onBack: () => undefined,
        storage: entry.storage,
      });
    } catch (openError) {
      setError(
        openError instanceof Error ? openError.message : '无法打开 PDF。',
      );
      if (propagateError) throw openError;
    } finally {
      setBusy(false);
    }
  };

  const openDocument = async (
    document: DocumentRecord,
    initialPage?: number,
  ) => {
    if (!active) return;
    return openDocumentForEntry(active, document, initialPage);
  };

  const deleteDocument = async (document: DocumentRecord) => {
    if (!active?.bundle) return;
    if (backgroundBusy) { setError('请在本课程后台整理结束后删除，避免正在生成的成果覆盖删除结果。'); return; }
    setBusy(true);
    setError(null);
    try {
      const bundle = active.bundle;
      // 删除已纳入课程的 PDF 时，用剩余资料重新综合课程总总结与总脑图；
      // AI 失败不阻止删除，退回本地清理（只移除该文档的贡献）。
      let aiKnowledge: AiCourseKnowledge | undefined;
      let synthesisWarning: string | null = null;
      const remainingDigests = bundle.manifest.documents
        .filter(
          (item) =>
            item.includedInCourse &&
            item.id !== document.id &&
            bundle.digests[item.id],
        )
        .map((item) => bundle.digests[item.id]);
      if (document.includedInCourse && remainingDigests.length > 0) {
        try {
          const glossary = await active.storage.loadGlossary?.() ?? EMPTY_GLOSSARY;
          const provider = createKnowledgeProviderForSettings(
            loadKnowledgeSettings(),
          );
          setMessage('AI 正在基于剩余资料重新综合课程总总结与总脑图…');
          aiKnowledge = await provider.synthesizeCourseKnowledge({
            onDiagnostic,
            onStage: (stage, detail) => setMessage(knowledgeStageMessage(stage, detail)),
            glossary,
            courseId: bundle.manifest.id,
            courseName: bundle.manifest.name,
            digests: remainingDigests,
            userNodeLabels: bundle.knowledge.nodes
              .filter((node) => node.ownership === 'user')
              .map((node) => node.label),
          });
        } catch (synthesisError) {
          synthesisWarning = describeKnowledgeError(synthesisError);
        }
      }
      const next = await backgroundRef.current!.mutate(active.id, storage => storage.removeDocument(
        document.id,
        bundle.manifest.revision,
        aiKnowledge,
      ));
      setEntryBundle(active.id, next);
      if (synthesisWarning) {
        setMessage(
          `已删除“${document.fileName}”，但 AI 重新综合课程成果失败：${synthesisWarning}。课程总总结中来自它的内容已移除。`,
        );
      } else if (aiKnowledge) {
        setMessage(
          `已删除“${document.fileName}”，AI 已基于剩余 ${remainingDigests.length} 份 PDF 重新综合课程总总结和总脑图。`,
        );
      } else {
        setMessage(`已删除“${document.fileName}”及其总结和脑图成果。`);
      }
    } catch (deleteError) {
      setError(describeKnowledgeError(deleteError));
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  };

  const deleteCourseEntry = async (entry: CourseEntry) => {
    if (entry.bundle?.manifest.documents.some(doc => processingIsActive(doc.processing))) {
      setError('请在本课程后台整理结束后删除课程。'); return;
    }
    setBusy(true);
    setError(null);
    try {
      await backgroundRef.current!.mutate(entry.id, async (storage, current) => {
        if (current.manifest.documents.some(doc => processingIsActive(doc.processing)))
          throw new Error('请在本课程后台整理结束后删除课程。');
        await storage.deleteCourse();
      });
      backgroundRef.current!.unregister(entry.id);
      removeTaskCourse(entry.id);
      if (!isDesktop && entry.handle) await removeRecentCourse(entry.id);
      const remaining = entries.filter((item) => item.id !== entry.id);
      setEntries(remaining);
      if (activeId === entry.id) setActiveId(remaining[0]?.id ?? null);
      setMessage(`已删除课程“${entry.name}”。`);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : '删除课程失败。',
      );
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  };

  const sourceDocuments = useMemo(
    () =>
      new Map(
        bundle?.manifest.documents.map((document) => [document.id, document]),
      ),
    [bundle?.manifest.documents],
  );

  const askFromArtifact = (text: string, sources: SourceReference[] = []) => {
    if (!active || !bundle) return;
    const source = sources.find(item => sourceDocuments.has(item.documentId));
    const document = source ? sourceDocuments.get(source.documentId) : bundle.manifest.documents.find(item => item.includedInCourse) ?? bundle.manifest.documents[0];
    if (document) void openDocumentForEntry(active, document, source?.pageStart, false, text);
  };
  const saveArtifactNote = (text: string, sources: SourceReference[] = []) => {
    if (!active) return Promise.reject(new Error('请先选择课程。'));
    return appendStudyNote(active.storage, {text, sources});
  };

  useEffect(() => {
    if (!onControlReady) return;
    const toControlItem = (entry: CourseEntry): CourseControlItem => ({
      id: entry.id,
      name: entry.name,
      documents: entry.bundle?.manifest.documents.map((document) => ({
        id: document.id,
        fileName: document.fileName,
        pageCount: document.pageCount,
        status: document.status,
        hasSummary: document.hasSummary,
        hasMindmap: document.hasMindmap,
        includedInCourse: document.includedInCourse,
        processing: document.processing,
      })) ?? [],
    });
    const selectCourse = (
      args: Record<string, unknown>,
      required: boolean,
    ): CourseEntry => {
      const locator = readCourseLocator(args, required);
      if (!locator) {
        const current = entries.find((entry) => entry.id === activeId);
        if (!current) throw new Error('当前没有选中的课程。');
        return current;
      }
      return locateEntity(
        entries,
        locator,
        { id: (entry) => entry.id, name: (entry) => entry.name },
        '课程',
      );
    };
    const booleanOption = (
      args: Record<string, unknown>,
      key: keyof ImportOptions,
      fallback: boolean,
    ) => {
      const value = args[key];
      if (value === undefined) return fallback;
      if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值。`);
      return value;
    };
    const selectDocument = (
      entry: CourseEntry,
      args: Record<string, unknown>,
    ): DocumentRecord => {
      if (!entry.bundle) throw new Error('目标课程当前无法读取。');
      return locateEntity(
        entry.bundle.manifest.documents,
        readDocumentLocator(args),
        { id: (item) => item.id, name: (item) => item.fileName },
        'PDF',
      );
    };
    const requiredText = (
      args: Record<string, unknown>,
      key: string,
      maximumLength: number,
    ): string => {
      const value = args[key];
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.trim().length > maximumLength
      ) {
        throw new Error(`${key} 必须是 1–${maximumLength} 个字符。`);
      }
      return value.trim();
    };
    const readChatScope = (args: Record<string, unknown>): ChatScope => {
      const value = args.scope ?? 'page';
      if (value !== 'page' && value !== 'document') {
        throw new Error('scope 必须是 page 或 document。');
      }
      return value;
    };
    const runExclusive = async <T,>(task: () => Promise<T>): Promise<T> => {
      if (busy || controlTaskRef.current) {
        throw new Error('页语正在执行另一项课程任务，请稍后重试。');
      }
      controlTaskRef.current = true;
      setBusy(true);
      setError(null);
      try {
        return await task();
      } finally {
        controlTaskRef.current = false;
        setGenerationAbort(null);
        setBusy(false);
      }
    };
    const withSharedController = async <T,>(
      args: Record<string, unknown>,
      task: (controller: AbortController) => Promise<T>,
    ): Promise<T> => {
      const sharedTaskId =
        typeof args.sharedTaskId === 'string' && args.sharedTaskId
          ? args.sharedTaskId
          : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const controller = new AbortController();
      sharedActionControllersRef.current.set(sharedTaskId, controller);
      try {
        return await task(controller);
      } finally {
        if (
          sharedActionControllersRef.current.get(sharedTaskId) === controller
        ) {
          sharedActionControllersRef.current.delete(sharedTaskId);
        }
      }
    };
    const control: CourseLibraryControl = {
      getState: () => {
        const progress = currentImportProgress();
        return {
          loading,
          activeCourseId: activeId,
          courses: entries.map(toControlItem),
          ...(progress ? { importProgress: progress } : {}),
        };
      },
      openCourse: (args) => {
        if (loading) throw new Error('课程列表仍在加载，请稍后重试。');
        const entry = selectCourse(args, true);
        if (!entry.bundle) throw new Error('目标课程当前无法读取。');
        setActiveId(entry.id);
        return toControlItem(entry);
      },
      openDocument: async (args) => {
        if (busy || controlTaskRef.current) {
          throw new Error('页语正在执行另一项课程任务，请稍后重试。');
        }
        const entry = selectCourse(args, false);
        if (!entry.bundle) throw new Error('目标课程当前无法读取。');
        const document = locateEntity(
          entry.bundle.manifest.documents,
          readDocumentLocator(args),
          { id: (item) => item.id, name: (item) => item.fileName },
          'PDF',
        );
        const page = readPage(args, 1);
        if (page > document.pageCount) {
          throw new Error(`page 超出 PDF 页数（共 ${document.pageCount} 页）。`);
        }
        setActiveId(entry.id);
        controlTaskRef.current = true;
        try {
          await openDocumentForEntry(entry, document, page, true);
          return {
            courseId: entry.id,
            courseName: entry.name,
            documentId: document.id,
            fileName: document.fileName,
            page,
          };
        } finally {
          controlTaskRef.current = false;
        }
      },
      importPdf: async (args) => {
        if (busy || controlTaskRef.current) {
          throw new Error('页语正在执行另一项课程任务，请稍后重试。');
        }
        const entry = selectCourse(args, true);
        if (!entry.bundle) throw new Error('目标课程当前无法读取。');
        const fileName = args.fileName;
        const fileData = args.fileData;
        const lastModified = args.fileLastModified;
        if (
          typeof fileName !== 'string' ||
          !fileName.toLowerCase().endsWith('.pdf') ||
          !(fileData instanceof Uint8Array)
        ) {
          throw new Error('Electron 未提供有效的 PDF 文件内容。');
        }
        const file = new File([Uint8Array.from(fileData).buffer], fileName, {
          type: 'application/pdf',
          lastModified: typeof lastModified === 'number' ? lastModified : Date.now(),
        });
        const options: ImportOptions = {
          generateSummary: booleanOption(args, 'generateSummary', true),
          generateMindmap: booleanOption(args, 'generateMindmap', true),
          mergeIntoCourse: booleanOption(args, 'mergeIntoCourse', true),
          includeConversationInsights: true,
        };
        setActiveId(entry.id);
        setBusy(true);
        const controller = new AbortController();
        setGenerationAbort(controller);
        let latestMessage = '准备导入 PDF';
        controlTaskRef.current = true;
        try {
          const completion = await importPdfForEntry(
            entry,
            file,
            options,
            (progressMessage) => {
              latestMessage = progressMessage;
              setMessage(progressMessage);
            },
            controller.signal,
          );
          const awaitFingerprint = await sha256Hex(await file.arrayBuffer());
          const saved = (await entry.storage.load()).manifest.documents.find(doc => doc.fingerprint === awaitFingerprint);
          return {
            courseId: entry.id,
            courseName: entry.name,
            fileName,
            documentId: saved?.id,
            processing: saved?.processing,
            message: completion ?? `${latestMessage}；处理完成。`,
          };
        } finally {
          controlTaskRef.current = false;
          setGenerationAbort(null);
          setBusy(false);
        }
      },
      runSharedAction: async (name, args) => {
        if (loading) throw new Error('课程列表仍在加载，请稍后重试。');
        if (name === 'create_course') {
          return runExclusive(async () => {
            if (!desktopApi) throw new Error('当前环境不支持创建桌面课程。');
            const nameValue = requiredText(args, 'name', 120);
            const { directoryName } =
              await desktopApi.createCourseDirectory(nameValue);
            const storage = new DesktopCourseStorage(desktopApi, directoryName);
            const nextBundle = await storage.withWriteLock(() => storage.initialize(nameValue));
            const entry: CourseEntry = {
              id: nextBundle.manifest.id,
              name: nextBundle.manifest.name,
              updatedAt: nextBundle.manifest.updatedAt,
              storage,
              bundle: nextBundle,
              permission: 'granted',
            };
            setEntries((previous) => [
              entry,
              ...previous.filter((item) => item.id !== entry.id),
            ]);
            setActiveId(entry.id);
            setMessage(`课程“${entry.name}”已由共享端创建。`);
            return toControlItem(entry);
          });
        }

        const entry = selectCourse(args, true);
        if (!entry.bundle) throw new Error('目标课程当前无法读取。');
        setActiveId(entry.id);

        if (name === 'get_glossary') {
          return {
            glossary: (await entry.storage.loadGlossary?.()) ?? EMPTY_GLOSSARY,
          };
        }
        if (name === 'save_glossary') {
          return runExclusive(async () => {
            if (!entry.storage.saveGlossary) {
              throw new Error('当前课程存储不支持术语表。');
            }
            const glossary = parseGlossary(args.glossary);
            await entry.storage.saveGlossary(glossary);
            setMessage(`课程“${entry.name}”的术语表已更新。`);
            return { glossary };
          });
        }
        if (name === 'remove_course') {
          return runExclusive(async () => {
            await backgroundRef.current!.mutate(entry.id, async (storage, current) => {
              if (current.manifest.documents.some(item => processingIsActive(item.processing)))
                throw new Error('请在本课程后台整理结束后删除课程。');
              await storage.deleteCourse();
            });
            backgroundRef.current!.unregister(entry.id);
      removeTaskCourse(entry.id);
            setEntries((previous) =>
              previous.filter((item) => item.id !== entry.id),
            );
            setActiveId((current) =>
              current === entry.id
                ? entries.find((item) => item.id !== entry.id)?.id ?? null
                : current,
            );
            setMessage(`已删除课程“${entry.name}”。`);
            return { removed: true, courseId: entry.id };
          });
        }

        const document = selectDocument(entry, args);
        const page = readPage(args, 1);
        if (name === 'get_conversation') {
          return {
            conversation: await getSharedConversation({
              document,
              page,
              scope: readChatScope(args),
            }),
          };
        }
        if (name === 'clear_conversation') {
          return runExclusive(() =>
            clearSharedConversation({
              document,
              page,
              scope: readChatScope(args),
            }),
          );
        }
        if (name === 'translate_page') {
          return runExclusive(() =>
            withSharedController(args, async (controller) => {
              setGenerationAbort(controller);
              const translation = await translateSharedPage({
                storage: entry.storage,
                document,
                page,
                targetLanguage: requiredText(args, 'targetLanguage', 128),
                bypassCache: args.bypassCache === true,
                signal: controller.signal,
              });
              setMessage(
                `已为共享端翻译“${document.fileName}”第 ${page} 页。`,
              );
              return { translation };
            }),
          );
        }
        if (name === 'ask_document') {
          return runExclusive(() =>
            withSharedController(args, async (controller) => {
              setGenerationAbort(controller);
              return {
                conversation: await askSharedDocument({
                  storage: entry.storage,
                  document,
                  page,
                  scope: readChatScope(args),
                  question: requiredText(args, 'question', 8_000),
                  allowWebSearch: args.allowWebSearch !== false,
                  signal: controller.signal,
                }),
              };
            }),
          );
        }
        if (name === 'remove_document') {
          return runExclusive(async () => {
            const next = await backgroundRef.current!.mutate(entry.id, async (storage, current) => {
              const currentDocument = current.manifest.documents.find(
                (item) => item.id === document.id,
              );
              if (!currentDocument) throw new Error('这份 PDF 已不存在。');
              if (processingIsActive(currentDocument.processing)) {
                throw new Error('请在这份 PDF 后台整理结束后再删除。');
              }
              return storage.removeDocument(document.id, current.manifest.revision);
            });
            setEntryBundle(entry.id, next);
            setMessage(`已删除“${document.fileName}”及其成果。`);
            return { removed: true, documentId: document.id };
          });
        }
        if (name === 'regenerate_document') {
          return runExclusive(() => withSharedController(args, async (controller) => {
            setGenerationAbort(controller);
            // Keep the pre-analysis revision: a concurrent import or background
            // publication must invalidate this result instead of being overwritten.
            const current = await entry.storage.load();
            const glossary =
              (await entry.storage.loadGlossary?.()) ?? EMPTY_GLOSSARY;
            const file = await entry.storage.openPdf(document.id);
            const extracted = await extractPdfPages(file, {
              signal: controller.signal,
              recognizePage: makeOcrRecognizer(loadChatSettings()),
            });
            const digest = await createKnowledgeProviderForSettings(
              loadKnowledgeSettings(),
            ).analyzeDocument({
              signal: controller.signal,
              glossary,
              fingerprint: extracted.fingerprint,
              fileName: file.name,
              documentId: stableDocumentId(extracted.fingerprint),
              pages: extracted.pages,
              bypassCache: true,
            });
            if (controller.signal.aborted) throw new Error('生成已取消。');
            const next = await backgroundRef.current!.mutate(entry.id, storage => {
              if (controller.signal.aborted) throw new Error('生成已取消。');
              return storage.updateDocumentArtifacts(document.id, current.manifest.revision, digest);
            });
            setEntryBundle(entry.id, next);
            setMessage(`已重新生成“${document.fileName}”的总结和脑图。`);
            return { document: toControlItem({ ...entry, bundle: next }).documents.find((item) => item.id === document.id) };
          }));
        }
        if (name === 'regenerate_course') {
          return runExclusive(() => withSharedController(args, async (controller) => {
            setGenerationAbort(controller);
            const current = await entry.storage.load();
            const documents = current.manifest.documents.filter(
              (item) => item.includedInCourse && current.digests[item.id],
            );
            if (documents.length === 0) {
              throw new Error('课程中没有可用于重新生成的 PDF 成果。');
            }
            const glossary =
              (await entry.storage.loadGlossary?.()) ?? EMPTY_GLOSSARY;
            const aiKnowledge =
              await createKnowledgeProviderForSettings(
                loadKnowledgeSettings(),
              ).synthesizeCourseKnowledge({
                signal: controller.signal,
                glossary,
                courseId: current.manifest.id,
                courseName: current.manifest.name,
                digests: documents.map((item) => current.digests[item.id]),
                userNodeLabels: current.knowledge.nodes
                  .filter((node) => node.ownership === 'user')
                  .map((node) => node.label),
              });
            if (controller.signal.aborted) throw new Error('生成已取消。');
            const next = await backgroundRef.current!.mutate(entry.id, storage => {
              if (controller.signal.aborted) throw new Error('生成已取消。');
              return storage.mergeDocuments(documents.map(item => item.id), current.manifest.revision, aiKnowledge);
            });
            setEntryBundle(entry.id, next);
            setMessage(`课程“${entry.name}”的总总结和总脑图已重新生成。`);
            return { course: toControlItem({ ...entry, bundle: next }) };
          }));
        }
        throw new Error('不支持的共享操作。');
      },
      cancelSharedAction: (args) => {
        const sharedTaskId = args.sharedTaskId;
        if (typeof sharedTaskId !== 'string' || !sharedTaskId) {
          throw new Error('sharedTaskId 必须是非空字符串。');
        }
        const controller = sharedActionControllersRef.current.get(sharedTaskId);
        controller?.abort();
        return { cancelled: Boolean(controller) };
      },
    };
    onControlReady(control);
  });

  useEffect(
    () => () => {
      onControlReady?.(null);
    },
    [onControlReady],
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
              key={entry.id}
              type="button"
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${entry.id === activeId ? 'border-slate-200 bg-white shadow-sm' : 'border-transparent hover:bg-white'}`}
              onClick={() => setActiveId(entry.id)}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-100 font-bold text-violet-700">
                {entry.name.slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {entry.name}
                </span>
                <span className="mt-0.5 block text-[10px] text-slate-500">
                  {entry.bundle?.manifest.documents.length ?? 0} 份 PDF ·{' '}
                  {permissionLabel(entry.permission)}
                </span>
              </span>
            </button>
          ))}
        </div>
        {active && bundle ? <div className="my-3"><CourseGlossary key={active.id} storage={active.storage} bundle={bundle} disabled={busy}
                    onLocate={(documentId, page) => {
                      const document = bundle.manifest.documents.find((item) => item.id === documentId);
                      if (document) void openDocument(document, page);
                    }} /></div> : null}
        <div className="mt-auto rounded-xl border border-slate-200 bg-white p-4">
          {isDesktop ? (
            <>
              <p className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <ShieldCheck className="size-4 text-emerald-600" /> 固定工作区
              </p>
              <p className="mt-2 break-all text-[10px] leading-4 text-slate-500">
                {workspaceRoot ?? '正在准备工作区…'}
              </p>
              <Button
                variant="outline"
                size="xs"
                className="mt-3 w-full"
                onClick={() => void desktopApi?.revealWorkspace()}
              >
                <Folder className="size-3.5" /> 打开工作区文件夹
              </Button>
              <div className="mt-4 border-t border-slate-100 pt-4">
                <p className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <Globe2
                    className={`size-4 ${shareStatus.running ? 'text-emerald-600' : 'text-slate-400'}`}
                  />
                  局域网共享
                  <span
                    className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${shareStatus.running ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}
                  >
                    {shareStatus.running ? '运行中' : '已关闭'}
                  </span>
                </p>
                <p className="mt-2 text-[10px] leading-4 text-slate-500">
                  {shareStatus.running
                    ? `端口 ${shareStatus.port} · ${shareStatus.addresses.length} 个可访问地址`
                    : '用密码共享已有课程，并允许查看端把 PDF 安全导入主电脑。'}
                </p>
                <Button
                  variant="outline"
                  size="xs"
                  className="mt-3 w-full"
                  onClick={() => {
                    setShareError(null);
                    setShareOpen(true);
                  }}
                >
                  <Globe2 className="size-3.5" />
                  {shareStatus.running ? '查看共享状态' : '开启局域网共享'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <ShieldCheck className="size-4 text-emerald-600" />{' '}
                本地文件夹模式
              </p>
              <p className="mt-2 text-[10px] leading-4 text-slate-500">
                课程资料只写入你授权的目录。浏览器数据被清除后，重新连接原文件夹即可恢复。
              </p>
            </>
          )}
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
                请使用页语桌面版，或最新版桌面 Chrome / Edge
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
                一门课程可包含多份 PDF，并持续生成带页码来源的课程总结和脑图。
                {isDesktop
                  ? '课程数据保存在固定工作区，无需手动选择文件夹。'
                  : '文件夹是唯一可信数据源。'}
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Button onClick={() => setCreateOpen(true)}>
                  <FolderPlus /> 创建本地课程
                </Button>
                {!isDesktop ? (
                  <Button
                    variant="outline"
                    onClick={() => void connectHandle('existing')}
                  >
                    <FolderCheck /> 连接已有课程
                  </Button>
                ) : null}
              </div>
            </div>
          ) : active && !bundle ? (
            <div className="mx-auto mt-20 max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <Folder className="mx-auto size-9 text-violet-600" />
              <h1 className="mt-4 text-xl font-semibold">{active.name}</h1>
              <p className="mt-2 text-sm text-slate-500">
                {isDesktop
                  ? '课程目录内容异常，请检查工作区中的 course.json。'
                  : active.permission === 'error'
                    ? '课程文件夹内容异常，请重新连接原目录。'
                    : '浏览器需要你再次确认这个文件夹的读写权限。'}
              </p>
              <div className="mt-7 flex justify-center gap-3">
                {!isDesktop && active.permission !== 'error' ? (
                  <Button
                    onClick={() => void reauthorize(active)}
                    disabled={busy}
                  >
                    <FolderCheck /> 重新授权
                  </Button>
                ) : null}
                {!isDesktop ? (
                  <Button
                    variant="outline"
                    onClick={() => void connectHandle('existing')}
                    disabled={busy}
                  >
                    重新连接原文件夹
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  className="text-rose-700"
                  onClick={() =>
                    setPendingDelete({ kind: 'course', entry: active })
                  }
                  disabled={busy}
                >
                  <Trash2 /> 删除课程
                </Button>
              </div>
            </div>
          ) : bundle && active ? (
            <>
              <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
                <div>
                  <p className="text-xs text-slate-500">
                    {isDesktop ? '工作区课程' : '本地课程'} /{' '}
                    {bundle.manifest.name}
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
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-rose-700"
                    onClick={() =>
                      setPendingDelete({ kind: 'course', entry: active })
                    }
                    disabled={busy}
                  >
                    <Trash2 /> 删除课程
                  </Button>
                  <span className="md:hidden"><CourseGlossary key={active.id} storage={active.storage} bundle={bundle} disabled={busy}
                    onLocate={(documentId, page) => {
                      const document = bundle.manifest.documents.find((item) => item.id === documentId);
                      if (document) void openDocument(document, page);
                    }} /></span>
                  <Button size="sm" onClick={() => setImportOpen(true)}>
                    <FilePlus2 /> 导入 PDF
                  </Button>
                </div>
              </div>

              {isDesktop && active.storage.publishTranslation ? (
                <div className="mt-5 flex flex-col gap-3 rounded-xl border border-violet-200 bg-violet-50/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold text-violet-900">
                      共享已生成的 PDF 页面译文
                    </p>
                    <p className="mt-1 text-[11px] leading-5 text-violet-800/80">
                      首次发布会在课程目录新增 Translations 文件，不修改
                      PDF、course.json、总结、脑图或笔记。
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 border-violet-300 bg-white text-violet-800"
                    onClick={() => void publishExistingTranslations()}
                    disabled={busy}
                  >
                    {busy ? <LoaderCircle className="animate-spin" /> : null}
                    发布已有译文
                  </Button>
                </div>
              ) : null}

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

              {bundle.manifest.documents.length > 0 ? <section aria-label="继续学习" className="mt-6 rounded-2xl border border-blue-100 bg-blue-50/60 p-5">
                <div className="flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold text-slate-900">继续学习</h2><p className="mt-1 text-xs text-slate-500">{recentDocuments.length ? '从上次阅读的位置继续。' : '打开一份资料开始阅读，整理成果会在后台更新。'}</p></div><Button variant="outline" size="sm" onClick={() => setStudyTab('documents')}>查看全部资料</Button></div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">{(recentDocuments.length ? recentDocuments : selectStudyDocuments(bundle.manifest.documents, [], '', 'recent-import').slice(0,3)).map(document => {
                  const progress = readingProgress.find(item => item.fingerprint === document.fingerprint);
                  const page = Math.min(document.pageCount || 1, Math.max(1, progress?.lastPage ?? 1));
                  return <button key={document.id} type="button" className="rounded-xl border border-blue-100 bg-white p-4 text-left hover:border-blue-300" onClick={() => void openDocument(document)}><span className="block truncate text-sm font-semibold">{document.fileName}</span><span className="mt-2 block text-xs text-slate-500">{progress ? `上次读到第 ${page} / ${document.pageCount} 页` : `${document.pageCount} 页 · 开始阅读`}</span>{progress ? <progress aria-label={`${document.fileName}阅读位置`} className="mt-3 h-1 w-full" max={document.pageCount || 1} value={page} /> : null}</button>;
                })}</div>
                {bundle.manifest.documents.some(document => document.processing?.status === 'failed') ? <Button className="mt-3 text-amber-800" variant="link" size="sm" onClick={() => setStudyTab('documents')}>有整理任务需要处理，查看并重试 →</Button> : null}
                {bundle.manifest.documents.some(document => (document.hasSummary || document.hasMindmap) && !readingProgress.some(progress => progress.fingerprint === document.fingerprint)) ? <p className="mt-3 text-xs text-blue-700">有已整理好的资料尚未开始阅读，可在 PDF 资料中打开。</p> : null}
              </section> : null}

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
                value={studyTab}
                onValueChange={value => setStudyTab(String(value))}
                className="mt-5 gap-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
              >
                <TabsList
                  variant="line"
                  className="h-13 w-full justify-start gap-3 overflow-x-auto border-b border-slate-200 px-4"
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
                  <TabsTrigger value="notes" className="flex-none px-3">课程笔记</TabsTrigger>
                  <TabsTrigger value="history" className="flex-none px-3">成果历史</TabsTrigger>
                </TabsList>

                <TabsContent value="summary" className="min-h-[520px]">
                  {includedCount === 0 ? (
                    <div className="flex min-h-[500px] flex-col items-center justify-center px-6 text-center">
                      <Sparkles className="size-8 text-violet-500" />
                      <h2 className="mt-5 text-base font-semibold">
                        课程总结尚未包含资料
                      </h2>
                      <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">
                        {bundle.manifest.documents.length ? '资料已经保存，可以立即阅读。整理中的资料完成后会自动汇总；仅保存的资料可在 PDF 资料中选择“AI 并入课程”。' : '导入第一份 PDF 后，可生成独立成果，并将内部摘要合并到课程总总结和总脑图。'}
                      </p>
                      <Button
                        className="mt-6"
                        onClick={() => bundle.manifest.documents.length ? setStudyTab('documents') : setImportOpen(true)}
                      >
                        {bundle.manifest.documents.length ? <><BookOpen /> 阅读资料与查看整理进度</> : <><FilePlus2 /> 导入第一份 PDF</>}
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
                        <MarkdownActions content={renderCourseSummary(bundle.manifest, bundle.knowledge)} fileName={`${bundle.manifest.name}-课程总结.md`} />
                        <div className="mt-5">
                          <KnowledgeMarkdown>{bundle.knowledge.nodes.find((node) => node.kind === 'course')?.description ?? ''}</KnowledgeMarkdown>
                        </div>
                        <div className="mt-9 space-y-9">
                          {bundle.knowledge.nodes
                            .filter((node) => node.kind !== 'course')
                            .map((node, index) => (
                              <KnowledgeSection key={node.id} title={`${index + 1}. ${node.label}`} initiallyOpen={index < 2}>
                                <KnowledgeMarkdown>{node.description}</KnowledgeMarkdown>
                                <StudyActions onAsk={() => askFromArtifact(`请解释“${node.label}”：${node.description}`, node.sources)} onSave={() => saveArtifactNote(`${node.label}\n\n${node.description}`, node.sources)} />
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {node.sources.map((source) => (
                                    <Button
                                      key={`${source.documentId}-${source.pageStart}-${source.pageEnd}-${source.type}`}
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
                              </KnowledgeSection>
                            ))}
                          {bundle.knowledge.evidence?.length ? <KnowledgeSection title="关键元素（来源原文保留）">
                            {bundle.knowledge.evidence.map((item, index) => <div key={index}>
                              <KnowledgeMarkdown>{item.text}</KnowledgeMarkdown>
                              {item.sources.map((source, sourceIndex) => <Button key={sourceIndex} variant="outline" size="xs" onClick={() => {
                                const document = sourceDocuments.get(source.documentId);
                                if (document) void openDocument(document, source.pageStart);
                              }}>{source.fileName} · 第 {source.pageStart} 页</Button>)}
                            </div>)}
                          </KnowledgeSection> : null}
                          {bundle.knowledge.conflicts.map((conflict) => <KnowledgeSection key={conflict.id} title={`资料冲突：${bundle.knowledge.nodes.find((node) => node.id === conflict.nodeId)?.label ?? conflict.nodeId}`}>
                            {conflict.descriptions.map((description, index) => <KnowledgeMarkdown key={index}>{description}</KnowledgeMarkdown>)}
                            {conflict.sources.map((source, index) => <Button key={index} variant="outline" size="xs" onClick={() => {
                              const document = sourceDocuments.get(source.documentId);
                              if (document) void openDocument(document, source.pageStart);
                            }}>{source.fileName} · 第 {source.pageStart} 页</Button>)}
                          </KnowledgeSection>)}
                          {bundle.knowledge.unresolvedQuestions?.length ? <KnowledgeSection title="待解决问题">
                            {bundle.knowledge.unresolvedQuestions.map((question, index) => <div key={index}><KnowledgeMarkdown>{question}</KnowledgeMarkdown><StudyActions onAsk={() => askFromArtifact(question)} onSave={() => saveArtifactNote(question)} /></div>)}
                          </KnowledgeSection> : null}
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
                    onAskQuestion={({text,sources}) => askFromArtifact(text,sources)}
                    onSaveNote={saveArtifactNote}
                    onOpenSource={(documentId, page) => {
                      const document = sourceDocuments.get(documentId);
                      if (document) void openDocument(document, page);
                    }}
                  />
                </TabsContent>

                <TabsContent value="notes" keepMounted><CourseNotesPanel key={active.id} storage={active.storage} courseId={bundle.manifest.id} /></TabsContent>
                <TabsContent value="history"><CourseHistoryPanel key={active.id} storage={active.storage} current={bundle.knowledge} currentSummary={renderCourseSummary(bundle.manifest, bundle.knowledge)} /></TabsContent>

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
                  {bundle.manifest.documents.length ? <div className="mt-5 flex flex-wrap gap-3"><Input aria-label="搜索 PDF 文件名" placeholder="搜索 PDF 文件名…" className="max-w-sm" value={documentQuery} onChange={event => setDocumentQuery(event.target.value)} /><select aria-label="资料排序" className="rounded-lg border border-slate-200 bg-white px-3 text-sm" value={documentSort} onChange={event => setDocumentSort(event.target.value as DocumentSort)}><option value="recent-read">最近阅读</option><option value="recent-import">最近导入</option><option value="name">文件名</option></select><span className="self-center text-xs text-slate-500">{visibleDocuments.length} 份资料</span></div> : null}
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
                      {!visibleDocuments.length ? <p className="p-6 text-center text-sm text-slate-500">没有匹配的 PDF，请尝试其他文件名。</p> : null}
                      {visibleDocuments.map((document) => (
                        <div
                          key={document.id}
                          className="grid gap-4 bg-white px-4 py-4 lg:grid-cols-[minmax(220px,1fr)_190px_190px_auto] lg:items-center"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-[10px] font-bold text-rose-700">
                              PDF
                            </span>
                            <div className="min-w-0">
                              <span className="block truncate text-sm font-semibold">
                                {document.fileName}
                              </span>
                              <span className="mt-1 block text-[10px] text-slate-500">
                                {document.pageCount} 页 · 已复制到课程文件夹
                              </span>
                              <DocumentProcessingStatus processing={document.processing} onRetry={() => {
                                if (!busy && active) void backgroundRef.current!.retry(active.id, document.id).catch(error => setError(String(error)));
                              }} />
                            </div>
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
                            {document.hasSummary || document.hasMindmap ? (
                              <Check className="size-4 text-emerald-600" />
                            ) : (
                              <span className="size-4 text-center">—</span>
                            )}
                            {artifactStatus(document)}
                          </span>
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => void openDocument(document)}
                            >
                              <BookOpen /> 打开
                            </Button>
                            {!document.includedInCourse && !document.processing ? (
                              <Button
                                size="xs"
                                onClick={() =>
                                  void mergeDocumentWithAi(document)
                                }
                                disabled={busy || backgroundBusy || Boolean(document.processing)}
                              >
                                <GitMerge /> AI 并入课程
                              </Button>
                            ) : null}
                            {!document.hasSummary || !document.hasMindmap ? (
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() =>
                                  void regenerateDocument(document)
                                }
                                disabled={busy || backgroundBusy || Boolean(document.processing)}
                              >
                                AI 生成成果
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() =>
                                  void regenerateDocument(document)
                                }
                                disabled={busy || backgroundBusy || Boolean(document.processing)}
                              >
                                重新生成
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="xs"
                              className="text-rose-700"
                              onClick={() =>
                                setPendingDelete({
                                  kind: 'document',
                                  document,
                                })
                              }
                              disabled={busy || backgroundBusy || Boolean(document.processing)}
                            >
                              <Trash2 /> 删除
                            </Button>
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

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>局域网共享</DialogTitle>
            <DialogDescription>
              Windows 电脑可通过浏览器使用共享阅读、翻译、AI 答疑和课程功能；
              API Key 与实际处理始终留在主电脑。
            </DialogDescription>
          </DialogHeader>
          {shareStatus.running ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
                  <Globe2 className="size-4" />
                  共享服务运行中 · 端口 {shareStatus.port}
                </p>
                <p className="mt-2 text-xs leading-5 text-emerald-700">
                  请保持页语运行、主电脑联网且不休眠。地址使用普通
                  HTTP，密码和资料传输未加密。
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-700">
                  可供其他电脑访问的地址
                </p>
                {shareStatus.addresses.length > 0 ? (
                  <div className="mt-2 space-y-2">
                    {shareStatus.addresses.map((address) => (
                      <div
                        key={address}
                        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
                      >
                        <code className="min-w-0 flex-1 break-all text-xs text-slate-700">
                          {address}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="复制访问地址"
                          onClick={() => void copyShareAddress(address)}
                        >
                          <Copy />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                    已绑定局域网端口，但暂未检测到非回环网卡地址。请检查主电脑的校园网连接和系统防火墙。
                  </p>
                )}
                {shareCopied ? (
                  <p className="mt-2 text-xs text-emerald-700">地址已复制。</p>
                ) : null}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShareOpen(false)}>
                  关闭窗口
                </Button>
                <Button
                  className="bg-rose-600 text-white hover:bg-rose-700"
                  onClick={() => void stopLanShare()}
                  disabled={shareBusy}
                >
                  {shareBusy ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Globe2 />
                  )}{' '}
                  停止共享
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <label className="block space-y-2">
                <span className="text-xs font-semibold text-slate-700">
                  访问密码
                </span>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={sharePassword}
                  onChange={(event) => setSharePassword(event.target.value)}
                  placeholder="至少 6 个字符"
                  autoFocus
                />
              </label>
              <label className="block space-y-2">
                <span className="text-xs font-semibold text-slate-700">
                  服务端口
                </span>
                <Input
                  type="number"
                  min={1024}
                  max={65535}
                  value={sharePort}
                  onChange={(event) => setSharePort(event.target.value)}
                />
              </label>
              <fieldset className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
                <legend className="px-1 text-xs font-semibold text-slate-700">
                  Windows 端权限
                </legend>
                <label className="flex items-start gap-2 text-xs leading-5 text-slate-700">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={sharePermissions.importPdf}
                    onChange={(event) =>
                      setSharePermissions((current) => ({
                        ...current,
                        importPdf: event.target.checked,
                      }))
                    }
                  />
                  <span>允许上传 PDF 到现有课程</span>
                </label>
                <label className="flex items-start gap-2 text-xs leading-5 text-slate-700">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={sharePermissions.ai}
                    onChange={(event) =>
                      setSharePermissions((current) => ({
                        ...current,
                        ai: event.target.checked,
                      }))
                    }
                  />
                  <span>允许翻译、AI 答疑和重新生成成果</span>
                </label>
                <label className="flex items-start gap-2 text-xs leading-5 text-rose-700">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={sharePermissions.manage}
                    onChange={(event) =>
                      setSharePermissions((current) => ({
                        ...current,
                        manage: event.target.checked,
                      }))
                    }
                  />
                  <span>
                    允许创建课程、编辑术语表以及删除课程/PDF（高权限）
                  </span>
                </label>
              </fieldset>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-600">
                <p className="font-semibold text-slate-700">使用范围与保护</p>
                <p className="mt-1">
                  仅绑定主电脑的局域网服务端口；查看端可读取合法课程，并通过
                  CSRF 校验执行上面选中的功能。保存和 AI 整理由主电脑执行；
                  未勾选的能力会由服务端拒绝。普通 HTTP 不提供加密传输，请仅在可信校园网使用。
                </p>
              </div>
              {shareError ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
                  {shareError}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShareOpen(false)}
                  disabled={shareBusy}
                >
                  取消
                </Button>
                <Button
                  onClick={() => void startLanShare()}
                  disabled={shareBusy || sharePassword.length < 6}
                >
                  {shareBusy ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Globe2 />
                  )}{' '}
                  开启共享
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>创建本地课程</DialogTitle>
            <DialogDescription>
              {isDesktop
                ? '课程将在固定工作区中获得独立目录，作为唯一可信数据来源。'
                : '所选文件夹将成为这门课程的唯一可信数据来源。'}
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
            {isDesktop ? '工作区位置见左侧边栏。' : ''}
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
              {isDesktop ? '创建课程' : '选择文件夹并创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          {pendingDelete?.kind === 'document' ? (
            <>
              <DialogHeader>
                <DialogTitle>删除这份 PDF？</DialogTitle>
                <DialogDescription>
                  将从课程中删除“{pendingDelete.document.fileName}
                  ”：PDF 文件和它的总结、脑图成果会一并删除。已纳入课程时，AI
                  会基于剩余资料重新综合课程总总结和总脑图（未配置知识库 AI
                  则仅移除它的内容）。此操作不可撤销。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setPendingDelete(null)}
                  disabled={busy}
                >
                  取消
                </Button>
                <Button
                  className="bg-rose-600 text-white hover:bg-rose-700"
                  onClick={() => void deleteDocument(pendingDelete.document)}
                  disabled={busy}
                >
                  {busy ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                  删除 PDF
                </Button>
              </DialogFooter>
            </>
          ) : pendingDelete ? (
            <>
              <DialogHeader>
                <DialogTitle>删除整门课程？</DialogTitle>
                <DialogDescription>
                  {isDesktop
                    ? `工作区中的课程目录“${pendingDelete.entry.name}”将先移入系统回收站（无法回收时直接删除），课程内的 PDF、总结、脑图与笔记会一并删除。`
                    : `将清空课程文件夹“${pendingDelete.entry.name}”中的全部文件（course.json、PDF、总结、脑图等）并从课程列表移除，文件夹本身会保留。此操作不可撤销。`}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setPendingDelete(null)}
                  disabled={busy}
                >
                  取消
                </Button>
                <Button
                  className="bg-rose-600 text-white hover:bg-rose-700"
                  onClick={() => void deleteCourseEntry(pendingDelete.entry)}
                  disabled={busy}
                >
                  {busy ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                  删除课程
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {generationAbort && busy ? <Button onClick={() => generationAbort?.abort()} className="fixed right-6 bottom-6 z-50">取消生成</Button> : null}
      {retryGeneration && generationCourseId === activeId && !busy ? <Button onClick={retryGeneration} className="fixed right-6 bottom-6 z-50">重试生成（保留旧成果）</Button> : null}
      {generationDiagnostics.length > 0 && generationCourseId === activeId ? <details className="fixed bottom-6 left-6 z-40 max-h-60 max-w-xl overflow-auto rounded border bg-white p-2 text-xs"><summary>分层生成诊断（{generationDiagnostics.length}）</summary><pre className="whitespace-pre-wrap">{JSON.stringify(generationDiagnostics, null, 2)}</pre></details> : null}
      <CourseImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={importPdf}
        onBatchStart={() => backgroundRef.current!.hold()}
        onBatchEnd={() => backgroundRef.current!.release()}
      />
    </div>
  );
}
