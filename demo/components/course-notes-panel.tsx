'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { KnowledgeMarkdown } from '@/components/knowledge-section';
import type { CourseStorage } from '@/lib/course-storage/types';
import type { CourseNotesSnapshot } from '@/lib/course-storage/study-tools';

export function CourseNotesPanel({
  storage,
  courseId,
  focusRequest,
}: {
  storage: CourseStorage;
  courseId: string;
  focusRequest?: {line:number;key:number};
}) {
  const [snapshot, setSnapshot] = useState<CourseNotesSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [external, setExternal] = useState<CourseNotesSnapshot | null>(null);
  const [preview, setPreview] = useState(false);
  const dirty = snapshot !== null && snapshot.content !== draft;
  const editor = useRef<HTMLTextAreaElement>(null);
  const focused = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!snapshot || !focusRequest || focused.current === focusRequest.key) return;
    setPreview(false);
    const timer = setTimeout(() => {
      if (!editor.current) return;
      const lines = editor.current.value.split('\n');
      const index = Math.max(0, Math.min(focusRequest.line-1,lines.length-1));
      const start = lines.slice(0,index).reduce((size,line) => size+line.length+1,0);
      editor.current.focus(); editor.current.setSelectionRange(start,start+lines[index].length);
      editor.current.scrollIntoView({block:'center'});
      focused.current = focusRequest.key;
    },0);
    return () => clearTimeout(timer);
  }, [snapshot,focusRequest]);
  useEffect(() => {
    let cancelled = false;
    void storage
      .loadNotes?.()
      .then((value) => {
        if (!cancelled) {
          let saved:
            | { snapshot: CourseNotesSnapshot; draft: string }
            | undefined;
          try {
            const raw = sessionStorage.getItem(`course-note-draft:${courseId}`);
            if (raw) saved = JSON.parse(raw);
          } catch {
            /* Session storage is optional. */
          }
          if (
            saved &&
            typeof saved.draft === 'string' &&
            typeof saved.snapshot?.token === 'string' &&
            typeof saved.snapshot.content === 'string'
          ) {
            setSnapshot(saved.snapshot);
            setDraft(saved.draft);
            setStatus('已恢复未保存草稿。');
            if (saved.snapshot.token !== value.token) setExternal(value);
          } else {
            setSnapshot(value);
            setDraft(value.content);
          }
        }
      })
      .catch((error) => {
        if (!cancelled)
          setStatus(error instanceof Error ? error.message : '笔记读取失败。');
      });
    return () => {
      cancelled = true;
    };
  }, [storage, courseId]);
  useEffect(() => {
    if (!snapshot) return;
    try {
      const key = `course-note-draft:${courseId}`;
      if (dirty)
        sessionStorage.setItem(key, JSON.stringify({ snapshot, draft }));
      else sessionStorage.removeItem(key);
    } catch {
      /* beforeunload still protects unsaved work if storage is full. */
    }
  }, [snapshot, draft, dirty, courseId]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  return (
    <section className="space-y-4 p-6" aria-label="课程笔记">
      <div>
        <h2 className="font-semibold">我的课程笔记</h2>
        <p className="mt-1 text-xs text-slate-500">
          保存到课程文件夹中的“我的课程笔记.md”。摘记会保留来源页码和记录时间。
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!dirty || pending || !storage.saveNotes}
          onClick={async () => {
            if (!snapshot || !storage.saveNotes) return;
            setPending(true);
            setStatus('');
            try {
              setSnapshot(await storage.saveNotes(draft, snapshot.token));
              setExternal(null);
              setStatus('笔记已保存。');
            } catch (error) {
              setStatus(
                error instanceof Error
                  ? error.message
                  : '保存失败，草稿已保留。',
              );
              const latest = await storage.loadNotes?.().catch(() => undefined);
              if (latest) setExternal(latest);
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? '保存中…' : '保存笔记'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPreview((value) => !value)}
        >
          {preview ? '继续编辑' : '预览'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={async () => {
            try {
              const latest = await storage.loadNotes?.();
              if (!latest) return;
              if (dirty) {
                setExternal(latest);
                setStatus('本地草稿保留在编辑区；下方显示文件最新内容。');
              } else {
                setSnapshot(latest);
                setDraft(latest.content);
                setStatus('已重新加载。');
              }
            } catch (error) {
              setStatus(
                error instanceof Error ? error.message : '重新加载失败。',
              );
            }
          }}
        >
          重新加载
        </Button>
        <span className="self-center text-xs text-amber-700">
          {dirty ? '有未保存修改' : ''}
        </span>
      </div>
      <output className="block text-xs text-slate-600" aria-live="polite">
        {status}
      </output>
      {preview ? (
        <KnowledgeMarkdown>{draft}</KnowledgeMarkdown>
      ) : (
        <textarea
          ref={editor}
          aria-label="编辑课程笔记"
          className="min-h-80 w-full rounded-xl border border-slate-200 p-4 text-sm leading-7"
          value={draft}
          disabled={!snapshot}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      {external ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-semibold">
            文件最新内容（草稿保留在上方）
          </h3>
          <pre className="my-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
            {external.content}
          </pre>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSnapshot(external);
              setExternal(null);
              setStatus(
                '已更新比较基准，请先将需要保留的最新内容合并到草稿，再保存。',
              );
            }}
          >
            我已手动合并，使用最新版本作为基准
          </Button>
        </div>
      ) : null}
    </section>
  );
}
