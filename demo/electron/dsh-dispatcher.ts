import { createHash } from 'node:crypto';
import { DshManager } from './dsh-manager.ts';
import { validateDshRequest } from './dsh-policy.ts';
import { DshError, safeDshError } from './dsh-errors.ts';
import type {
  DshCompletionRequest,
  DshCompletionResult,
  DshProgress,
} from './dsh-types.ts';

interface Pending {
  owner: number;
  request: DshCompletionRequest;
  key: string;
  bytes: number;
  progress: (value: DshProgress) => void;
  resolve: (value: DshCompletionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  running: boolean;
  queuedAt: number;
  startedAt?: number;
}

/** Bounded priority queue with one slot reserved for interactive work.
 * Waiting background/prefetch jobs age to the front after 30 seconds.
 * Each class remains FIFO; cancellation is independent. Persistent domain caches remain
 * authoritative; only concurrently waiting exact duplicates reuse a result. */
export class DshDispatcher {
  private manager: Pick<DshManager, 'run' | 'cancel' | 'close'>;
  private pending = new Map<string, Pending>();
  private active = 0;
  private activeNonInteractive = 0;
  private interactiveStreak = 0;
  private pendingBytes = 0;
  private busyKeys = new Set<string>();
  private closed = false;
  constructor(
    worker: string,
    manager?: Pick<DshManager, 'run' | 'cancel' | 'close'>,
  ) {
    this.manager = manager ?? new DshManager(worker);
  }
  run(
    owner: number,
    value: unknown,
    progress: (value: DshProgress) => void,
  ): Promise<DshCompletionResult> {
    const request = validateDshRequest(value);
    if (this.closed) return Promise.reject(new DshError('closed'));
    if (this.pending.has(request.requestId))
      return Promise.reject(new DshError('duplicate'));
    if (this.pending.size >= 32)
      return Promise.reject(new DshError('queue_full'));
    const { requestId, task, ...semantic } = request;
    void requestId;
    void task;
    // Credential is hashed, never stored in logs or cache files; different
    // accounts, prompts, model settings and images cannot share a result.
    const serialized = JSON.stringify(semantic);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (this.pendingBytes + bytes > 64_000_000)
      return Promise.reject(new DshError('queue_full'));
    const key = createHash('sha256').update(serialized).digest('hex');
    return new Promise((resolve, reject) => {
      const job: Pending = {
        owner,
        request,
        key,
        bytes,
        progress,
        resolve,
        reject,
        running: false,
        queuedAt: Date.now(),
        timer: setTimeout(() => this.expire(request.requestId), 180_000),
      };
      this.pending.set(request.requestId, job);
      this.pendingBytes += bytes;
      this.notify(job, 'queued');
      this.pump();
    });
  }
  cancel(owner: number, id: string) {
    const job = this.pending.get(id);
    if (!job || job.owner !== owner) return;
    if (job.running) this.manager.cancel(owner, id);
    else {
      this.remove(job);
      job.reject(new DshError('cancelled'));
      this.pump();
    }
  }
  cancelOwner(owner: number) {
    for (const [id, j] of this.pending)
      if (j.owner === owner) this.cancel(owner, id);
  }
  async close() {
    this.closed = true;
    for (const [id, j] of this.pending) this.cancel(j.owner, id);
    await this.manager.close();
    while (this.pending.size)
      await new Promise((resolve) => setTimeout(resolve, 5));
  }
  private remove(job: Pending) {
    clearTimeout(job.timer);
    if (this.pending.delete(job.request.requestId))
      this.pendingBytes -= job.bytes;
  }
  private finish(job: Pending) {
    this.remove(job);
    this.busyKeys.delete(job.key);
    this.active--;
    if ((job.request.task ?? 'interactive') !== 'interactive') this.activeNonInteractive--;
  }
  private expire(id: string) {
    const job = this.pending.get(id);
    if (!job || job.running) return;
    this.notify(job, 'failed');
    this.remove(job);
    job.reject(new DshError('queue_timeout'));
    this.pump();
  }
  private notify(job: Pending, phase: 'queued' | 'starting' | 'completed' | 'failed') {
    const now = Date.now();
    try { job.progress({ requestId: job.request.requestId, content: '', status: {
      phase, task: job.request.task ?? 'interactive', retries: 0,
      queueMs: (job.startedAt ?? now) - job.queuedAt,
    } }); } catch { /* observer failures never own task lifecycle */ }
  }
  private pump() {
    if (this.closed) return;
    while (!this.closed && this.active < 4) {
      const candidates = [...this.pending.values()].filter(job => !job.running && !this.busyKeys.has(job.key)
        && ((job.request.task ?? 'interactive') === 'interactive' || this.activeNonInteractive < 3));
      const now = Date.now();
      const rank = (job: Pending) => {
        const task = job.request.task ?? 'interactive';
        if (now - job.queuedAt >= 30_000 || (this.interactiveStreak >= 8 && task !== 'interactive')) return -1;
        return task === 'interactive' ? 0 : task === 'background' ? 1 : 2;
      };
      candidates.sort((a, b) => rank(a) - rank(b) || a.queuedAt - b.queuedAt);
      const job = candidates[0];
      if (!job) break;
      const interactive = (job.request.task ?? 'interactive') === 'interactive';
      this.interactiveStreak = interactive ? this.interactiveStreak + 1 : 0;
      if (!interactive) this.activeNonInteractive++;
      job.startedAt = now;
      job.running = true;
      clearTimeout(job.timer);
      this.active++;
      this.busyKeys.add(job.key);
      let execution: Promise<DshCompletionResult>;
      try {
        execution = this.manager.run(job.owner, job.request, (value) => {
          try { job.progress({ ...value, ...(value.status ? { status: { ...value.status, queueMs: job.startedAt! - job.queuedAt } } : {}) }); } catch { /* diagnostics cannot break work */ }
        });
      } catch (error) { execution = Promise.reject(error); }
      this.notify(job, 'starting');
      void execution.then(
        (result) => {
          this.notify(job, 'completed');
          this.finish(job);
          job.resolve(result);
          // Only complete results may satisfy waiting duplicates. A later
          // explicit regeneration always issues a fresh backend request.
          if (result.finishReason === 'stop' && result.content.trim())
            for (const other of this.pending.values()) {
              if (other !== job && !other.running && other.key === job.key) {
                this.notify(other, 'completed');
                this.remove(other);
                other.resolve({ ...result });
              }
            }
          this.pump();
        },
        (error: unknown) => {
          this.notify(job, 'failed');
          this.finish(job);
          job.reject(safeDshError(error));
          this.pump();
        },
      );
    }
  }
}
