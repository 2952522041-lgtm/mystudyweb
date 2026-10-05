'use client';

import { useState } from 'react';
import { Button } from './ui/button';
import type { CourseRestorePreview } from '@/electron/api';

export function CourseBackupActions({
  directoryName,
  onRestored,
}: {
  directoryName?: string;
  onRestored: (value: {
    directoryName: string;
    courseId: string;
    name: string;
  }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CourseRestorePreview | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const api = typeof window !== 'undefined' ? window.yeyuDesktop : undefined;
  if (
    !api?.exportCourseBackup ||
    !api.prepareCourseRestore ||
    !api.restoreCourseBackup
  )
    return null;
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
    } catch (err) {
      setError(err instanceof Error ? err.message : '备份操作失败。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="mb-4 rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <summary className="cursor-pointer font-medium">课程备份与恢复</summary>
      <p className="my-2 text-xs text-slate-500">
        桌面版备份包含
        PDF、已保存笔记、摘要、脑图、历史、术语表与已发布译文。请先保存正在编辑的内容。恢复会创建新课程，未完成的整理任务保持暂停。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !directoryName}
          onClick={() =>
            void run(async () => {
              const result = await api.exportCourseBackup!(directoryName!);
              if (result)
                setMessage(
                  `完整备份已保存：${result.directory}（${result.files} 个文件）`,
                );
            })
          }
        >
          备份当前课程
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setPreview(await api.prepareCourseRestore!());
            })
          }
        >
          选择备份恢复
        </Button>
      </div>
      {busy && (
        <output className="mt-2 block text-xs">
          正在复制或校验课程文件，请稍候…
        </output>
      )}
      {preview && (
        <div className="mt-3 rounded border border-violet-200 p-3">
          <p>
            {preview.name} · {preview.documents} 份 PDF · {preview.files} 个文件
            · {(preview.bytes / 1024 / 1024).toFixed(1)} MiB
          </p>
          <p className="mt-1 text-xs text-slate-500">
            备份时间：{new Date(preview.createdAt).toLocaleString()}
            。文件校验已通过。
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const token = preview.token;
                  setPreview(null);
                  const result = await api.restoreCourseBackup!(token);
                  await onRestored(result);
                  setMessage(`已恢复为新课程：${result.name}`);
                })
              }
            >
              恢复为新课程
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              取消恢复
            </Button>
          </div>
        </div>
      )}
      {message && (
        <output className="mt-2 block break-all text-xs text-emerald-700">
          {message}
        </output>
      )}
      {error && (
        <p role="alert" className="mt-2 break-words text-xs text-rose-700">
          {error}
        </p>
      )}
    </details>
  );
}
