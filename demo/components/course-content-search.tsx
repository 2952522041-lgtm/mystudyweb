'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';
import {
  searchCourseContent,
  type CourseSearchHit,
} from '@/lib/course-content-search';
import { extractPdfPages } from '@/lib/knowledge/document-digest';
import type { CourseBundle, CourseStorage } from '@/lib/course-storage/types';

const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const LABELS = {
  knowledge: '知识点',
  note: '笔记',
  document: '资料',
  page: '来源页',
};

interface SearchProps {
  bundle: CourseBundle;
  storage: CourseStorage;
  onSelect: (hit: CourseSearchHit) => void | Promise<void>;
}
export function CourseContentSearch(props: SearchProps) {
  const identity = JSON.stringify([
    props.bundle.manifest.id,
    props.bundle.manifest.documents.map((doc) => [
      doc.id,
      doc.fingerprint,
      doc.pageCount,
    ]),
  ]);
  return <CourseContentSearchSession key={identity} {...props} />;
}
function CourseContentSearchSession({
  bundle,
  storage,
  onSelect,
}: SearchProps) {
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState('');
  const [pages, setPages] = useState<
    Array<{ documentId: string; pages: string[] }>
  >([]);
  const [indexing, setIndexing] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const notesRequest = useRef(0);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const scope = new AbortController();
    lifetime.current = scope;
    return () => scope.abort();
  }, []);
  const loadNotes = async () => {
    const request = ++notesRequest.current;
    const scope = lifetime.current;
    try {
      const value = await storage.loadNotes?.();
      if (!scope.signal.aborted && request === notesRequest.current)
        setNotes(value?.content ?? '');
    } catch {
      if (!scope.signal.aborted && request === notesRequest.current)
        setError('笔记暂时无法读取，其余内容仍可搜索。');
    }
  };
  const hits = useMemo(
    () => searchCourseContent({ bundle, notes, pages, query }),
    [bundle, notes, pages, query],
  );
  const indexPdf = async () => {
    controller.current?.abort();
    const operation = new AbortController();
    controller.current = operation;
    const scope = lifetime.current;
    const cancel = () => operation.abort();
    scope.signal.addEventListener('abort', cancel, { once: true });
    setIndexing(true);
    setError('');
    setPages([]);
    const indexed: typeof pages = [];
    let bytes = 0,
      failures = 0,
      emptyPages = 0;
    try {
      for (const [index, doc] of bundle.manifest.documents.entries()) {
        if (operation.signal.aborted) break;
        setStatus(
          `正在索引 ${index + 1}/${bundle.manifest.documents.length}：${doc.fileName}`,
        );
        try {
          const file = await storage.openPdf(doc.id);
          const extracted = await extractPdfPages(file, {
            signal: operation.signal,
            allowEmptyText: true,
          });
          if (extracted.fingerprint !== doc.fingerprint)
            throw new Error('文件已替换');
          const size = new TextEncoder().encode(
            extracted.pages.join('\n'),
          ).byteLength;
          if (bytes + size > MAX_INDEX_BYTES) {
            setStatus(
              `已索引 ${indexed.length} 份；达到 16 MiB 文字上限，其余资料仍可搜索摘要。`,
            );
            break;
          }
          bytes += size;
          emptyPages += extracted.pages.filter((text) => !text.trim()).length;
          indexed.push({ documentId: doc.id, pages: extracted.pages });
          if (!operation.signal.aborted) setPages([...indexed]);
        } catch {
          if (!operation.signal.aborted) failures++;
        }
        if (
          index === bundle.manifest.documents.length - 1 &&
          !operation.signal.aborted
        )
          setStatus(
            `已索引 ${indexed.length} 份 PDF 的文字层${emptyPages ? `；${emptyPages} 页没有文字层` : ''}${failures ? `；${failures} 份读取失败，可重试` : ''}。`,
          );
      }
    } finally {
      scope.signal.removeEventListener('abort', cancel);
      if (!scope.signal.aborted && controller.current === operation) {
        setIndexing(false);
        if (operation.signal.aborted)
          setStatus(`索引已取消，保留已完成的 ${indexed.length} 份。`);
      }
    }
  };
  return (
    <details
      className="mt-5 rounded-xl border border-slate-200 bg-white p-4"
      onToggle={(event) => {
        if (event.currentTarget.open) void loadNotes();
      }}
    >
      <summary className="cursor-pointer text-sm font-medium">
        搜索课程内容
      </summary>
      <div className="mt-3 space-y-3">
        <input
          aria-label="搜索课程内容"
          value={query}
          onFocus={() => void loadNotes()}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索知识点、摘要、笔记或 PDF 正文…"
          className="w-full rounded-lg border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-violet-500"
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <Button
            size="xs"
            variant="outline"
            disabled={indexing || !bundle.manifest.documents.length}
            onClick={() => void indexPdf()}
          >
            建立全文索引
          </Button>
          {indexing && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => controller.current?.abort()}
            >
              取消索引
            </Button>
          )}
          <span>
            默认搜索已保存的摘要与笔记；全文索引仅在本机读取 PDF 文字层，不调用
            AI。扫描页需已有 OCR 成果。
          </span>
        </div>
        {status && (
          <output className="block text-xs text-slate-500">{status}</output>
        )}
        {error && (
          <p role="alert" className="text-xs text-rose-700">
            {error}
          </p>
        )}
        {query.trim() && (
          <p className="text-xs text-slate-500">
            {hits.length
              ? `显示 ${hits.length} 条结果${hits.length === 50 ? '，可增加关键词缩小范围' : ''}`
              : '当前已索引内容没有匹配结果。'}
          </p>
        )}
        <ul
          aria-label="课程搜索结果"
          className="max-h-80 space-y-2 overflow-y-auto"
        >
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="w-full rounded border p-3 text-left hover:bg-violet-50 focus-visible:outline-2 focus-visible:outline-violet-500"
                onClick={() => {
                  setError('');
                  void Promise.resolve(onSelect(hit)).catch(() =>
                    setError('无法打开该结果，请刷新课程后重试。'),
                  );
                }}
              >
                <span className="block break-words text-sm font-medium">
                  {hit.title}
                </span>
                <span className="block text-xs text-violet-700">
                  {LABELS[hit.kind]}
                  {hit.page ? ` · 第 ${hit.page} 页` : ''}
                  {hit.line ? ` · 第 ${hit.line} 行` : ''}
                </span>
                <span className="mt-1 block break-words text-xs text-slate-600">
                  {hit.excerpt}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
