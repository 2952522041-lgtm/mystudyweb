'use client';

import { useEffect, useRef, useState } from 'react';
import type { SynthesisDiagnostic } from '@/lib/knowledge/hierarchical-synthesis';
import {
  BrainCircuit,
  Check,
  CircleDot,
  FileText,
  FileUp,
  GitMerge,
  LoaderCircle,
  MessageSquareText,
  Network,
  RotateCcw,
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
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import type {
  DocumentProcessing,
  ImportOptions,
} from '@/lib/course-storage/types';

export type { DocumentProcessing };

const DEFAULT_OPTIONS: ImportOptions = {
  generateSummary: true,
  generateMindmap: true,
  mergeIntoCourse: true,
  includeConversationInsights: true,
};

type ImportFileStatus = 'pending' | 'saving' | 'saved' | 'failed' | 'cancelled';

type ImportFile = {
  id: string;
  file: File;
  status: ImportFileStatus;
  error?: string;
};

export type CourseImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (
    file: File,
    options: ImportOptions,
    onProgress: (message: string, percent: number) => void,
    signal?: AbortSignal,
    onDiagnostic?: (diagnostic: SynthesisDiagnostic) => void,
  ) => Promise<string | void>;
  /** Called once before the first file in a batch is saved. */
  onBatchStart?: () => void;
  /** Called once after every file in a batch has finished or been cancelled. */
  onBatchEnd?: () => void;
};

function OptionRow({
  icon,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3 transition hover:border-violet-200 hover:bg-violet-50/30">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-slate-800">
          {title}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
          {description}
        </span>
      </span>
      <Switch
        aria-label={title}
        disabled={disabled}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}

function fileStatusLabel(status: ImportFileStatus) {
  switch (status) {
    case 'saving':
      return '保存中';
    case 'saved':
      return '已保存，可阅读';
    case 'failed':
      return '保存失败';
    case 'cancelled':
      return '已取消，尚未保存';
    default:
      return '等待保存';
  }
}

function fileStatusClass(status: ImportFileStatus) {
  switch (status) {
    case 'saved':
      return 'text-emerald-700';
    case 'failed':
      return 'text-rose-700';
    case 'cancelled':
      return 'text-slate-500';
    case 'saving':
      return 'text-violet-700';
    default:
      return 'text-slate-500';
  }
}

function requestedArtifactLabel(options: ImportOptions) {
  const labels = [
    options.generateSummary ? 'PDF 总结' : null,
    options.generateMindmap ? 'PDF 脑图' : null,
    options.mergeIntoCourse ? '课程汇总' : null,
    options.includeConversationInsights ? '问答洞察' : null,
  ].filter((label): label is string => Boolean(label));
  return labels.length ? labels.join('、') : '未选择 AI 成果';
}

/**
 * Shows the durable background task for a document or a course.
 *
 * Saved tasks are independent of this dialog. Pause/cancel and bulk controls
 * live in the global task center, including while the reader is open.
 */
export function DocumentProcessingStatus({
  processing,
  onRetry,
}: {
  processing?: DocumentProcessing;
  onRetry: () => void;
}) {
  if (!processing) return null;

  const phaseLabel = processing.phase === 'course' ? '课程汇总' : 'PDF 成果';
  const statusLabel =
    processing.status === 'queued'
      ? '后台排队中'
      : processing.status === 'running'
        ? '后台生成中'
        : processing.status === 'paused' ? '后台已暂停'
          : processing.status === 'cancelled' ? '后台已取消' : '后台生成失败';
  const timeLabel = (() => {
    const date = new Date(processing.updatedAt);
    return Number.isNaN(date.getTime())
      ? processing.updatedAt
      : date.toLocaleString();
  })();

  return (
    <section
      aria-label={`${phaseLabel}${statusLabel}`}
      className={`min-w-0 max-w-full overflow-hidden rounded-xl border px-3 py-3 ${
        processing.status === 'failed'
          ? 'border-rose-200 bg-rose-50/70'
          : 'border-violet-100 bg-violet-50/60'
      }`}
    >
      <div className="flex items-start gap-2">
        {processing.status === 'failed' ? (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-rose-600" />
        ) : (
          <LoaderCircle className={`mt-0.5 size-4 shrink-0 text-violet-600 ${processing.status === 'queued' || processing.status === 'running' ? 'animate-spin' : ''}`} />
        )}
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-medium ${
              processing.status === 'failed' ? 'text-rose-800' : 'text-violet-800'
            }`}
          >
            {phaseLabel} · {statusLabel}
          </p>
          {processing.message ? <p className="mt-1 text-xs text-slate-500">{processing.message}</p> : null}
          {processing.status === 'paused' || processing.status === 'cancelled' ? <p className="mt-1 text-xs text-slate-500">可在后台任务中心继续或重新开始；PDF 与已完成成果保留。</p> : null}
          <p className="mt-1 text-xs leading-5 text-slate-600">
            PDF 已保存，可直接阅读。
            {processing.phase === 'document'
              ? ` 已选择：${requestedArtifactLabel(processing.options)}。`
              : ' 课程总总结和总脑图会在后台更新。'}
          </p>
          {processing.error ? (
            <p
              role="alert"
              className="mt-2 max-h-24 overflow-y-auto break-words text-xs leading-5 text-rose-700"
            >
              {processing.error}
            </p>
          ) : null}
          <time
            dateTime={processing.updatedAt}
            className="mt-2 block text-[10px] text-slate-500"
          >
            更新于 {timeLabel}
          </time>
        </div>
        {processing.status === 'failed' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetry}
            className="shrink-0"
          >
            <RotateCcw />
            重试
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function isPdf(file: File) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

export function CourseImportDialog({
  open,
  onOpenChange,
  onImport,
  onBatchStart,
  onBatchEnd,
}: CourseImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRequestedRef = useRef(false);
  const activeImportControllerRef = useRef<AbortController | null>(null);
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      activeImportControllerRef.current?.abort();
    },
    [],
  );

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const updateOption = (key: keyof ImportOptions, checked: boolean) =>
    setOptions((previous) => ({ ...previous, [key]: checked }));

  const resetSelection = () => {
    clearCloseTimer();
    setFiles([]);
    setProgress(0);
    setProgressMessage('');
    setError(null);
    cancelRequestedRef.current = false;
  };

  const closeAfterSuccess = () => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      resetSelection();
      onOpenChange(false);
    }, 350);
  };

  const requestCancel = () => {
    if (!processing) return;
    // Abort only the current save attempt. Its controller is cleared as soon
    // as onImport resolves, so a queued background AI job cannot be cancelled
    // by this dialog; the flag below prevents the next unsaved file from
    // being handed to onImport.
    cancelRequestedRef.current = true;
    activeImportControllerRef.current?.abort();
    setFiles((previous) =>
      previous.map((item) =>
        item.status === 'pending'
          ? { ...item, status: 'cancelled', error: '已取消，尚未保存。' }
          : item,
      ),
    );
    setProgressMessage('正在完成当前 PDF 保存；其余文件已取消');
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && processing) {
      requestCancel();
      return;
    }
    if (!nextOpen) resetSelection();
    onOpenChange(nextOpen);
  };

  const chooseFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    clearCloseTimer();
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    const pdfs = selected.filter(isPdf);
    if (!pdfs.length) {
      setError('请选择一个或多个 PDF 文件。');
      setFiles([]);
      return;
    }
    setFiles(
      pdfs.map((file, index) => ({
        id: `${index}:${file.name}:${file.size}:${file.lastModified}`,
        file,
        status: 'pending',
      })),
    );
    setProgress(0);
    setProgressMessage('');
    setError(null);
    cancelRequestedRef.current = false;
  };

  const runBatch = async (batchFiles: ImportFile[]) => {
    if (!batchFiles.length || processing) return;
    const batchIds = new Set(batchFiles.map((item) => item.id));
    const outcomes = new Map<string, 'saved' | 'failed' | 'cancelled'>();
    cancelRequestedRef.current = false;
    setError(null);
    setProgress(0);
    setProgressMessage(`准备保存 ${batchFiles.length} 份 PDF`);
    setFiles((previous) =>
      previous.map((item) =>
        batchIds.has(item.id)
          ? { ...item, status: 'pending', error: undefined }
          : item,
      ),
    );
    setProcessing(true);

    try {
      onBatchStart?.();
      for (let index = 0; index < batchFiles.length; index += 1) {
        const item = batchFiles[index];
        if (cancelRequestedRef.current) {
          outcomes.set(item.id, 'cancelled');
          setFiles((previous) =>
            previous.map((candidate) =>
              candidate.id === item.id && candidate.status !== 'saved'
                ? {
                    ...candidate,
                    status: 'cancelled',
                    error: '已取消，尚未保存。',
                  }
                : candidate,
            ),
          );
          continue;
        }

        setFiles((previous) =>
          previous.map((candidate) =>
            candidate.id === item.id
              ? { ...candidate, status: 'saving', error: undefined }
              : candidate,
          ),
        );
        setProgressMessage(
          `正在保存第 ${index + 1} / ${batchFiles.length} 份：${item.file.name}`,
        );
        setProgress(Math.round((index / batchFiles.length) * 100));

        const controller = new AbortController();
        activeImportControllerRef.current = controller;
        try {
          await onImport(
            item.file,
            options,
            (_message, percent) => {
              // The dialog owns this progress bar. Ignore AI wording from a
              // legacy caller so the bar remains about durable PDF saving.
              const currentPercent = Number.isFinite(percent)
                ? Math.min(100, Math.max(0, percent))
                : 0;
              setProgress(
                Math.round(
                  ((index + currentPercent / 100) / batchFiles.length) * 100,
                ),
              );
              setProgressMessage(
                `正在保存第 ${index + 1} / ${batchFiles.length} 份：${item.file.name}`,
              );
            },
            controller.signal,
            undefined,
          );
          outcomes.set(item.id, 'saved');
          setFiles((previous) =>
            previous.map((candidate) =>
              candidate.id === item.id
                ? { ...candidate, status: 'saved', error: undefined }
                : candidate,
            ),
          );
          setProgress(Math.round(((index + 1) / batchFiles.length) * 100));
        } catch (importError) {
          outcomes.set(item.id, 'failed');
          setFiles((previous) =>
            previous.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    status: 'failed',
                    error:
                      importError instanceof Error
                        ? importError.message
                        : '保存失败。',
                  }
                : candidate,
            ),
          );
          setProgress(Math.round(((index + 1) / batchFiles.length) * 100));
        } finally {
          if (activeImportControllerRef.current === controller) {
            activeImportControllerRef.current = null;
          }
        }
      }
    } catch (batchError) {
      const message =
        batchError instanceof Error ? batchError.message : '批量保存失败。';
      setError(message);
    } finally {
      try {
        onBatchEnd?.();
      } finally {
        setProcessing(false);
      }
    }

    const hasFailure = batchFiles.some(
      (item) => outcomes.get(item.id) !== 'saved',
    );
    const hasSaved = batchFiles.some(
      (item) => outcomes.get(item.id) === 'saved',
    );
    if (!hasFailure && batchFiles.length) {
      setProgress(100);
      setProgressMessage(`${batchFiles.length} 份 PDF 已保存，可直接阅读`);
      closeAfterSuccess();
    } else if (hasFailure) {
      setError(
        hasSaved
          ? '部分 PDF 保存失败；已保存的文件不会重复导入，请仅重试未成功项。'
          : 'PDF 保存失败，请检查逐文件结果后重试未成功项。',
      );
      setProgressMessage(
        cancelRequestedRef.current
          ? '已停止保存尚未开始的文件'
          : '保存完成，请查看逐文件结果',
      );
    }
  };

  const submit = () => {
    if (processing) return;
    clearCloseTimer();
    const retryable = files.filter(
      (item) =>
        item.status === 'pending' ||
        item.status === 'failed' ||
        item.status === 'cancelled',
    );
    void runBatch(retryable);
  };

  const retryableCount = files.filter(
    (item) => item.status === 'failed' || item.status === 'cancelled',
  ).length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[90vh] min-h-0 flex-col overflow-hidden sm:max-w-[580px]">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-lg">导入 PDF 到课程</DialogTitle>
          <DialogDescription>
            可一次选择多份 PDF。这里的进度只表示 PDF 是否已保存；保存后即可阅读，后台成果会独立排队处理。
          </DialogDescription>
        </DialogHeader>

        {progressMessage || error ? (
          <div className="shrink-0 space-y-2">
            {progressMessage ? (
              <output
                aria-live="polite"
                className="block rounded-xl border border-violet-100 bg-violet-50/60 p-3"
              >
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-violet-800">
                  {processing ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                  {progressMessage}
                </div>
                <Progress
                  aria-label="PDF 保存进度"
                  value={progress}
                  className="[&_[data-slot=progress-indicator]]:bg-violet-600"
                />
              </output>
            ) : null}

            {error ? (
              <p
                role="alert"
                className="flex max-h-[20vh] items-start gap-2 overflow-y-auto break-words rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <button
            type="button"
            className="mt-2 flex min-h-24 w-full items-center gap-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 text-left transition hover:border-violet-400 hover:bg-violet-50/50 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
            onClick={() => inputRef.current?.click()}
            disabled={processing}
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-violet-600 shadow-sm ring-1 ring-slate-200">
              {files.length ? <FileText className="size-5" /> : <FileUp className="size-5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-slate-800">
                {files.length ? `已选择 ${files.length} 份 PDF` : '选择本地 PDF（可多选）'}
              </span>
              <span className="mt-1 block text-xs text-slate-500">
                {files.length
                  ? '点击可更换文件；保存成功的文件不会在重试时重复导入。'
                  : '导入时会计算内容指纹并拦截重复资料'}
              </span>
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="sr-only"
            aria-label="选择 PDF 文件"
            onChange={chooseFiles}
          />

          {files.length ? (
            <div
              aria-label="待保存 PDF 列表"
              className="space-y-2 rounded-xl border border-slate-200 bg-white p-2"
            >
              {files.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2"
                >
                  <CircleDot className={`mt-0.5 size-3.5 shrink-0 ${fileStatusClass(item.status)}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-slate-800" title={item.file.name}>
                      {item.file.name}
                    </p>
                    <p className={`mt-0.5 text-[11px] ${fileStatusClass(item.status)}`}>
                      {fileStatusLabel(item.status)} · {formatFileSize(item.file.size)}
                    </p>
                    {item.error ? (
                      <p className="mt-0.5 break-words text-[11px] leading-4 text-rose-700">
                        {item.error}
                      </p>
                    ) : null}
                  </div>
                  {item.status === 'saved' ? (
                    <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                  ) : item.status === 'saving' ? (
                    <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-violet-600" />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className="rounded-xl border border-violet-100 bg-violet-50/60 px-3 py-2 text-[11px] leading-5 text-violet-800">
            无需配置 AI 也可以先保存 PDF 并立即阅读。若选择总结、脑图、课程汇总或问答洞察，后台 AI 需要配置「阅读服务设置 → 知识库 AI」；关闭应用会暂停，重新打开后恢复。浏览器模式需要重新授权文件夹后才能恢复后台任务。
          </div>

          <div className="space-y-2">
            <p className="px-1 text-[11px] font-bold tracking-[0.12em] text-slate-500 uppercase">
              生成这个 PDF 的学习成果
            </p>
            <OptionRow
              disabled={processing}
              icon={<BrainCircuit className="size-4" />}
              title="生成 PDF 总结"
              description="后台 AI 概括全文，生成内容概览、章节摘要与来源页码"
              checked={options.generateSummary}
              onCheckedChange={(checked) => updateOption('generateSummary', checked)}
            />
            <OptionRow
              disabled={processing}
              icon={<Network className="size-4" />}
              title="生成 PDF 脑图"
              description="后台 AI 提炼概念节点、真实关系与来源页码"
              checked={options.generateMindmap}
              onCheckedChange={(checked) => updateOption('generateMindmap', checked)}
            />
          </div>

          <div className="space-y-2">
            <p className="px-1 text-[11px] font-bold tracking-[0.12em] text-slate-500 uppercase">
              更新课程知识库
            </p>
            <OptionRow
              disabled={processing}
              icon={<GitMerge className="size-4" />}
              title="并入课程总总结和总脑图"
              description="后台 AI 综合所有已纳入文档，重建跨文档概念、关系与冲突"
              checked={options.mergeIntoCourse}
              onCheckedChange={(checked) => updateOption('mergeIntoCourse', checked)}
            />
            <OptionRow
              disabled={processing}
              icon={<MessageSquareText className="size-4" />}
              title="提炼后续 AI 问答"
              description="后台记录有效学习洞察，不复制整段原始对话"
              checked={options.includeConversationInsights}
              onCheckedChange={(checked) => updateOption('includeConversationInsights', checked)}
            />
          </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            onClick={() => (processing ? requestCancel() : handleOpenChange(false))}
          >
            {processing ? '取消剩余' : '取消'}
          </Button>
          <Button
            onClick={submit}
            disabled={
              !files.length ||
              processing ||
              !files.some((item) => item.status !== 'saved')
            }
          >
            {processing ? <LoaderCircle className="animate-spin" /> : <FileUp />}
            {processing
              ? '保存中…'
              : retryableCount
                ? `重试未完成项（${retryableCount}）`
                : '导入 PDF'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
