'use client';

import { useId, useMemo, useState } from 'react';
import {
  compareSummaryParagraphs,
  type SummaryDiffSegment,
} from '../lib/summary-diff.ts';

const PAGE_SIZE = 20;

const KIND_LABEL: Record<SummaryDiffSegment['kind'], string> = {
  equal: '未变',
  added: '新增',
  removed: '移除',
};

const KIND_CLASS: Record<SummaryDiffSegment['kind'], string> = {
  equal: 'border-slate-200 bg-slate-50 text-slate-700',
  added: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  removed: 'border-rose-200 bg-rose-50 text-rose-900',
};

export interface SummaryDiffViewProps {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
}

export function SummaryDiffView({
  before,
  after,
  beforeLabel = '起始版本',
  afterLabel = '对比版本',
}: SummaryDiffViewProps) {
  const headingId = useId();
  const checkboxId = useId();
  const comparisonKey = JSON.stringify([before, after]);
  const [controlsKey, setControlsKey] = useState(comparisonKey);
  const [changesOnly, setChangesOnly] = useState(true);
  const [limit, setLimit] = useState(PAGE_SIZE);

  // A different pair of summaries is a fresh comparison: restore the controls.
  // Adjusting state during render is the supported way to react to prop changes.
  if (controlsKey !== comparisonKey) {
    setControlsKey(comparisonKey);
    setChangesOnly(true);
    setLimit(PAGE_SIZE);
  }

  const diff = useMemo(
    () => compareSummaryParagraphs(before, after),
    [before, after],
  );
  const filtered = changesOnly
    ? diff.segments.filter((segment) => segment.kind !== 'equal')
    : diff.segments;
  const visible = filtered.slice(0, limit);
  const hasMore = filtered.length > visible.length;
  const empty = diff.segments.length === 0;
  const noChanges = !empty && diff.added === 0 && diff.removed === 0;

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-md border border-slate-200 p-4 text-sm text-slate-900"
    >
      <h3 id={headingId} className="text-base font-semibold">
        总结文字差异
      </h3>

      <p className="flex flex-wrap items-center gap-2 text-slate-600">
        <span className="font-medium text-slate-800">{beforeLabel}</span>
        <span aria-hidden="true">→</span>
        <span className="font-medium text-slate-800">{afterLabel}</span>
      </p>

      <p className="text-slate-600">
        {`新增 ${diff.added} 段 · 移除 ${diff.removed} 段 · 未变 ${diff.unchanged} 段`}
      </p>

      {diff.coarse ? (
        <output className="block text-amber-700">
          内容较长，显示简化差异。
        </output>
      ) : null}

      {empty ? (
        <output className="block text-slate-600">没有可比较的总结文字。</output>
      ) : null}

      {noChanges ? (
        <output className="block text-slate-600">总结文字没有变化。</output>
      ) : null}

      <label
        htmlFor={checkboxId}
        className="flex w-fit cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue-600"
      >
        <input
          id={checkboxId}
          type="checkbox"
          checked={changesOnly}
          onChange={(event) => {
            setChangesOnly(event.target.checked);
            setLimit(PAGE_SIZE);
          }}
          className="h-4 w-4 accent-blue-600"
        />
        只看改动
      </label>

      {visible.length > 0 ? (
        <ul className="space-y-2">
          {visible.map((segment, index) => (
            <li
              key={`${segment.kind}-${index}`}
              data-diff-kind={segment.kind}
              className={`rounded-sm border p-2 ${KIND_CLASS[segment.kind]}`}
            >
              <span className="mb-1 block text-xs font-semibold">
                {KIND_LABEL[segment.kind]}
              </span>
              <div data-diff-text className="whitespace-pre-wrap break-words">
                {segment.text}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {hasMore ? (
        <button
          type="button"
          onClick={() => {
            setLimit((current) => current + PAGE_SIZE);
          }}
          className="rounded-sm border border-slate-300 bg-white px-3 py-1 font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          显示更多
        </button>
      ) : null}
    </section>
  );
}
