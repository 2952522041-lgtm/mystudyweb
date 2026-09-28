'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  CircleAlert,
  FileText,
  LogOut,
  Network,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
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
  createSharedCourse,
  getSharedSession,
  importSharedPdf,
  listSharedCourses,
  loadSharedCourse,
  loadSharedGlossary,
  loadSharedPdf,
  loginToSharedService,
  logoutFromSharedService,
  regenerateSharedCourse,
  regenerateSharedDocument,
  removeSharedCourse,
  removeSharedDocument,
  saveSharedGlossary,
  SharedApiError,
  type SharedCourseDetail,
  type SharedCourseListItem,
  type ImportSharedPdfOptions,
  type SharedSessionCapabilities,
} from '@/lib/lan-share-api';
import {
  EMPTY_GLOSSARY,
  parseGlossary,
  reviseGlossary,
  type Glossary,
  type GlossaryEntry,
} from '@/lib/glossary';
import { formatSource } from '@/lib/knowledge/artifact-renderer';
import { KnowledgeMindmap } from '@/components/knowledge-mindmap';

const MAX_SHARED_IMPORT_BYTES = 128 * 1024 * 1024;
const MAX_SHARED_COURSE_NAME_LENGTH = 120;
const SHARED_IMPORT_DESCRIPTION = '上传与 AI 生成都在主电脑执行';

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

function validateSharedCourseName(value: string): string | null {
  const name = value.trim();
  if (!name) return '请输入课程名称。';
  if (name.length > MAX_SHARED_COURSE_NAME_LENGTH) {
    return `课程名称不能超过 ${MAX_SHARED_COURSE_NAME_LENGTH} 个字符。`;
  }
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 32 || code === 127) return '课程名称不能包含控制字符。';
  }
  return null;
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

function SharedCourseCreateControl({
  canManage,
  busy,
  onCreate,
}: {
  canManage: boolean;
  busy: boolean;
  onCreate: (name: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  if (!canManage) return null;

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const trimmed = name.trim();
    const nextError = validateSharedCourseName(trimmed);
    if (nextError) {
      setValidationError(nextError);
      return;
    }
    setValidationError(null);
    if (await onCreate(trimmed)) {
      setName('');
      setOpen(false);
    }
  };

  return open ? (
    <form
      className="flex min-w-0 flex-wrap items-center gap-2"
      onSubmit={(event) => void submit(event)}
    >
      <Input
        aria-label="新课程名称"
        className="h-7 w-44 bg-white text-xs"
        value={name}
        maxLength={MAX_SHARED_COURSE_NAME_LENGTH}
        onChange={(event) => {
          setName(event.target.value);
          if (validationError) setValidationError(null);
        }}
        placeholder="输入课程名称"
        disabled={busy}
      />
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? <RefreshCw className="animate-spin" /> : <Plus />}
        创建课程
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setOpen(false);
          setValidationError(null);
        }}
      >
        取消
      </Button>
      {validationError ? (
        <p className="basis-full text-[11px] text-rose-700">
          {validationError}
        </p>
      ) : null}
    </form>
  ) : (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => {
        setValidationError(null);
        setOpen(true);
      }}
    >
      <Plus /> 新建课程
    </Button>
  );
}

function SharedGlossaryEditor({
  courseName,
  canManage,
  disabled,
  onLoad,
  onSave,
}: {
  courseName: string;
  canManage: boolean;
  disabled: boolean;
  onLoad: () => Promise<Glossary>;
  onSave: (glossary: Glossary) => Promise<Glossary | null>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [glossary, setGlossary] = useState<Glossary>(EMPTY_GLOSSARY);
  const [rows, setRows] = useState<GlossaryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  if (!canManage) return null;

  const openEditor = () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    setStatus(null);
    void onLoad()
      .then((value) => {
        const parsed = parseGlossary(value);
        setGlossary(parsed);
        setRows(parsed.entries);
      })
      .catch((loadError: unknown) => {
        setError(describeApiError(loadError));
      })
      .finally(() => setLoading(false));
  };

  const updateRow = (index: number, patch: Partial<GlossaryEntry>) => {
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
    setStatus(null);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const next = reviseGlossary(
        glossary,
        rows.map((row) => ({
          ...row,
          source: row.source.trim(),
          target: row.target.trim(),
          forbidden: row.forbidden.map((word) => word.trim()).filter(Boolean),
          note: row.note.trim(),
        })),
      );
      const saved = await onSave(next);
      if (!saved) return;
      const parsed = parseGlossary(saved);
      setGlossary(parsed);
      setRows(parsed.entries);
      setStatus(`已保存术语表版本 ${parsed.version}。`);
    } catch (saveError: unknown) {
      setError(describeApiError(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">课程术语表</p>
          <p className="mt-1 text-xs text-slate-500">
            管理端可编辑 source、target、forbidden 和 note；保存会创建新版本。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || loading}
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }
            openEditor();
          }}
        >
          {loading ? <RefreshCw className="animate-spin" /> : <BookOpen />}
          {open ? '收起术语表' : '编辑术语表'}
        </Button>
      </div>
      {open ? (
        <div
          className="mt-4 space-y-3"
          aria-label={`课程术语表：${courseName}`}
        >
          {loading ? (
            <p className="text-xs text-slate-500">正在读取术语表…</p>
          ) : rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-500">
              暂无术语，点击“新增术语”开始编辑。
            </p>
          ) : (
            <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
              {rows.map((entry, index) => (
                <div
                  key={index}
                  className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-2"
                >
                  <Input
                    aria-label={`source ${index + 1}`}
                    placeholder="source"
                    value={entry.source}
                    disabled={disabled || saving || loading}
                    onChange={(event) =>
                      updateRow(index, { source: event.target.value })
                    }
                  />
                  <Input
                    aria-label={`target ${index + 1}`}
                    placeholder="target"
                    value={entry.target}
                    disabled={disabled || saving || loading}
                    onChange={(event) =>
                      updateRow(index, { target: event.target.value })
                    }
                  />
                  <Input
                    aria-label={`forbidden ${index + 1}`}
                    placeholder="forbidden（用 | 分隔）"
                    value={entry.forbidden.join('|')}
                    disabled={disabled || saving || loading}
                    onChange={(event) =>
                      updateRow(index, {
                        forbidden: event.target.value.split('|'),
                      })
                    }
                  />
                  <Input
                    aria-label={`note ${index + 1}`}
                    placeholder="note（可选）"
                    value={entry.note}
                    disabled={disabled || saving || loading}
                    onChange={(event) =>
                      updateRow(index, { note: event.target.value })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || saving || loading}
                    onClick={() =>
                      setRows((current) =>
                        current.filter((_, rowIndex) => rowIndex !== index),
                      )
                    }
                  >
                    <Trash2 /> 删除第 {index + 1} 条
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || saving || loading}
              onClick={() =>
                setRows((current) => [
                  ...current,
                  { source: '', target: '', forbidden: [], note: '' },
                ])
              }
            >
              <Plus /> 新增术语
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={disabled || saving || loading}
              onClick={() => void save()}
            >
              {saving ? <RefreshCw className="animate-spin" /> : <Save />}{' '}
              保存术语表
            </Button>
          </div>
          {error ? <p className="text-xs text-rose-700">{error}</p> : null}
          {status ? <p className="text-xs text-emerald-700">{status}</p> : null}
          <p className="text-[11px] text-slate-400">
            当前版本 {glossary.version}；source 不能重复，target 不能出现在
            forbidden 中。
          </p>
        </div>
      ) : null}
    </section>
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

function CourseImportPanel({
  canImportPdf,
  canTriggerAi,
  busy,
  feedback,
  onImport,
}: {
  canImportPdf: boolean;
  canTriggerAi: boolean;
  busy: boolean;
  feedback: string | null;
  onImport: (file: File, options: ImportSharedPdfOptions) => void;
}) {
  const [generateSummary, setGenerateSummary] = useState(true);
  const [generateMindmap, setGenerateMindmap] = useState(true);
  const [mergeIntoCourse, setMergeIntoCourse] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const chooseFile = () => {
    setFileError(null);
    inputRef.current?.click();
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const isPdf =
      file.type === 'application/pdf' ||
      file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setFileError('请选择 PDF 文件。');
      return;
    }
    if (file.size > MAX_SHARED_IMPORT_BYTES) {
      setFileError('PDF 文件不能超过 128 MiB，请压缩后重试。');
      return;
    }
    setFileError(null);
    onImport(file, {
      generateSummary: canTriggerAi && generateSummary,
      generateMindmap: canTriggerAi && generateMindmap,
      mergeIntoCourse: canTriggerAi && mergeIntoCourse,
    });
  };

  return (
    <section className="mb-5 rounded-xl border border-dashed border-indigo-200 bg-indigo-50/50 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Upload className="size-4 text-indigo-600" /> 导入一份 PDF
          </p>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-600">
            选择单个 PDF 后交给主电脑保存和处理。{SHARED_IMPORT_DESCRIPTION}
            ，Windows 查看端不会接触 API Key。
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          aria-label="选择要导入的 PDF"
          disabled={!canImportPdf || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            handleFile(file);
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={chooseFile}
          disabled={!canImportPdf || busy}
        >
          {busy ? <RefreshCw className="animate-spin" /> : <Upload />}
          {busy ? '正在上传并处理…' : '选择 PDF'}
        </Button>
      </div>
      {canImportPdf ? (
        <div className="mt-4 grid gap-2 text-xs text-slate-700 sm:grid-cols-3">
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <input
              type="checkbox"
              checked={canTriggerAi && generateSummary}
              disabled={busy || !canTriggerAi}
              onChange={(event) => setGenerateSummary(event.target.checked)}
            />
            生成 PDF 总结
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <input
              type="checkbox"
              checked={canTriggerAi && generateMindmap}
              disabled={busy || !canTriggerAi}
              onChange={(event) => setGenerateMindmap(event.target.checked)}
            />
            生成 PDF 脑图
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <input
              type="checkbox"
              checked={canTriggerAi && mergeIntoCourse}
              disabled={busy || !canTriggerAi}
              onChange={(event) => setMergeIntoCourse(event.target.checked)}
            />
            合并到课程知识库
          </label>
        </div>
      ) : (
        <p className="mt-3 text-xs leading-5 text-slate-500">
          当前主电脑未开放 PDF 导入权限；已有课程资料仍可查看。
        </p>
      )}
      {!canTriggerAi && canImportPdf ? (
        <p className="mt-3 text-xs leading-5 text-slate-500">
          主电脑当前未开放 AI 处理，仍可上传原始 PDF。
        </p>
      ) : null}
      {fileError ? (
        <p className="mt-3 text-xs text-rose-700">{fileError}</p>
      ) : null}
      {feedback ? (
        <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-emerald-700">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          {feedback}
        </p>
      ) : null}
    </section>
  );
}

function CourseDocuments({
  manifest,
  digests,
  onOpenDocument,
  onRemoveDocument,
  onRegenerateDocument,
  canImportPdf,
  canTriggerAi,
  canManage,
  importBusy,
  importFeedback,
  actionBusy,
  onImportDocument,
}: {
  manifest: CourseManifest;
  digests: Record<string, DocumentDigest>;
  onOpenDocument: (document: DocumentRecord) => void;
  onRemoveDocument: (document: DocumentRecord) => void;
  onRegenerateDocument: (document: DocumentRecord) => void;
  canImportPdf: boolean;
  canTriggerAi: boolean;
  canManage: boolean;
  importBusy: boolean;
  importFeedback: string | null;
  actionBusy: boolean;
  onImportDocument: (file: File, options: ImportSharedPdfOptions) => void;
}) {
  return (
    <div className="p-5 sm:p-7">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-slate-900">课程资料</h2>
        <p className="mt-1 text-xs text-slate-500">
          已有 PDF 和主电脑成果只读；新增 PDF 会交给主电脑导入。
        </p>
        {!canTriggerAi ? (
          <p className="mt-1 text-xs text-slate-500">
            主电脑未开放 AI 成果重新生成权限，已有总结和脑图仍可查看。
          </p>
        ) : null}
        {!canManage ? (
          <p className="mt-1 text-xs text-slate-500">
            主电脑未开放课程管理权限，查看端不会删除 PDF。
          </p>
        ) : null}
      </div>
      <CourseImportPanel
        canImportPdf={canImportPdf}
        canTriggerAi={canTriggerAi}
        busy={importBusy || actionBusy}
        feedback={importFeedback}
        onImport={onImportDocument}
      />
      {manifest.documents.length === 0 ? (
        <EmptyResult
          title="课程中还没有 PDF"
          description="选择上方的 PDF 文件后，可交给主电脑导入当前课程。"
        />
      ) : (
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
                  {document.processing ? (
                    <span
                      className={`mt-1 block text-[10px] ${document.processing.status === 'failed' ? 'text-rose-700' : 'text-amber-700'}`}
                    >
                      {document.processing.status === 'queued'
                        ? '主电脑已排队，等待 AI 整理'
                        : document.processing.status === 'running'
                          ? '主电脑正在 AI 整理'
                          : `AI 整理失败：${document.processing.error ?? '可在主电脑或共享端重新生成'}`}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onOpenDocument(document)}
                  disabled={actionBusy || importBusy}
                >
                  <BookOpen /> 打开 PDF
                </Button>
                {canTriggerAi ? (
                  <Button
                    size="sm"
                    variant="outline"
                    title="重新生成这份 PDF 的总结和脑图"
                    aria-label={`重新生成 ${document.fileName} 的成果`}
                    onClick={() => onRegenerateDocument(document)}
                    disabled={actionBusy || importBusy}
                  >
                    <Sparkles /> 重新生成 PDF 成果
                  </Button>
                ) : null}
                {canManage ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    title="删除这份 PDF 及其成果"
                    aria-label={`删除 PDF ${document.fileName}`}
                    onClick={() => onRemoveDocument(document)}
                    disabled={actionBusy || importBusy}
                  >
                    <Trash2 /> 删除 PDF
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SharedCourseDetail({
  detail,
  onOpenSource,
  onOpenDocument,
  onRemoveDocument,
  onRegenerateDocument,
  onRegenerateCourse,
  onRemoveCourse,
  onLoadGlossary,
  onSaveGlossary,
  canImportPdf,
  canTriggerAi,
  canManage,
  importBusy,
  importFeedback,
  actionBusy,
  onImportDocument,
}: {
  detail: SharedCourseDetail;
  onOpenSource: (documentId: string, page: number) => void;
  onOpenDocument: (document: DocumentRecord) => void;
  onRemoveDocument: (document: DocumentRecord) => void;
  onRegenerateDocument: (document: DocumentRecord) => void;
  onRegenerateCourse: () => void;
  onRemoveCourse: () => void;
  onLoadGlossary: () => Promise<Glossary>;
  onSaveGlossary: (glossary: Glossary) => Promise<Glossary | null>;
  canImportPdf: boolean;
  canTriggerAi: boolean;
  canManage: boolean;
  importBusy: boolean;
  importFeedback: string | null;
  actionBusy: boolean;
  onImportDocument: (file: File, options: ImportSharedPdfOptions) => void;
}) {
  return (
    <Tabs defaultValue="summary" className="min-h-0 flex-1 gap-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-5 py-3 sm:px-7">
        <div>
          {!canTriggerAi ? (
            <p className="text-xs text-slate-500">
              主电脑未开放 AI 权限，不能从共享端重新生成成果。
            </p>
          ) : null}
          {!canManage ? (
            <p className="text-xs text-slate-500">
              主电脑未开放管理权限，课程、PDF 和术语表保持只读。
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canTriggerAi ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRegenerateCourse}
              disabled={actionBusy || importBusy}
              title="重新生成当前课程的总总结和总脑图"
            >
              {actionBusy ? (
                <RefreshCw className="animate-spin" />
              ) : (
                <Sparkles />
              )}{' '}
              重新生成课程成果
            </Button>
          ) : null}
          {canManage ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={onRemoveCourse}
              disabled={actionBusy || importBusy}
              title="删除当前课程及其中的 PDF"
            >
              <Trash2 /> 删除课程
            </Button>
          ) : null}
        </div>
      </div>
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
          onRemoveDocument={onRemoveDocument}
          onRegenerateDocument={onRegenerateDocument}
          canImportPdf={canImportPdf}
          canTriggerAi={canTriggerAi}
          canManage={canManage}
          importBusy={importBusy}
          importFeedback={importFeedback}
          actionBusy={actionBusy}
          onImportDocument={onImportDocument}
        />
      </TabsContent>
      {canManage ? (
        <div className="border-t border-slate-200 bg-slate-50 px-5 py-4 sm:px-7">
          <SharedGlossaryEditor
            key={detail.manifest.id}
            courseName={detail.manifest.name}
            canManage={canManage}
            disabled={actionBusy || importBusy}
            onLoad={onLoadGlossary}
            onSave={onSaveGlossary}
          />
        </div>
      ) : null}
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
  const [capabilities, setCapabilities] =
    useState<SharedSessionCapabilities | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const requestVersionRef = useRef(0);
  const importRequestRef = useRef(0);
  const importBusyRef = useRef(false);
  const actionBusyRef = useRef(false);
  const actionAbortRef = useRef<AbortController | null>(null);

  const signedOut = useCallback((message?: string) => {
    requestVersionRef.current += 1;
    setAuthenticated(false);
    setCourses([]);
    setSelectedId(null);
    setDetail(null);
    setReader(null);
    setRefreshing(false);
    setCapabilities(null);
    setImportBusy(false);
    setImportFeedback(null);
    setActionBusy(null);
    setActionFeedback(null);
    importBusyRef.current = false;
    actionBusyRef.current = false;
    actionAbortRef.current?.abort();
    actionAbortRef.current = null;
    importRequestRef.current += 1;
    if (message) setError(message);
  }, []);
  const sessionExpired = useCallback(
    () => signedOut('登录已过期或共享服务已停止，请重新登录。'),
    [signedOut],
  );

  const handleRequestError = useCallback(
    (requestError: unknown) => {
      if (
        requestError instanceof SharedApiError &&
        requestError.status === 401
      ) {
        signedOut('登录已过期或共享服务已停止，请重新登录。');
        return;
      }
      setError(describeApiError(requestError));
    },
    [signedOut],
  );

  const runSharedMutation = async <T,>(
    name: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined> => {
    if (actionBusyRef.current || importBusyRef.current) return undefined;
    actionBusyRef.current = true;
    setActionBusy(name);
    setActionFeedback(null);
    setError(null);
    try {
      return await task();
    } catch (requestError) {
      if (signal?.aborted) {
        setActionFeedback('任务已取消，主电脑不会保存未完成的 AI 结果。');
        return undefined;
      }
      setActionFeedback(null);
      handleRequestError(requestError);
      return undefined;
    } finally {
      actionBusyRef.current = false;
      setActionBusy(null);
    }
  };

  const refresh = async (
    preferredId = selectedId,
    preserveImportFeedback = false,
  ) => {
    const requestVersion = ++requestVersionRef.current;
    setRefreshing(true);
    setError(null);
    if (!preserveImportFeedback) setImportFeedback(null);
    if (!preserveImportFeedback) setActionFeedback(null);
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
        const session = await getSharedSession();
        if (cancelled) return;
        setCapabilities(session.capabilities ?? null);
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

  useEffect(() => {
    if (
      !authenticated ||
      !selectedId ||
      !detail?.manifest.documents.some(
        (document) =>
          document.processing && document.processing.status !== 'failed',
      )
    ) {
      return;
    }
    const courseId = selectedId;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadSharedCourse(courseId)
        .then((nextDetail) => {
          if (!cancelled && selectedId === courseId) setDetail(nextDetail);
        })
        .catch((requestError: unknown) => {
          if (!cancelled) handleRequestError(requestError);
        });
    }, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [authenticated, detail, handleRequestError, selectedId]);

  const openDocument = async (document: DocumentRecord, initialPage = 1) => {
    if (!selectedId || actionBusyRef.current || importBusyRef.current) return;
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
    if (actionBusyRef.current || importBusyRef.current) return;
    const requestVersion = ++requestVersionRef.current;
    setSelectedId(course.id);
    setDetail(null);
    setReader(null);
    setRefreshing(true);
    setError(null);
    setImportFeedback(null);
    setActionFeedback(null);
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

  const importDocument = async (
    file: File,
    options: ImportSharedPdfOptions,
  ) => {
    if (!selectedId || importBusyRef.current || actionBusyRef.current) return;
    const courseId = selectedId;
    const requestVersion = ++requestVersionRef.current;
    const importRequest = ++importRequestRef.current;
    importBusyRef.current = true;
    setImportBusy(true);
    setImportFeedback(null);
    setActionFeedback(null);
    setError(null);
    try {
      const result = await importSharedPdf(courseId, file, options);
      if (requestVersion !== requestVersionRef.current) return;
      setImportFeedback(
        result.import.message ??
          `主电脑已接受 ${result.import.fileName || file.name}，正在更新课程资料；稍后可点击“刷新”查看处理结果。`,
      );
      const refreshVersion = requestVersionRef.current;
      await refresh(courseId, true);
      if (
        requestVersionRef.current !== refreshVersion + 1 ||
        importRequest !== importRequestRef.current
      ) {
        return;
      }
    } catch (importError) {
      if (requestVersion !== requestVersionRef.current) return;
      handleRequestError(importError);
    } finally {
      if (importRequest === importRequestRef.current) {
        importBusyRef.current = false;
        setImportBusy(false);
      }
    }
  };

  const createCourse = async (name: string): Promise<boolean> => {
    if (capabilities?.manage !== true) return false;
    const validationError = validateSharedCourseName(name);
    if (validationError) {
      setError(validationError);
      return false;
    }
    const created = await runSharedMutation('create-course', async () => {
      setActionFeedback(`正在创建课程“${name}”…`);
      const result = await createSharedCourse(name);
      await refresh(result.id, true);
      setActionFeedback(`课程“${result.name || name}”已创建。`);
      return true;
    });
    return created === true;
  };

  const removeCourse = async (course: SharedCourseListItem) => {
    if (capabilities?.manage !== true || actionBusyRef.current) return;
    if (
      !window.confirm(
        `确定删除课程“${course.name}”吗？课程中的 PDF、总结、脑图和术语表都会被删除。`,
      )
    ) {
      return;
    }
    const preferredId = selectedId === course.id ? null : selectedId;
    await runSharedMutation('remove-course', async () => {
      setActionFeedback(`正在删除课程“${course.name}”…`);
      await removeSharedCourse(course.id);
      await refresh(preferredId, true);
      setActionFeedback(`课程“${course.name}”已删除。`);
    });
  };

  const removeCurrentCourse = async () => {
    const course = courses.find((item) => item.id === selectedId);
    if (course) await removeCourse(course);
  };

  const regenerateDocument = async (document: DocumentRecord) => {
    if (capabilities?.ai !== true || !selectedId || actionBusyRef.current) {
      return;
    }
    const courseId = selectedId;
    const controller = new AbortController();
    actionAbortRef.current = controller;
    try {
      await runSharedMutation(
        'regenerate-document',
        async () => {
          setActionFeedback(
            `正在重新生成“${document.fileName}”的总结和脑图…`,
          );
          await regenerateSharedDocument(
            courseId,
            document.id,
            controller.signal,
          );
          await refresh(courseId, true);
          setActionFeedback(
            `“${document.fileName}”的总结和脑图已重新生成。`,
          );
        },
        controller.signal,
      );
    } finally {
      if (actionAbortRef.current === controller) actionAbortRef.current = null;
    }
  };

  const regenerateCourse = async () => {
    if (capabilities?.ai !== true || !selectedId || actionBusyRef.current) {
      return;
    }
    const courseId = selectedId;
    const courseName = detail?.manifest.name ?? '当前课程';
    const controller = new AbortController();
    actionAbortRef.current = controller;
    try {
      await runSharedMutation(
        'regenerate-course',
        async () => {
          setActionFeedback(`正在重新生成“${courseName}”的课程总成果…`);
          await regenerateSharedCourse(courseId, controller.signal);
          await refresh(courseId, true);
          setActionFeedback(
            `“${courseName}”的课程总总结和总脑图已重新生成。`,
          );
        },
        controller.signal,
      );
    } finally {
      if (actionAbortRef.current === controller) actionAbortRef.current = null;
    }
  };

  const deletePdf = async (document: DocumentRecord) => {
    if (capabilities?.manage !== true || !selectedId || actionBusyRef.current) {
      return;
    }
    if (
      !window.confirm(
        `确定删除 PDF“${document.fileName}”吗？这份 PDF 的总结和脑图也会被删除。`,
      )
    ) {
      return;
    }
    const courseId = selectedId;
    await runSharedMutation('remove-document', async () => {
      setActionFeedback(`正在删除“${document.fileName}”…`);
      await removeSharedDocument(courseId, document.id);
      await refresh(courseId, true);
      setActionFeedback(`“${document.fileName}”及其成果已删除。`);
    });
  };

  const loadGlossary = async (courseId: string): Promise<Glossary> => {
    try {
      const result = await loadSharedGlossary(courseId);
      return parseGlossary(result.glossary);
    } catch (requestError) {
      handleRequestError(requestError);
      throw requestError;
    }
  };

  const saveGlossary = async (
    courseId: string,
    glossary: Glossary,
  ): Promise<Glossary | null> => {
    const next = await runSharedMutation('save-glossary', async () => {
      const parsed = parseGlossary(glossary);
      const result = await saveSharedGlossary(courseId, parsed);
      setActionFeedback(`术语表已保存为版本 ${parsed.version}。`);
      return parseGlossary(result.glossary);
    });
    return next ?? null;
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginBusy(true);
    setError(null);
    try {
      const session = await loginToSharedService(password);
      setPassword('');
      setCapabilities(session.capabilities ?? null);
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

  const canImportPdf = capabilities?.importPdf === true;
  const canUseAi = capabilities?.ai === true;
  const canManage = capabilities?.manage === true;
  const sharedActionsBusy = Boolean(actionBusy) || importBusy || refreshing;

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
            请输入主电脑设置的访问密码。已有课程资料保持只读；如主电脑开放导入权限，
            你可以把新的 PDF 交给主电脑处理。PDF 页码和缩放进度会与主电脑同步。
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
        canUseAi={canUseAi}
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
            <Wifi className="size-3" />
            {canManage
              ? '课程可管理'
              : canImportPdf
                ? '已有资料只读 · 新 PDF 可导入'
                : '已有资料只读'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-white hover:bg-white/10 hover:text-white"
            onClick={() => void refresh()}
            disabled={refreshing || sharedActionsBusy}
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
      {actionFeedback ? (
        <output
          className="flex shrink-0 items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-5 py-2.5 text-xs text-emerald-700"
          aria-live="polite"
        >
          {actionBusy ? (
            <RefreshCw className="size-4 animate-spin" />
          ) : (
            <CheckCircle2 className="size-4" />
          )}
          {actionFeedback}
          {actionBusy && actionAbortRef.current ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => actionAbortRef.current?.abort()}
            >
              <Square /> 取消任务
            </Button>
          ) : null}
        </output>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-[#fafbfc] p-4 md:block">
          <p className="px-2 py-2 text-[11px] font-bold tracking-[0.13em] text-slate-500 uppercase">
            课程列表
          </p>
          <div className="mt-2 space-y-1">
            {courses.map((course) => (
              <div
                key={course.id}
                className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 transition ${course.id === selectedId ? 'border-slate-200 bg-white shadow-sm' : 'border-transparent hover:bg-white'}`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => void selectCourse(course)}
                  disabled={sharedActionsBusy}
                >
                  <span className="block truncate text-sm font-semibold">
                    {course.name}
                  </span>
                  <span className="mt-1 block text-[10px] text-slate-500">
                    {course.documentCount} 份 PDF ·{' '}
                    {updatedAt(course.updatedAt)}
                  </span>
                </button>
                {canManage ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`删除课程 ${course.name}`}
                    title="删除课程"
                    onClick={() => void removeCourse(course)}
                    disabled={sharedActionsBusy}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
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
              {canManage ? '共享课程管理' : '已有资料只读'}
            </p>
            <p className="mt-2">
              {canManage
                ? '当前已开放课程管理、PDF 删除和术语表编辑；AI 生成仍在主电脑执行，Windows 端不会接触 API Key。'
                : '查看端不会删除或任意编辑；新增 PDF 会由主电脑保存并处理。AI 也在主电脑执行，Windows 端不会接触 API Key。阅读页码和缩放会保存到主电脑.'}
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
              <div className="flex flex-wrap items-center justify-end gap-2">
                <SharedCourseCreateControl
                  canManage={canManage}
                  busy={sharedActionsBusy}
                  onCreate={createCourse}
                />
                <select
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs md:hidden"
                  value={selectedId ?? ''}
                  disabled={sharedActionsBusy}
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
          </div>
          {detail ? (
            <SharedCourseDetail
              key={detail.manifest.id}
              detail={detail}
              onOpenSource={(documentId, page) => {
                const document = detail.manifest.documents.find(
                  (item) => item.id === documentId,
                );
                if (document) void openDocument(document, page);
                else setError('来源 PDF 已被删除，请刷新课程列表。');
              }}
              onOpenDocument={(document) => void openDocument(document)}
              onRemoveDocument={(document) => void deletePdf(document)}
              onRegenerateDocument={(document) =>
                void regenerateDocument(document)
              }
              onRegenerateCourse={() => void regenerateCourse()}
              onRemoveCourse={() => void removeCurrentCourse()}
              onLoadGlossary={() => loadGlossary(detail.manifest.id)}
              onSaveGlossary={(glossary) =>
                saveGlossary(detail.manifest.id, glossary)
              }
              canImportPdf={canImportPdf}
              canTriggerAi={canUseAi}
              canManage={canManage}
              importBusy={importBusy}
              importFeedback={importFeedback}
              actionBusy={sharedActionsBusy}
              onImportDocument={(file, options) => {
                void importDocument(file, options);
              }}
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
