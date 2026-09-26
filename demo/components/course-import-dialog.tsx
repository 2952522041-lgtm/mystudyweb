'use client';

import { useRef, useState } from 'react';
import type { SynthesisDiagnostic } from '@/lib/knowledge/hierarchical-synthesis';
import {
  BrainCircuit,
  FileText,
  FileUp,
  GitMerge,
  LoaderCircle,
  MessageSquareText,
  Network,
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
import type { ImportOptions } from '@/lib/course-storage/types';

const DEFAULT_OPTIONS: ImportOptions = {
  generateSummary: true,
  generateMindmap: true,
  mergeIntoCourse: true,
  includeConversationInsights: true,
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
      <Switch aria-label={title} disabled={disabled} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

export function CourseImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (
    file: File,
    options: ImportOptions,
    onProgress: (message: string, percent: number) => void,
    signal?: AbortSignal,
    onDiagnostic?: (diagnostic: SynthesisDiagnostic) => void,
  ) => Promise<string | void>;
}) {
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<SynthesisDiagnostic[]>([]);
  const [processing, setProcessing] = useState(false);

  const updateOption = (key: keyof ImportOptions, checked: boolean) =>
    setOptions((previous) => ({ ...previous, [key]: checked }));

  const submit = async () => {
    if (!file) return;
    setProcessing(true);
    setDiagnostics([]);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(3);
    setProgressMessage('准备复制到课程文件夹');
    try {
      const completionMessage = await onImport(file, options, (message, percent) => {
        setProgressMessage(message);
        setProgress(percent);
      }, controller.signal, diagnostic => setDiagnostics(previous => [...previous, diagnostic]));
      setProgress(100);
      setProgressMessage(completionMessage ?? '处理完成，成果已保存到本地');
      setTimeout(() => {
        onOpenChange(false);
        setFile(null);
        setProgress(0);
        setProgressMessage('');
      }, 450);
    } catch (importError) {
      setProgressMessage('处理已停止，可检查设置后重试');
      setError(
        importError instanceof Error ? importError.message : '导入失败。',
      );
    } finally {
      abortRef.current = null;
      setProcessing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={processing ? undefined : onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[580px]">
        <DialogHeader>
          <DialogTitle className="text-lg">导入 PDF 到课程</DialogTitle>
          <DialogDescription>
            文件会复制到课程的 PDFs 目录，原文件不会被修改。
            同一课程中内容相同的 PDF（即使文件名不同）会直接跳过，不进行文字提取或 AI 分析。
          </DialogDescription>
        </DialogHeader>

        <button
          type="button"
          className="mt-2 flex min-h-24 w-full items-center gap-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 text-left transition hover:border-violet-400 hover:bg-violet-50/50 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
          onClick={() => inputRef.current?.click()}
          disabled={processing}
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-violet-600 shadow-sm ring-1 ring-slate-200">
            {file ? (
              <FileText className="size-5" />
            ) : (
              <FileUp className="size-5" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-slate-800">
              {file?.name ?? '选择本地 PDF'}
            </span>
            <span className="mt-1 block text-xs text-slate-500">
              {file
                ? `${(file.size / 1_048_576).toFixed(1)} MB · 点击可更换`
                : '导入时会计算内容指纹并拦截重复资料'}
            </span>
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setError(null);
            event.target.value = '';
          }}
        />

        <div className="rounded-xl border border-violet-100 bg-violet-50/60 px-3 py-2 text-[11px] leading-5 text-violet-800">
          总结、脑图和课程合并都由 AI 生成，使用「阅读服务设置 → 知识库
          AI」中保存的接口地址、API Key 与模型。文字型 PDF
          会先在本地提取；扫描或手写页面会使用「AI 答疑」中的视觉模型进行
          OCR，并把对应页面图像发送给该服务。识别结果与 AI 分析会缓存在本机。
          即使关闭下面的可见成果选项，导入仍需知识库 AI 建立内部摘要；这些选项控制成果保存和课程合并。
        </div>

        <div className="space-y-2">
          <p className="px-1 text-[11px] font-bold tracking-[0.12em] text-slate-500 uppercase">
            生成这个 PDF 的学习成果
          </p>
          <OptionRow
            disabled={processing}
            icon={<BrainCircuit className="size-4" />}
            title="生成 PDF 总结"
            description="AI 概括全文，生成内容概览、章节摘要与来源页码"
            checked={options.generateSummary}
            onCheckedChange={(checked) =>
              updateOption('generateSummary', checked)
            }
          />
          <OptionRow
            disabled={processing}
            icon={<Network className="size-4" />}
            title="生成 PDF 脑图"
            description="AI 提炼概念节点、真实关系与来源页码"
            checked={options.generateMindmap}
            onCheckedChange={(checked) =>
              updateOption('generateMindmap', checked)
            }
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
            description="AI 综合所有已纳入文档，重建跨文档概念、关系与冲突"
            checked={options.mergeIntoCourse}
            onCheckedChange={(checked) =>
              updateOption('mergeIntoCourse', checked)
            }
          />
          <OptionRow
            disabled={processing}
            icon={<MessageSquareText className="size-4" />}
            title="提炼后续 AI 问答"
            description="仅记录有效学习洞察，不复制整段原始对话"
            checked={options.includeConversationInsights}
            onCheckedChange={(checked) =>
              updateOption('includeConversationInsights', checked)
            }
          />
        </div>

        {progressMessage ? (
          <output aria-live="polite" className="block rounded-xl border border-violet-100 bg-violet-50/60 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-violet-800">
              {processing ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              {progressMessage}
            </div>
            <Progress
              aria-label="课程导入进度"
              value={progress}
              className="[&_[data-slot=progress-indicator]]:bg-violet-600"
            />
          </output>
        ) : null}

        {error ? (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}

        {diagnostics.length ? <details className="max-h-48 overflow-auto text-xs"><summary>分层生成诊断（{diagnostics.length}）</summary><pre className="whitespace-pre-wrap">{JSON.stringify(diagnostics, null, 2)}</pre></details> : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => processing ? abortRef.current?.abort() : onOpenChange(false)}
            disabled={processing && progress >= 90}
          >
            {processing ? '取消生成' : '取消'}
          </Button>
          <Button onClick={() => void submit()} disabled={!file || processing}>
            {processing ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <FileUp />
            )}
            {processing ? '正在处理…' : error ? '重试导入' : '导入并处理'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
