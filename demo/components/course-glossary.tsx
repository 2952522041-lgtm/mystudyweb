'use client';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  EMPTY_GLOSSARY,
  exportGlossary,
  importGlossary,
  reviseGlossary,
  type Glossary,
  type GlossaryEntry,
} from '@/lib/glossary';
import { auditCourseTerminology } from '@/lib/glossary-audit';
import { createReaderService } from '@/lib/reader-cache';
import type { CourseBundle, CourseStorage } from '@/lib/course-storage/types';

export function CourseGlossary({
  storage,
  bundle,
  disabled,
  onLocate,
}: {
  storage: CourseStorage;
  bundle: CourseBundle;
  disabled?: boolean;
  onLocate: (documentId: string, page: number) => void;
}) {
  const importId = useId();
  const [open, setOpen] = useState(false);
  const [glossary, setGlossary] = useState<Glossary>(EMPTY_GLOSSARY);
  const [rows, setRows] = useState<GlossaryEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [scope, setScope] = useState('');
  const [audit, setAudit] = useState<ReturnType<
    typeof auditCourseTerminology
  > | null>(null);
  const dirty = JSON.stringify(rows) !== JSON.stringify(glossary.entries);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const value = (await storage.loadGlossary?.()) ?? EMPTY_GLOSSARY;
        if (!cancelled) {
          setGlossary(value);
          setRows(value.entries);
          setReady(true);
        }
      } catch (failure) {
        if (!cancelled) setError(String(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, storage]);
  const update = (index: number, patch: Partial<GlossaryEntry>) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    setAudit(null);
    setStatus('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (!storage.saveGlossary) throw new Error('当前课程存储不支持术语表。');
      const next = reviseGlossary(
        glossary,
        rows.map((row) => ({
          ...row,
          forbidden: row.forbidden.filter((word) => word.trim()),
        })),
      );
      await storage.saveGlossary(next);
      setGlossary(next);
      setRows(next.entries);
      setAudit(null);
      setStatus(
        `已保存版本 ${next.version}。重新打开文档后生效；已有知识库成果需重新生成。`,
      );
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => {
          setReady(false);
          setError('');
          setAudit(null);
          setStatus('');
          setOpen(true);
        }}
      >
        课程术语表
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>课程术语表 · {bundle.manifest.name}</DialogTitle>
            <DialogDescription>
              保存在课程目录 glossary.json（格式
              v1）。源词区分大小写；公式与数学符号仍按原文保留。当前版本{' '}
              {glossary.version}。
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={!ready || busy} className="min-w-0 space-y-3">
            <div
              className="max-h-72 space-y-3 overflow-auto"
              aria-label="术语条目"
            >
              {rows.map((entry, index) => (
                <div
                  key={index}
                  className="grid grid-cols-2 gap-2 rounded-lg border p-3"
                >
                  <Input
                    aria-label={`源词 ${index + 1}`}
                    placeholder="源词"
                    value={entry.source}
                    onChange={(event) =>
                      update(index, { source: event.target.value })
                    }
                  />
                  <Input
                    aria-label={`目标译法 ${index + 1}`}
                    placeholder="目标译法"
                    value={entry.target}
                    onChange={(event) =>
                      update(index, { target: event.target.value })
                    }
                  />
                  <Input
                    aria-label={`禁用译法 ${index + 1}`}
                    placeholder="禁用译法，用 | 分隔"
                    value={entry.forbidden.join('|')}
                    onChange={(event) =>
                      update(index, {
                        forbidden: event.target.value.split('|'),
                      })
                    }
                  />
                  <Input
                    aria-label={`备注 ${index + 1}`}
                    placeholder="备注（可选）"
                    value={entry.note}
                    onChange={(event) =>
                      update(index, { note: event.target.value })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setRows(rows.filter((_, i) => i !== index));
                      setAudit(null);
                    }}
                  >
                    删除第 {index + 1} 条
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setRows([
                    ...rows,
                    { source: '', target: '', forbidden: [], note: '' },
                  ])
                }
              >
                新增术语
              </Button>
              <Button size="sm" onClick={() => void save()}>
                保存术语表
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  try {
                    const data = exportGlossary({
                      ...glossary,
                      entries: rows.map((row) => ({
                        ...row,
                        forbidden: row.forbidden.filter((word) => word.trim()),
                      })),
                    });
                    const url = URL.createObjectURL(
                      new Blob([data], { type: 'application/json' }),
                    );
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'glossary.json';
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 0);
                  } catch (failure) {
                    setError(String(failure));
                  }
                }}
              >
                导出 JSON
              </Button>
              <label className="text-xs" htmlFor={importId}>
                导入 JSON
              </label>
              <Input
                id={importId}
                type="file"
                accept=".json,application/json"
                aria-label="导入术语表 JSON"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  try {
                    if (file.size > 512000)
                      throw new Error('术语表超过 512 KB。');
                    setRows(importGlossary(await file.text()).entries);
                    setAudit(null);
                    setError('');
                    setStatus('已导入草稿，保存后生效。');
                  } catch (failure) {
                    setError(String(failure));
                  }
                  event.target.value = '';
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2 border-t pt-3">
              <select
                aria-label="一致性检查范围"
                className="rounded border p-2 text-sm"
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value);
                  setAudit(null);
                }}
              >
                <option value="">整个课程</option>
                {bundle.manifest.documents.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.fileName}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                disabled={dirty}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    setAudit(
                      auditCourseTerminology(
                        bundle,
                        glossary,
                        await createReaderService().cache.list(),
                        scope || undefined,
                      ),
                    );
                  } catch (failure) {
                    setError(String(failure));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                检查译名一致性
              </Button>
            </div>
            {dirty ? (
              <p className="text-xs text-amber-700">
                有未保存的修改，请保存后检查。
              </p>
            ) : null}
          </fieldset>
          {status ? (
            <output className="text-sm text-emerald-700">{status}</output>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-rose-700">
              {error}
            </p>
          ) : null}
          {audit ? (
            <section aria-label="术语一致性结果" className="space-y-2 text-sm">
              <p>
                检查 {audit.passages} 段成果，发现 {audit.issues.length}{' '}
                项疑似不一致。
              </p>
              <p className="text-xs text-slate-500">
                本机译文覆盖 {audit.translatedPages}/{audit.totalPages} 页，其中{' '}
                {audit.sourceAlignedPages}{' '}
                页有原文段落对齐。无原文的旧缓存与知识库仅检查禁用译法；未生成或不在本机的译文未检查。规则检查不识别未登记的同义译法。
              </p>
              {audit.issues.map((issue, index) => (
                <div key={index} className="rounded border p-2">
                  <button
                    className="text-violet-700 underline"
                    onClick={() => {
                      setOpen(false);
                      onLocate(issue.documentId, issue.pageNumber);
                    }}
                  >
                    {issue.fileName} · 第 {issue.pageNumber} 页 ·{' '}
                    {issue.kind === 'translation'
                      ? '译文'
                      : issue.kind === 'digest'
                        ? '摘要'
                        : '课程知识'}
                    段落 {issue.paragraph}
                  </button>
                  <p>
                    {issue.term} → {issue.expected}：
                    {issue.reason === 'forbidden'
                      ? `命中禁用译法「${issue.actual}」`
                      : '原文命中术语，但译文缺少目标译法'}
                  </p>
                  <p className="line-clamp-3 text-xs text-slate-500">
                    {issue.text}
                  </p>
                </div>
              ))}
            </section>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
