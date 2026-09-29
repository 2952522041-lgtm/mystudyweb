import { createHash } from 'node:crypto';
import { DshManager } from './dsh-manager.ts';
import { validateDshRequest } from './dsh-policy.ts';
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
}

/** Bounded FIFO with independent cancellation. Persistent domain caches remain
 * authoritative; only concurrently waiting exact duplicates reuse a result. */
export class DshDispatcher {
  private manager: Pick<DshManager, 'run' | 'cancel' | 'close'>;
  private pending = new Map<string, Pending>();
  private active = 0;
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
    if (this.closed) return Promise.reject(new Error('DSH 正在关闭。'));
    if (this.pending.has(request.requestId))
      return Promise.reject(new Error('DSH 请求重复。'));
    if (this.pending.size >= 32)
      return Promise.reject(new Error('DSH 等待任务过多，请稍后重试。'));
    const { requestId, ...semantic } = request;
    void requestId;
    // Credential is hashed, never stored in logs or cache files; different
    // accounts, prompts, model settings and images cannot share a result.
    const serialized = JSON.stringify(semantic);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (this.pendingBytes + bytes > 64_000_000)
      return Promise.reject(new Error('DSH 等待数据过多，请稍后重试。'));
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
        timer: setTimeout(() => this.cancel(owner, request.requestId), 60_000),
      };
      this.pending.set(request.requestId, job);
      this.pendingBytes += bytes;
      this.pump();
    });
  }
  cancel(owner: number, id: string) {
    const job = this.pending.get(id);
    if (!job || job.owner !== owner) return;
    if (job.running) this.manager.cancel(owner, id);
    else {
      this.remove(job);
      job.reject(new Error('DSH 排队任务已取消或等待超时。'));
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
  }
  private pump() {
    if (this.closed) return;
    for (const job of this.pending.values()) {
      if (this.active >= 4) break;
      if (job.running || this.busyKeys.has(job.key)) continue;
      job.running = true;
      clearTimeout(job.timer);
      this.active++;
      this.busyKeys.add(job.key);
      void this.manager.run(job.owner, job.request, job.progress).then(
        (result) => {
          this.finish(job);
          job.resolve(result);
          // Only complete results may satisfy waiting duplicates. A later
          // explicit regeneration always issues a fresh backend request.
          if (result.finishReason === 'stop' && result.content.trim())
            for (const other of this.pending.values()) {
              if (other !== job && !other.running && other.key === job.key) {
                this.remove(other);
                other.resolve({ ...result });
              }
            }
          this.pump();
        },
        () => {
          this.finish(job);
          job.reject(new Error('DSH 任务未完成；未发布残缺结果。'));
          this.pump();
        },
      );
    }
  }
}
