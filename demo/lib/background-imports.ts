import type {
  AiCourseKnowledge,
  CourseBundle,
  CourseStorage,
  DocumentDigest,
  DocumentRecord,
  DocumentProcessing,
} from './course-storage/types.ts';
import type { BackgroundAction } from '../electron/background-types.ts';
import { courseReviewSignature } from './course-storage/course-review.ts';

interface BackgroundImportDependencies {
  analyze(
    storage: CourseStorage,
    document: DocumentRecord,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<DocumentDigest>;
  synthesize(
    bundle: CourseBundle,
    documentIds: string[],
    storage: CourseStorage,
    signal: AbortSignal,
  ): Promise<AiCourseKnowledge>;
  onBundle(courseId: string, bundle: CourseBundle): void;
  onProgress?(message: string): void;
  onError?(message: string): void;
  onTaskProgress?(
    courseId: string,
    documentId: string,
    progress: Partial<DocumentProcessing>,
  ): void;
  /** Desktop UI delegates execution to the host-owned renderer. */
  execute?: boolean;
  reviewCourseChanges?: boolean;
  onWake?(): void;
}

export const processingIsActive = (job?: DocumentProcessing) =>
  job?.status === 'queued' || job?.status === 'running';

/** A provider that delivers a late result must not hold the task queue hostage. */
async function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException('任务已中止。', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** One worker, durable per-document checkpoints, and short serialized writes.
 * AI runs outside the write lock so saving/reading another PDF never waits on AI.
 * The library stays mounted while reading; closing the app leaves queued/running
 * records on disk to resume at next launch. Failed work requires explicit retry.
 */
export class BackgroundImports {
  private courses = new Map<string, CourseStorage>();
  private locks = new Map<string, Promise<unknown>>();
  private running = false;
  private requested = false;
  private stopped = false;
  private holds = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private controller = new AbortController();
  private active?: {
    courseId: string;
    ids: string[];
    controller: AbortController;
  };
  private lastCourse = '';
  private deps: BackgroundImportDependencies;
  constructor(deps: BackgroundImportDependencies) {
    this.deps = deps;
  }

  register(courseId: string, storage: CourseStorage) {
    this.courses.set(courseId, storage);
  }
  unregister(courseId: string) {
    if (this.active?.courseId === courseId) this.active.controller.abort();
    this.courses.delete(courseId);
  }
  resume() {
    this.stopped = false;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.wake();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller.abort();
  }
  hold() {
    this.holds += 1;
  }
  release() {
    this.holds = Math.max(0, this.holds - 1);
    this.wake();
  }

  async mutate<T>(
    courseId: string,
    operation: (storage: CourseStorage, current: CourseBundle) => Promise<T>,
  ): Promise<T> {
    const storage = this.courses.get(courseId);
    if (!storage) throw new Error('课程尚未连接。');
    const previous = this.locks.get(courseId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const run = async () => operation(storage, await storage.load());
        return storage.withWriteLock ? storage.withWriteLock(run) : run();
      });
    this.locks.set(courseId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(courseId) === next) this.locks.delete(courseId);
    }
  }

  async retry(courseId: string, documentId: string) {
    await this.control({ action: 'retry', courseId, documentId });
  }

  async control(command: BackgroundAction) {
    const selection: Array<{
      courseId: string;
      documentId: string;
      action: 'pause' | 'resume' | 'cancel' | 'retry';
    }> = [];
    if (
      command.courseId &&
      command.documentId &&
      ['pause', 'resume', 'cancel', 'retry'].includes(command.action)
    ) {
      selection.push({
        courseId: command.courseId,
        documentId: command.documentId,
        action: command.action as 'pause' | 'resume' | 'cancel' | 'retry',
      });
    } else {
      const expected =
        command.action === 'pause-queued'
          ? 'queued'
          : command.action === 'resume-paused'
            ? 'paused'
            : 'failed';
      for (const [courseId, storage] of this.courses) {
        const bundle = await storage.load();
        for (const doc of bundle.manifest.documents)
          if (doc.processing?.status === expected)
            selection.push({
              courseId,
              documentId: doc.id,
              action:
                command.action === 'pause-queued'
                  ? 'pause'
                  : command.action === 'resume-paused'
                    ? 'resume'
                    : 'retry',
            });
      }
    }
    for (const selected of selection)
      await this.mutate(selected.courseId, async (storage, bundle) => {
        const job = bundle.manifest.documents.find(
          (doc) => doc.id === selected.documentId,
        )?.processing;
        if (!job) return;
        const allowed =
          selected.action === 'pause'
            ? processingIsActive(job)
            : selected.action === 'cancel'
              ? job.status !== 'cancelled' && job.status !== 'review'
              : selected.action === 'resume'
                ? job.status === 'paused'
                : job.status === 'failed' || job.status === 'cancelled';
        if (!allowed) return;
        const status =
          selected.action === 'pause'
            ? 'paused'
            : selected.action === 'cancel'
              ? 'cancelled'
              : 'queued';
        const next = await storage.setDocumentProcessing(
          selected.documentId,
          {
            ...job,
            status,
            error: undefined,
            runId: undefined,
            message:
              status === 'queued'
                ? '等待继续已完成阶段'
                : status === 'paused'
                  ? '已暂停；已完成成果保留'
                  : '已取消；PDF 和已完成成果保留',
            updatedAt: new Date().toISOString(),
          },
          bundle.manifest.revision,
        );
        // Persist the intention before aborting; a crash must never resume a paused task.
        if (
          this.active?.courseId === selected.courseId &&
          this.active.ids.includes(selected.documentId)
        )
          this.active.controller.abort();
        this.deps.onBundle(selected.courseId, next);
      });
    this.wake();
  }

  wake() {
    this.deps.onWake?.();
    if (this.deps.execute === false) return;
    if (this.running) {
      this.requested = true;
      return;
    }
    if (this.stopped || this.running || this.holds || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, 250);
  }

  private async drain() {
    if (this.running || this.stopped || this.holds) return;
    this.running = true;
    const signal = this.controller.signal;
    try {
      while (!this.stopped && !signal.aborted && !this.holds) {
        const available: Array<{ id: string; bundle: CourseBundle }> = [];
        for (const [id, storage] of this.courses) {
          try {
            available.push({ id, bundle: await storage.load() });
          } catch {
            /* Disconnected browser directories must be reauthorized. */
          }
        }
        const pending = (doc: DocumentRecord) =>
          processingIsActive(doc.processing);
        // Round-robin courses so a large import cannot starve another course.
        const lastIndex = available.findIndex(
          (item) => item.id === this.lastCourse,
        );
        if (lastIndex >= 0)
          available.push(...available.splice(0, lastIndex + 1));
        // Finish this course's documents before its synthesis. A ready course
        // must not wait for every unrelated course's PDFs to finish first.
        const selected = available.map(item => {
          const documents = item.bundle.manifest.documents.filter(pending);
          const document = documents.find(doc => doc.processing!.phase === 'document');
          return {id:item.id, jobs:document ? [document] : item.bundle.manifest.pendingReview ? [] : documents};
        }).find(item => item.jobs.length > 0);
        if (!selected) break;
        this.lastCourse = selected.id;
        await this.run(selected.id, selected.jobs, signal);
      }
    } catch (error) {
      if (!signal.aborted) this.deps.onError?.(String(error));
    } finally {
      this.running = false;
      if (this.requested) {
        this.requested = false;
        this.wake();
      }
    }
  }

  private async run(
    courseId: string,
    candidates: DocumentRecord[],
    signal: AbortSignal,
  ) {
    const claimed = new Map<string, string>();
    const phase = candidates[0].processing!.phase;
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) controller.abort();
    const parentSignal = signal;
    signal = controller.signal;
    this.active = {
      courseId,
      ids: candidates.map((doc) => doc.id),
      controller,
    };
    const runId = crypto.randomUUID();
    let lastProgressSave = 0;
    let progressRevision = 0;
    let progressWrite: Promise<unknown> = Promise.resolve();
    const report = (id: string, message: string) => {
      if (signal.aborted) return;
      const counts = /(?:^|\s)(\d+)\s*\/\s*(\d+)/.exec(message);
      const patch: Partial<DocumentProcessing> = {
        message,
        progressRevision: ++progressRevision,
        lastActivityAt: new Date().toISOString(),
        completedUnits: counts ? Number(counts[1]) : undefined,
        totalUnits: counts ? Number(counts[2]) : undefined,
      };
      this.deps.onTaskProgress?.(courseId, id, patch);
      this.deps.onProgress?.(
        `${candidates.find((doc) => doc.id === id)?.fileName ?? ''}：${message}`,
      );
      if (Date.now() - lastProgressSave < 1000) return;
      lastProgressSave = Date.now();
      progressWrite = progressWrite
        .then(() =>
          this.mutate(courseId, async (storage, current) => {
            const job = current.manifest.documents.find(
              (doc) => doc.id === id,
            )?.processing;
            if (
              signal.aborted ||
              job?.runId !== runId ||
              job.status !== 'running'
            )
              return;
            this.deps.onBundle(
              courseId,
              await storage.setDocumentProcessing(
                id,
                { ...job, ...patch },
                current.manifest.revision,
              ),
            );
          }),
        )
        .catch(() => undefined);
    };
    try {
      const snapshot = await this.mutate(courseId, async (storage, current) => {
        for (const candidate of candidates) {
          const job = current.manifest.documents.find(
            (doc) => doc.id === candidate.id,
          )?.processing;
          if (
            !job ||
            !processingIsActive(job) ||
            job.phase !== phase ||
            signal.aborted
          )
            continue;
          const timestamp = new Date().toISOString();
          current = await storage.setDocumentProcessing(
            candidate.id,
            {
              ...job,
              status: 'running',
              error: undefined,
              runId,
              startedAt: timestamp,
              lastActivityAt: timestamp,
              progressRevision: 0,
              completedUnits: undefined,
              totalUnits: undefined,
              attempt: (job.attempt ?? 0) + 1,
              ...(job.status === 'running' ? { resumedAt: timestamp } : {}),
              updatedAt: timestamp,
            },
            current.manifest.revision,
          );
          claimed.set(candidate.id, timestamp);
        }
        this.deps.onBundle(courseId, current);
        return current;
      });
      if (!claimed.size || signal.aborted) return;
      const matches = (bundle: CourseBundle, id: string) => {
        const job = bundle.manifest.documents.find(
          (doc) => doc.id === id,
        )?.processing;
        return (
          job?.phase === phase &&
          job.status === 'running' &&
          job.runId === runId &&
          job.updatedAt === claimed.get(id)
        );
      };
      const storage = this.courses.get(courseId)!;
      if (phase === 'document') {
        const id = [...claimed.keys()][0];
        const document = snapshot.manifest.documents.find(
          (doc) => doc.id === id,
        )!;
        const digest = await untilAborted(
          this.deps.analyze(storage, document, signal, (message) =>
            report(id, message),
          ),
          signal,
        );
        if (signal.aborted) return;
        await this.mutate(courseId, async (currentStorage, current) => {
          if (signal.aborted || !matches(current, id)) return;
          this.deps.onBundle(
            courseId,
            await currentStorage.updateDocumentArtifacts(
              id,
              current.manifest.revision,
              digest,
            ),
          );
        });
      } else {
        const ids = [...claimed.keys()];
        for (const id of ids) report(id, `课程汇总：合并 ${ids.length} 份资料`);
        this.deps.onProgress?.(
          `后台正在统一更新课程汇总（${ids.length} 份新资料）；PDF 可正常阅读。`,
        );
        const knowledge = await untilAborted(
          this.deps.synthesize(snapshot, ids, storage, signal),
          signal,
        );
        if (signal.aborted) return;
        await this.mutate(courseId, async (currentStorage, current) => {
          if (signal.aborted || ids.some((id) => !matches(current, id))) return;
          // New raw PDFs are harmless; a changed summary or knowledge version is not.
          if (
            await courseReviewSignature(current, ids) !==
              await courseReviewSignature(snapshot, ids)
          )
            throw new Error(
              '课程内容在整理期间已变更，请重试课程汇总；PDF 和单篇成果已保留。',
            );
          this.deps.onBundle(
            courseId,
            await (this.deps.reviewCourseChanges && currentStorage.stageCourseReview
              ? currentStorage.stageCourseReview.bind(currentStorage)
              : currentStorage.mergeDocuments.bind(currentStorage))(
              ids,
              current.manifest.revision,
              knowledge,
            ),
          );
        });
      }
    } catch (error) {
      if (signal.aborted) return; // Closing the app preserves restart checkpoints.
      const message = error instanceof Error ? error.message : String(error);
      await this.mutate(courseId, async (storage, current) => {
        for (const [id, timestamp] of claimed) {
          const job = current.manifest.documents.find(
            (doc) => doc.id === id,
          )?.processing;
          if (
            !job ||
            job.runId !== runId ||
            job.status !== 'running' ||
            job.phase !== phase ||
            job.updatedAt !== timestamp
          )
            continue;
          current = await storage.setDocumentProcessing(
            id,
            {
              ...job,
              status: 'failed',
              error: message,
              updatedAt: new Date().toISOString(),
            },
            current.manifest.revision,
          );
        }
        this.deps.onBundle(courseId, current);
      });
      this.deps.onError?.(
        `PDF 已保存，${phase === 'document' ? '单篇整理' : '课程汇总'}失败：${message}`,
      );
    } finally {
      parentSignal.removeEventListener('abort', stop);
      await progressWrite;
      // Cancelling one member of a course synthesis stops that shared request.
      // Other members return to the queue; the selected member retains its intent.
      if (
        signal.aborted &&
        !parentSignal.aborted &&
        this.courses.has(courseId)
      ) {
        await this.mutate(courseId, async (storage, current) => {
          for (const id of claimed.keys()) {
            const job = current.manifest.documents.find(
              (doc) => doc.id === id,
            )?.processing;
            if (job?.runId === runId && job.status === 'running')
              current = await storage.setDocumentProcessing(
                id,
                {
                  ...job,
                  status: 'queued',
                  runId: undefined,
                  updatedAt: new Date().toISOString(),
                },
                current.manifest.revision,
              );
          }
          this.deps.onBundle(courseId, current);
        });
      }
      if (this.active?.controller === controller) this.active = undefined;
    }
  }
}
