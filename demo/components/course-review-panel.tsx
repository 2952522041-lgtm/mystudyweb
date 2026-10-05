'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from './ui/button';
import { SummaryDiffView } from './summary-diff-view';
import { applyAiCourseKnowledge } from '@/lib/knowledge/course-merger';
import { renderCourseSummary } from '@/lib/knowledge/artifact-renderer';
import { compareKnowledge } from '@/lib/course-storage/study-tools';
import { reviewIsCurrent } from '@/lib/course-storage/course-review';
import type { CourseBundle } from '@/lib/course-storage/types';

const CHANGE_LABELS = ['新增', '修改', '移除'] as const;
const CHANGE_KINDS = ['added', 'changed', 'removed'] as const;

export function CourseReviewPanel({
  bundle,
  onResolve,
}: {
  bundle: CourseBundle;
  onResolve: (id: string, accept: boolean) => Promise<void>;
}) {
  const review = bundle.manifest.pendingReview;
  const reviewId = review?.id ?? null;
  const previewId = useId();
  const [validation, setValidation] = useState<{
    bundle: CourseBundle;
    valid: boolean;
  } | null>(null);
  const checked = validation?.bundle === bundle;
  const valid = checked && validation.valid;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expandedFor, setExpandedFor] = useState<string | null>(reviewId);
  const [expanded, setExpanded] = useState(false);

  // A different candidate is a fresh review: always start collapsed.
  if (expandedFor !== reviewId) {
    setExpandedFor(reviewId);
    setExpanded(false);
  }

  useEffect(() => {
    let live = true;
    if (review)
      void reviewIsCurrent(bundle, review).then((current) => {
        if (live) setValidation({ bundle, valid: current });
      });
    return () => {
      live = false;
    };
  }, [bundle, review]);

  const preview = useMemo(() => {
    if (!review) return null;
    try {
      const knowledge = applyAiCourseKnowledge(
        bundle.knowledge,
        review.knowledge,
        review.createdAt,
      );
      return {
        knowledge,
        changes: compareKnowledge(bundle.knowledge, knowledge),
      };
    } catch {
      return null;
    }
  }, [bundle.knowledge, review]);

  if (!review) return null;

  const resolve = async (accept: boolean) => {
    setBusy(true);
    setError('');
    try {
      await onResolve(review.id, accept);
    } catch (err) {
      setError(err instanceof Error ? err.message : '暂时无法处理候选版本。');
    } finally {
      setBusy(false);
    }
  };

  const changes = preview?.changes;

  return (
    <section
      aria-label="课程更新审阅"
      className="mt-5 min-w-0 rounded-xl border border-amber-200 bg-white p-4"
    >
      <h2 className="break-words font-semibold text-slate-900">
        课程更新等待审阅
      </h2>
      <p className="mt-1 break-words text-sm text-slate-600">
        接受后更新课程总结与脑图。保留原成果会放弃本次候选版本，PDF 与成果文件仍保留。
      </p>
      {!valid && (
        <output className="mt-2 block break-words text-xs text-amber-800">
          {checked
            ? '课程内容已变化，请保留原成果后重新生成候选版本。'
            : '正在核对候选版本的来源…'}
        </output>
      )}
      {changes && (
        <p className="mt-3 break-words text-sm text-slate-700">
          新增 {changes.added.length} 个知识点 · 修改 {changes.changed.length} 个 ·
          移除 {changes.removed.length} 个
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 break-words text-sm text-rose-700">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={previewId}
          onClick={() => setExpanded((current) => !current)}
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
        >
          {expanded ? '收起更新预览' : '查看更新预览'}
        </button>
        <Button
          disabled={busy || !valid || !preview}
          onClick={() => void resolve(true)}
        >
          接受更新
        </Button>
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => void resolve(false)}
        >
          保留原成果
        </Button>
      </div>
      <section
        id={previewId}
        aria-label="课程更新预览"
        hidden={!expanded}
        className="mt-3 min-w-0"
      >
        <div
          data-preview-scroll="true"
          className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3"
        >
          {preview ? (
            <>
              <h3 className="text-sm font-semibold text-slate-800">
                知识结构变化
              </h3>
              <ul className="mt-2 space-y-1 text-xs text-slate-700">
                {CHANGE_KINDS.map((kind, index) => (
                  <li key={kind} className="break-words">
                    <span className="font-medium">{CHANGE_LABELS[index]}：</span>
                    {preview.changes[kind]
                      .map((node) => node.label)
                      .join('、') || '无'}
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                <SummaryDiffView
                  before={renderCourseSummary(bundle.manifest, bundle.knowledge)}
                  after={renderCourseSummary(
                    {
                      ...bundle.manifest,
                      documents: bundle.manifest.documents.map((doc) =>
                        review.documentIds.includes(doc.id)
                          ? { ...doc, includedInCourse: true }
                          : doc,
                      ),
                    },
                    preview.knowledge,
                  )}
                  beforeLabel="当前成果"
                  afterLabel="候选成果"
                />
              </div>
            </>
          ) : (
            <output className="block break-words text-xs text-slate-600">
              候选成果暂时无法比较。
            </output>
          )}
        </div>
      </section>
    </section>
  );
}
