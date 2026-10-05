'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { DSH_ERRORS, isDshErrorCode } from '@/electron/dsh-errors';
import type { DshRunRecord } from '@/electron/dsh-history';
import { formatTaskDuration } from '@/lib/background-task-presentation';

const PAGE_SIZE = 20;
const REFRESH_INTERVAL_MS = 5000;

const RECORDS_NOTE =
  '仅保留最近 200 条完成或失败的调用记录；未提供 token 用量时不估算费用。已取消的调用也会保留。';
const TOTAL_NOTE =
  '总时长包含重试等待时间，因此排队、启动与执行时长之和不要求与总时长完全相等。';

type StatusFilter = 'all' | 'failed' | 'completed' | 'cancelled';

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: '全部状态',
  failed: '失败',
  completed: '已完成',
  cancelled: '已取消',
};

const TASK_LABELS: Record<DshRunRecord['task'], string> = {
  interactive: '交互',
  background: '后台',
  prefetch: '预取',
};

const STATUS_LABELS: Record<DshRunRecord['status'], string> = {
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function errorText(code: DshRunRecord['errorCode']): string | undefined {
  return isDshErrorCode(code) ? DSH_ERRORS[code] : undefined;
}

function formatStartedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function DshDiagnosticsPanel({
  loadRecords,
}: {
  loadRecords: () => Promise<DshRunRecord[]>;
}) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<DshRunRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const requestSeqRef = useRef(0);
  const loaderRef = useRef(loadRecords);
  const filterId = useId();

  useEffect(() => {
    loaderRef.current = loadRecords;
  }, [loadRecords]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
      inFlightRef.current = false;
    };
  }, []);

  const runLoad = useCallback(async (mode: 'auto' | 'manual') => {
    // Periodic refresh never overlaps another request; a manual refresh may
    // supersede an in-flight one, and the newer sequence wins.
    if (mode === 'auto' && inFlightRef.current) return;
    const seq = ++requestSeqRef.current;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const next = await loaderRef.current();
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      setRecords(Array.isArray(next) ? next : []);
      setLoaded(true);
      setError(null);
    } catch {
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      setLoaded(true);
      setError('运行记录加载失败，请点击刷新重试。');
    } finally {
      if (seq === requestSeqRef.current) {
        inFlightRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void runLoad('auto');
    const timer = window.setInterval(() => {
      void runLoad('auto');
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [open, runLoad]);

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  };

  const handleFilterChange = (next: StatusFilter) => {
    setFilter(next);
    setVisibleCount(PAGE_SIZE);
  };

  const filtered =
    filter === 'all'
      ? records
      : records.filter((record) => record.status === filter);
  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;

  return (
    <details onToggle={handleToggle} style={{ width: '100%' }}>
      <summary style={{ cursor: 'pointer' }}>DSH 运行记录</summary>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.5rem',
          marginTop: '0.5rem',
        }}
      >
        <label htmlFor={filterId}>状态筛选</label>
        <select
          id={filterId}
          value={filter}
          aria-label="按状态筛选 DSH 运行记录"
          onChange={(event) =>
            handleFilterChange(event.target.value as StatusFilter)
          }
        >
          {(Object.keys(FILTER_LABELS) as StatusFilter[]).map((key) => (
            <option key={key} value={key}>
              {FILTER_LABELS[key]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void runLoad('manual')}
          aria-busy={loading}
        >
          刷新
        </button>
      </div>

      <div aria-live="polite">
        {loading && records.length === 0 ? (
          <output>正在加载运行记录…</output>
        ) : null}
        {loading && records.length > 0 ? (
          <output>正在刷新运行记录…</output>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>

      {loaded && !loading && !error && records.length === 0 ? (
        <p>暂无运行记录。</p>
      ) : null}
      {records.length > 0 && filtered.length === 0 ? (
        <p>没有符合当前筛选条件的记录。</p>
      ) : null}

      <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
        {visible.map((record) => {
          const message = errorText(record.errorCode);
          return (
            <li
              key={record.id}
              data-dsh-record
              style={{
                borderTop: '1px solid rgba(128, 128, 128, 0.35)',
                padding: '0.5rem 0',
                overflowWrap: 'anywhere',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.25rem 0.75rem',
                }}
              >
                <strong>{record.model}</strong>
                <span>{TASK_LABELS[record.task] ?? record.task}</span>
                <span>{STATUS_LABELS[record.status] ?? record.status}</span>
                <time dateTime={record.startedAt}>
                  {formatStartedAt(record.startedAt)}
                </time>
              </div>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.25rem 0.75rem',
                }}
              >
                <span>排队 {formatTaskDuration(record.queueMs)}</span>
                <span>启动 {formatTaskDuration(record.startupMs)}</span>
                <span>执行 {formatTaskDuration(record.executionMs)}</span>
                <span>总时长 {formatTaskDuration(record.totalMs)}</span>
                <span>重试 {record.retries} 次</span>
              </div>
              {record.reused === true ? <p>复用并发结果</p> : null}
              {message ? <p>{message}</p> : null}
            </li>
          );
        })}
      </ul>

      {hasMore ? (
        <button
          type="button"
          onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
        >
          显示更多记录
        </button>
      ) : null}

      <p style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>{RECORDS_NOTE}</p>
      <p style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>{TOTAL_NOTE}</p>
    </details>
  );
}
