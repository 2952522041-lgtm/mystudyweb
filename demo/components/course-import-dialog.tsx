'use client';

import { useRef, useState } from 'react';
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
  onCheckedChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
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
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
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
  ) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const updateOption = (key: keyof ImportOptions, checked: boolean) =>
    setOptions((previous) => ({ ...previous, [key]: checked }));

  const submit = async () => {
    if (!file) return;
    setProcessing(true);
    setError(null);
    setProgress(3);
    setProgressMessage('准备复制到课程文件夹');
    try {
      await onImport(file, options, (message, percent) => {
        setProgressMessage(message);
        setProgress(percent);
      });
      setProgress(100);
      setProgressMessage('处理完成，成果已保存到本地');
      setTimeout(() => {
        onOpenChange(false);
        setFile(null);
        setProgress(0);
        setProgressMessage('');
      }, 450);
    } catch (importError) {
      setError(
        importError instanceof Error ? importError.message : '导入失败。',
      );
    } finally {
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
              {file?.name ?? '选择本地文字型 PDF'}
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

        <div className="space-y-2">
          <p className="px-1 text-[11px] font-bold tracking-[0.12em] text-slate-500 uppercase">
            生成这个 PDF 的学习成果
          </p>
          <OptionRow
            icon={<BrainCircuit className="size-4" />}
            title="生成 PDF 总结"
            description="生成客观内容概览、章节摘要与来源页码"
            checked={options.generateSummary}
            onCheckedChange={(checked) =>
              updateOption('generateSummary', checked)
            }
          />
          <OptionRow
            icon={<Network className="size-4" />}
            title="生成 PDF 脑图"
            description="创建可追溯到页码的概念节点和关系"
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
            icon={<GitMerge className="size-4" />}
            title="并入课程总总结和总脑图"
            description="通过内部结构化摘要增量更新，保留原有来源"
            checked={options.mergeIntoCourse}
            onCheckedChange={(checked) =>
              updateOption('mergeIntoCourse', checked)
            }
          />
          <OptionRow
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
          <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-violet-800">
              {processing ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              {progressMessage}
            </div>
            <Progress
              value={progress}
              className="[&_[data-slot=progress-indicator]]:bg-violet-600"
            />
          </div>
        ) : null}

        {error ? (
          <p className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={processing}
          >
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!file || processing}>
            {processing ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <FileUp />
            )}
            导入并处理
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
