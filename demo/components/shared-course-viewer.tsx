'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  CircleAlert,
  FileText,
  LogOut,
  Network,
  RefreshCw,
  ShieldCheck,
  Wifi,
} from 'lucide-react';

import { SharedPdfReader } from '@/components/shared-pdf-reader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  CourseKnowledge,
  CourseManifest,
  DocumentDigest,
  DocumentRecord,
  SourceReference,
} from '@/lib/course-storage/types';
import {
  getSharedSession,
  listSharedCourses,
  loadSharedCourse,
  loadSharedPdf,
  loginToSharedService,
  logoutFromSharedService,
  SharedApiError,
  type SharedCourseDetail,
  type SharedCourseListItem,
} from '@/lib/lan-share-api';
import { formatSource } from '@/lib/knowledge/artifact-renderer';
import { KnowledgeMindmap } from '@/components/knowledge-mindmap';

function updatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更新时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function describeApiError(error: unknown): string {
  if (error instanceof SharedApiError) return error.message;
  return error instanceof Error ? error.message : '共享服务暂时无法处理请求。';
}

function EmptyResult({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-80 flex-col items-center justify-center px-8 text-center">
      <FileText className="size-8 text-slate-300" />
      <h2 className="mt-4 text-sm font-semibold text-slate-700">{title}</h2>
      <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">
        {description}
      </p>
    </div>
  );
}

function sourceButton(
  source: SourceReference,
  index: number,
  onOpenSource: (documentId: string, page: number) => void,
) {
  return (
    <div
      key={`${source.documentId}-${source.pageStart}-${source.type}-${index}`}
      className="rounded-xl border border-slate-200 bg-slate-50 p-3"
    >
      <p className="text-[11px] leading-5 text-slate-600">
        {formatSource(source)}
      </p>
      {source.type === 'pdf' && source.documentId ? (
        <Button
          variant="link"
          size="xs"
          className="mt-1 h-auto px-0 text-blue-700"
          onClick={() => onOpenSource(source.documentId, source.pageStart)}
        >
          打开文档并跳转 →
        </Button>
      ) : null}
    </div>
  );
}

function CourseSummary({
  knowledge,
  onOpenSource,
}: {
  knowledge: CourseKnowledge;
  onOpenSource: (documentId: string, page: number) => void;
}) {
  const nodes = knowledge.nodes.filter((node) => node.kind !== 'course');
  if (nodes.length === 0) {
    return (
      <EmptyResult
        title="课程总结还是空的"
        description="主电脑尚未将任何 PDF 纳入课程知识库。查看端不会发起生成。"
      />
    );
  }
  return (
    <article className="mx-auto max-w-4xl px-6 py-7 sm:px-10">
      <p className="flex items-center gap-2 text-xs font-bold tracking-[0.12em] text-violet-600 uppercase">
        <FileText className="size-4" /> 课程总结 · 只读
      </p>
      <p className="mt-2 text-xs text-slate-500">
        版本 {knowledge.version} · 更新于 {updatedAt(knowledge.updatedAt)}
      </p>
      <div className="mt-8 space-y-8">
        {nodes.map((node) => (
          <section key={node.id}>
            <h2 className="text-lg font-semibold text-slate-900">
              {node.label}
            </h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              {node.description}
            </p>
            {node.sources.length > 0 ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {node.sources.map((source, index) =>
                  sourceButton(source, index, onOpenSource),
                )}
              </div>
            ) : null}
          </section>
        ))}
      </div>
      {knowledge.conflicts.length > 0 ? (
        <section className="mt-10 border-t border-slate-200 pt-7">
          <h2 className="text-sm font-semibold text-slate-900">资料冲突</h2>
          <div className="mt-4 space-y-5">
            {knowledge.conflicts.map((conflict) => (
              <div key={conflict.id}>
                <p className="text-sm font-medium text-slate-800">
                  {conflict.nodeId}
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-600">
                  {conflict.descriptions.map((description) => (
                    <li key={description}>{description}</li>
                  ))}
                </ul>
                {conflict.sources.length > 0 ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {conflict.sources.map((source, index) =>
                      sourceButton(source, index, onOpenSource),
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}

function CourseDocuments({
  manifest,
  digests,
  onOpenDocument,
}: {
  manifest: CourseManifest;
  digests: Record<string, DocumentDigest>;
  onOpenDocument: (document: DocumentRecord) => void;
}) {
  if (manifest.documents.length === 0) {
    return (
      <EmptyResult
        title="课程中还没有 PDF"
        description="主电脑新增资料后，点击刷新即可看到最新课程内容。"
      />
    );
  }
  return (
    <div className="p-5 sm:p-7">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-slate-900">课程资料</h2>
        <p className="mt-1 text-xs text-slate-500">
          PDF 和主电脑已有成果均为只读。
        </p>
      </div>
      <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
        {manifest.documents.map((document) => (
          <div
            key={document.id}
            className="grid gap-4 bg-white px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-[10px] font-bold text-rose-700">
                PDF
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-slate-800">
                  {document.fileName}
                </span>
                <span className="mt-1 block text-[10px] text-slate-500">
                  {document.pageCount} 页 ·{' '}
                  {document.hasSummary ? '有 PDF 总结' : '无 PDF 总结'} ·{' '}
                  {document.hasMindmap ? '有 PDF 脑图' : '无 PDF 脑图'}
                </span>
                {digests[document.id] ? (
                  <span className="mt-1 block text-[10px] text-emerald-700">
                    成果已就绪
                  </span>
                ) : null}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onOpenDocument(document)}
            >
              <BookOpen /> 打开 PDF
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SharedCourseDetail({
  detail,
  onOpenSource,
  onOpenDocument,
}: {
  detail: SharedCourseDetail;
  onOpenSource: (documentId: string, page: number) => void;
  onOpenDocument: (document: DocumentRecord) => void;
}) {
  return (
    <Tabs defaultValue="summary" className="min-h-0 flex-1 gap-0">
      <TabsList className="mx-5 mt-4 sm:mx-7">
        <TabsTrigger value="summary">
          <FileText /> 课程总结
        </TabsTrigger>
        <TabsTrigger value="mindmap">
          <Network /> 课程脑图
        </TabsTrigger>
        <TabsTrigger value="documents">
          <BookOpen /> PDF 资料
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="summary"
        className="min-h-0 flex-1 overflow-y-auto data-[hidden]:hidden"
      >
        <CourseSummary
          knowledge={detail.knowledge}
          onOpenSource={onOpenSource}
        />
      </TabsContent>
      <TabsContent
        value="mindmap"
        className="min-h-0 flex-1 overflow-y-auto data-[hidden]:hidden"
      >
        {detail.knowledge.nodes.some((node) => node.kind !== 'course') ? (
          <KnowledgeMindmap
            knowledge={detail.knowledge}
            onOpenSource={onOpenSource}
          />
        ) : (
          <EmptyResult
            title="课程脑图还是空的"
            description="主电脑尚未生成课程脑图。查看端不会发起生成。"
          />
        )}
      </TabsContent>
      <TabsContent
        value="documents"
        className="min-h-0 flex-1 overflow-y-auto data-[hidden]:hidden"
      >
        <CourseDocuments
          manifest={detail.manifest}
          digests={detail.digests}
          onOpenDocument={onOpenDocument}
        />
      </TabsContent>
    </Tabs>
  );
}

export function SharedCourseViewer() {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [courses, setCourses] = useState<SharedCourseListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SharedCourseDetail | null>(null);
  const [reader, setReader] = useState<{
    file: File;
    document: DocumentRecord;
    initialPage: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestVersionRef = useRef(0);

  const signedOut = useCallback((message?: string) => {
    requestVersionRef.current += 1;
    setAuthenticated(false);
    setCourses([]);
    setSelectedId(null);
    setDetail(null);
    setReader(null);
    setRefreshing(false);
    if (message) setError(message);
  }, []);
  const sessionExpired = useCallback(
    () => signedOut('登录已过期或共享服务已停止，请重新登录。'),
    [signedOut],
  );

  const handleRequestError = (requestError: unknown) => {
    if (requestError instanceof SharedApiError && requestError.status === 401) {
      signedOut('登录已过期或共享服务已停止，请重新登录。');
      return;
    }
    setError(describeApiError(requestError));
  };

  const refresh = async (preferredId = selectedId) => {
    const requestVersion = ++requestVersionRef.current;
    setRefreshing(true);
    setError(null);
    setDetail(null);
    setReader(null);
    try {
      const result = await listSharedCourses();
      if (requestVersion !== requestVersionRef.current) return;
      setCourses(result.courses);
      const nextId = result.courses.some((course) => course.id === preferredId)
        ? preferredId
        : (result.courses[0]?.id ?? null);
      setSelectedId(nextId);
      if (nextId) {
        const nextDetail = await loadSharedCourse(nextId);
        if (requestVersion !== requestVersionRef.current) return;
        setDetail(nextDetail);
      } else {
        setDetail(null);
      }
    } catch (requestError) {
      if (requestVersion !== requestVersionRef.current) return;
      handleRequestError(requestError);
    } finally {
      if (requestVersion === requestVersionRef.current) setRefreshing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await getSharedSession();
        if (cancelled) return;
        setAuthenticated(true);
        await refresh();
      } catch (requestError) {
        if (
          !cancelled &&
          !(
            requestError instanceof SharedApiError &&
            requestError.status === 401
          )
        ) {
          setError(describeApiError(requestError));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The initial authentication check intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDocument = async (document: DocumentRecord, initialPage = 1) => {
    if (!selectedId) return;
    const courseId = selectedId;
    const requestVersion = ++requestVersionRef.current;
    setRefreshing(true);
    setError(null);
    setReader(null);
    try {
      const file = await loadSharedPdf(
        courseId,
        document.id,
        document.fileName,
      );
      if (requestVersion !== requestVersionRef.current) return;
      setReader({ file, document, initialPage });
    } catch (requestError) {
      if (requestVersion !== requestVersionRef.current) return;
      handleRequestError(requestError);
    } finally {
      if (requestVersion === requestVersionRef.current) setRefreshing(false);
    }
  };

  const selectCourse = async (course: SharedCourseListItem) => {
    const requestVersion = ++requestVersionRef.current;
    setSelectedId(course.id);
    setDetail(null);
    setReader(null);
    setRefreshing(true);
    setError(null);
    try {
      const nextDetail = await loadSharedCourse(course.id);
      if (requestVersion !== requestVersionRef.current) return;
      setDetail(nextDetail);
    } catch (requestError) {
      if (requestVersion !== requestVersionRef.current) return;
      handleRequestError(requestError);
    } finally {
      if (requestVersion === requestVersionRef.current) setRefreshing(false);
    }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginBusy(true);
    setError(null);
    try {
      await loginToSharedService(password);
      setPassword('');
      setAuthenticated(true);
      await refresh(null);
    } catch (loginError) {
      setError(describeApiError(loginError));
    } finally {
      setLoginBusy(false);
      setLoading(false);
    }
  };

  const logout = async () => {
    requestVersionRef.current += 1;
    try {
      await logoutFromSharedService();
    } catch {
      // Local state is cleared even if the service disappears during logout.
    }
    signedOut();
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f5f7fa] text-sm text-slate-500">
        <RefreshCw className="mr-2 size-4 animate-spin" />
        正在连接共享服务…
      </div>
    );
  }

  if (!authenticated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f5f7fa] px-5 py-10 text-slate-800">
        <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-[#243a59] text-white">
              <BookOpen className="size-5" />
            </span>
            <div>
              <p className="text-xs font-bold tracking-[0.16em] text-violet-600 uppercase">
                页语 · 局域网共享
              </p>
              <h1 className="mt-1 text-xl font-semibold">查看课程资料</h1>
            </div>
          </div>
          <p className="mt-7 text-sm leading-6 text-slate-600">
            请输入主电脑设置的访问密码。课程资料保持只读，PDF
            页码和缩放进度会与主电脑同步。
          </p>
          <form className="mt-6 space-y-4" onSubmit={login}>
            <label className="block space-y-2">
              <span className="text-xs font-semibold text-slate-700">
                访问密码
              </span>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoFocus
                placeholder="请输入访问密码"
              />
            </label>
            <Button
              className="w-full"
              type="submit"
              disabled={loginBusy || password.length === 0}
            >
              {loginBusy ? (
                <RefreshCw className="animate-spin" />
              ) : (
                <ShieldCheck />
              )}{' '}
              登录查看
            </Button>
          </form>
          {error ? (
            <p className="mt-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-xs leading-5 text-rose-700">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          ) : null}
          <p className="mt-6 text-[11px] leading-5 text-slate-400">
            密码不会放入网址或页面内容。当前共享使用普通
            HTTP，校园网中的传输未加密，请只在可信网络使用。
          </p>
        </section>
      </main>
    );
  }

  if (reader) {
    return (
      <SharedPdfReader
        file={reader.file}
        fileKey={`${reader.document.id}-${reader.file.size}`}
        courseId={selectedId!}
        documentId={reader.document.id}
        digest={detail?.digests[reader.document.id]}
        hasSummary={reader.document.hasSummary}
        hasMindmap={reader.document.hasMindmap}
        initialPage={reader.initialPage}
        onBack={() => setReader(null)}
        onSessionExpired={sessionExpired}
      />
    );
  }

  return (
    <main className="flex h-screen min-h-[650px] flex-col overflow-hidden bg-[#f5f7fa] text-slate-800">
      <header className="flex h-15 shrink-0 items-center justify-between bg-[#243a59] px-5 text-white">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-400 to-indigo-500">
            <BookOpen className="size-4" />
          </span>
          <span className="text-sm font-semibold tracking-wide">
            页语 · 局域网共享
          </span>
          <span className="hidden items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-[10px] text-slate-200 sm:flex">
            <Wifi className="size-3" /> 资料只读 · 进度同步
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-white hover:bg-white/10 hover:text-white"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshCw className={refreshing ? 'animate-spin' : ''} /> 刷新
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-white hover:bg-white/10 hover:text-white"
            onClick={() => void logout()}
          >
            <LogOut /> 退出
          </Button>
        </div>
      </header>
      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-rose-200 bg-rose-50 px-5 py-2.5 text-xs text-rose-700">
          <CircleAlert className="size-4" />
          {error}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-[#fafbfc] p-4 md:block">
          <p className="px-2 py-2 text-[11px] font-bold tracking-[0.13em] text-slate-500 uppercase">
            课程列表
          </p>
          <div className="mt-2 space-y-1">
            {courses.map((course) => (
              <button
                key={course.id}
                type="button"
                className={`w-full rounded-xl border px-3 py-3 text-left transition ${course.id === selectedId ? 'border-slate-200 bg-white shadow-sm' : 'border-transparent hover:bg-white'}`}
                onClick={() => void selectCourse(course)}
              >
                <span className="block truncate text-sm font-semibold">
                  {course.name}
                </span>
                <span className="mt-1 block text-[10px] text-slate-500">
                  {course.documentCount} 份 PDF · {updatedAt(course.updatedAt)}
                </span>
              </button>
            ))}
          </div>
          {courses.length === 0 ? (
            <p className="mt-5 px-2 text-xs leading-5 text-slate-500">
              主电脑还没有可查看的课程。
            </p>
          ) : null}
          <div className="mt-8 rounded-xl border border-slate-200 bg-white p-4 text-[11px] leading-5 text-slate-500">
            <p className="flex items-center gap-2 font-semibold text-slate-700">
              <ShieldCheck className="size-4 text-emerald-600" />
              资料只读
            </p>
            <p className="mt-2">
              查看端不会上传、编辑、删除或调用
              AI；阅读页码和缩放会保存到主电脑，并在两端恢复。
            </p>
          </div>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-5 py-4 sm:px-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-slate-500">局域网共享 / 课程资料</p>
                <h1 className="mt-1 text-xl font-semibold text-slate-900">
                  {detail?.manifest.name ?? '暂无课程'}
                </h1>
              </div>
              <select
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs md:hidden"
                value={selectedId ?? ''}
                onChange={(event) => {
                  const course = courses.find(
                    (item) => item.id === event.target.value,
                  );
                  if (course) void selectCourse(course);
                }}
              >
                <option value="" disabled>
                  选择课程
                </option>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {detail ? (
            <SharedCourseDetail
              detail={detail}
              onOpenSource={(documentId, page) => {
                const document = detail.manifest.documents.find(
                  (item) => item.id === documentId,
                );
                if (document) void openDocument(document, page);
                else setError('来源 PDF 已被删除，请刷新课程列表。');
              }}
              onOpenDocument={(document) => void openDocument(document)}
            />
          ) : (
            <EmptyResult
              title="暂无可查看课程"
              description="主电脑新增课程后，点击刷新即可读取。"
            />
          )}
        </section>
      </div>
    </main>
  );
}
