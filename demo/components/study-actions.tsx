'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function StudyActions({
  onAsk,
  onSave,
}: {
  onAsk?: () => void;
  onSave?: () => Promise<void>;
}) {
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  if (!onAsk && !onSave) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {onAsk ? (
        <Button size="xs" variant="outline" onClick={onAsk}>
          继续追问
        </Button>
      ) : null}
      {onSave ? (
        <Button
          size="xs"
          variant="outline"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setStatus('');
            try {
              await onSave();
              setStatus('已加入课程笔记');
            } catch (error) {
              setStatus(
                error instanceof Error ? error.message : '保存失败，请重试。',
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? '保存中…' : '加入课程笔记'}
        </Button>
      ) : null}
      <output className="text-xs text-slate-600" aria-live="polite">
        {status}
      </output>
    </div>
  );
}

export function MarkdownActions({
  content,
  fileName,
}: {
  content: string;
  fileName: string;
}) {
  const [status, setStatus] = useState('');
  return (
    <div className="my-4 flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(content);
            setStatus('已复制');
          } catch {
            setStatus('复制失败，请下载 Markdown。');
          }
        }}
      >
        复制总结
      </Button>
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          const url = URL.createObjectURL(
            new Blob([content], { type: 'text/markdown;charset=utf-8' }),
          );
          const link = document.createElement('a');
          link.href = url;
          link.download = fileName.replace(/[<>:"/\\|?*]/g, '_');
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        下载 Markdown
      </Button>
      <output className="text-xs text-slate-500" aria-live="polite">
        {status}
      </output>
    </div>
  );
}
