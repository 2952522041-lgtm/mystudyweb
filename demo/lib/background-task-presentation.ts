/**
 * Dependency-free presentation helpers for background task UI.
 *
 * Only pure functions live here: no imports, no side effects, no mutation of
 * caller-provided data.
 */

export const KNOWN_TASK_STATUSES = [
  'running',
  'queued',
  'paused',
  'failed',
  'cancelled',
  'completed',
] as const;

export type KnownTaskStatus = (typeof KNOWN_TASK_STATUSES)[number];

export interface TaskCounts {
  running: number;
  queued: number;
  paused: number;
  failed: number;
  cancelled: number;
  completed: number;
  total: number;
}

const EM_DASH = '\u2014';

/**
 * Render a duration in milliseconds as a short, human-readable Chinese label.
 *
 * - non-finite or negative input: "—"
 * - 0..999 ms: "不足 1 秒"
 * - < 60 s: "<floor seconds> 秒"
 * - < 1 h: "<floor minutes> 分 <two-digit seconds> 秒"
 * - >= 1 h: "<floor hours> 小时 <two-digit minutes> 分"
 */
export function formatTaskDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return EM_DASH;
  }

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) {
    return '不足 1 秒';
  }
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${totalMinutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} 小时 ${String(minutes).padStart(2, '0')} 分`;
}

/**
 * Tally tasks by their exact, known status.
 *
 * Unknown statuses are ignored, `total` is the number of recognized tasks
 * (the sum of the six known buckets), and the input is never mutated.
 */
export function summarizeTaskCounts(
  tasks: ReadonlyArray<{ status: string }>,
): TaskCounts {
  const counts: TaskCounts = {
    running: 0,
    queued: 0,
    paused: 0,
    failed: 0,
    cancelled: 0,
    completed: 0,
    total: 0,
  };

  const known = new Set<string>(KNOWN_TASK_STATUSES);
  for (const task of tasks) {
    const status = task.status;
    if (known.has(status)) {
      counts[status as KnownTaskStatus] += 1;
      counts.total += 1;
    }
  }

  return counts;
}
