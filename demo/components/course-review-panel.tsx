'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from './ui/button';
import { SummaryDiffView } from './summary-diff-view';
import { applyAiCourseKnowledge } from '@/lib/knowledge/course-merger';
import { renderCourseSummary } from '@/lib/knowledge/artifact-renderer';
import { compareKnowledge } from '@/lib/course-storage/study-tools';
import { reviewIsCurrent } from '@/lib/course-storage/course-review';
import type { CourseBundle } from '@/lib/course-storage/types';

export function CourseReviewPanel({
  bundle,
  onResolve,
}: {
  bundle: CourseBundle;
  onResolve: (id: string, accept: boolean) => Promise<void>;
}) {
  const review = bundle.manifest.pendingReview;
  const [validation, setValidation] = useState<{
    bundle: CourseBundle;
    valid: boolean;
  } | null>(null);
  const checked = validation?.bundle === bundle;
  const valid = checked && validation.valid;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  return (
    <section
      aria-label="课程更新审阅"
      className="mt-5 rounded-xl border border-violet-200 bg-white p-4"
    >
      <h2 className="font-semibold text-violet-900">课程更新等待审阅</h2>
      <p className="mt-1 text-sm text-slate-600">
        PDF
        和单篇成果已保存。接受后更新课程总结与脑图；保留原成果会放弃本次候选版本。
      </p>
      {!valid && (
        <output className="mt-2 block text-xs text-amber-800">
          {checked
            ? '课程内容已变化，请保留原成果后重新生成候选版本。'
            : '正在核对候选版本的来源…'}
        </output>
      )}
      {preview && (
        <>
          <p className="mt-3 text-sm">
            新增 {preview.changes.added.length} 个知识点 · 修改{' '}
            {preview.changes.changed.length} 个 · 移除{' '}
            {preview.changes.removed.length} 个
          </p>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer">查看知识结构变化</summary>
            {(['added', 'changed', 'removed'] as const).map((kind, index) => (
              <p key={kind} className="mt-2 break-words">
                {['新增', '修改', '移除'][index]}：
                {preview.changes[kind].map((node) => node.label).join('、') ||
                  '无'}
              </p>
            ))}
          </details>
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
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-rose-700">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
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
    </section>
  );
}
