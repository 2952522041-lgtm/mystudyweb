import type { AiCourseKnowledge, CourseBundle, CourseStorage, DocumentDigest, DocumentRecord } from './course-storage/types.ts';

interface BackgroundImportDependencies {
  analyze(storage: CourseStorage, document: DocumentRecord, signal: AbortSignal, progress: (message: string) => void): Promise<DocumentDigest>;
  synthesize(bundle: CourseBundle, documentIds: string[], storage: CourseStorage, signal: AbortSignal): Promise<AiCourseKnowledge>;
  onBundle(courseId: string, bundle: CourseBundle): void;
  onProgress?(message: string): void;
  onError?(message: string): void;
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
  private deps: BackgroundImportDependencies;
  constructor(deps: BackgroundImportDependencies) { this.deps = deps; }

  register(courseId: string, storage: CourseStorage) { this.courses.set(courseId, storage); }
  unregister(courseId: string) { this.courses.delete(courseId); }
  resume() { this.stopped = false; if (this.controller.signal.aborted) this.controller = new AbortController(); this.wake(); }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.controller.abort(); }
  hold() { this.holds += 1; }
  release() { this.holds = Math.max(0, this.holds - 1); this.wake(); }

  async mutate<T>(courseId: string, operation: (storage: CourseStorage, current: CourseBundle) => Promise<T>): Promise<T> {
    const storage = this.courses.get(courseId);
    if (!storage) throw new Error('课程尚未连接。');
    const previous = this.locks.get(courseId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => operation(storage, await storage.load()));
    this.locks.set(courseId, next);
    try { return await next; } finally { if (this.locks.get(courseId) === next) this.locks.delete(courseId); }
  }

  async retry(courseId: string, documentId: string) {
    await this.mutate(courseId, async (storage, bundle) => {
      const job = bundle.manifest.documents.find(doc => doc.id === documentId)?.processing;
      if (!job || job.status !== 'failed') return;
      this.deps.onBundle(courseId, await storage.setDocumentProcessing(documentId, {...job, status:'queued', error:undefined, updatedAt:new Date().toISOString()}, bundle.manifest.revision));
    });
    this.wake();
  }

  wake() {
    if (this.running) { this.requested = true; return; }
    if (this.stopped || this.running || this.holds || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, 250);
  }

  private async drain() {
    if (this.running || this.stopped || this.holds) return;
    this.running = true;
    const signal = this.controller.signal;
    try {
      while (!this.stopped && !signal.aborted && !this.holds) {
        const available: Array<{id:string; bundle:CourseBundle}> = [];
        for (const [id, storage] of this.courses) {
          try { available.push({id, bundle:await storage.load()}); }
          catch { /* Disconnected browser directories must be reauthorized. */ }
        }
        const pending = (doc: DocumentRecord) => doc.processing && doc.processing.status !== 'failed';
        // Drain documents before course synthesis, including multi-file batches.
        const documentCourse = available.find(item => item.bundle.manifest.documents.some(doc => pending(doc) && doc.processing!.phase === 'document'));
        const selected = documentCourse ?? available.find(item => item.bundle.manifest.documents.some(pending));
        if (!selected) break;
        const jobs = selected.bundle.manifest.documents.filter(doc => pending(doc) && doc.processing!.phase === (documentCourse ? 'document' : 'course'));
        await this.run(selected.id, documentCourse ? jobs.slice(0,1) : jobs, signal);
      }
    } catch (error) { if (!signal.aborted) this.deps.onError?.(String(error)); }
    finally { this.running = false; if (this.requested) { this.requested = false; this.wake(); } }
  }

  private async run(courseId: string, candidates: DocumentRecord[], signal: AbortSignal) {
    const claimed = new Map<string, string>();
    const phase = candidates[0].processing!.phase;
    try {
      const snapshot = await this.mutate(courseId, async (storage, current) => {
        for (const candidate of candidates) {
          const job = current.manifest.documents.find(doc => doc.id === candidate.id)?.processing;
          if (!job || job.status === 'failed' || job.phase !== phase || signal.aborted) continue;
          const timestamp = new Date().toISOString();
          current = await storage.setDocumentProcessing(candidate.id, {...job, status:'running', error:undefined, updatedAt:timestamp}, current.manifest.revision);
          claimed.set(candidate.id, timestamp);
        }
        this.deps.onBundle(courseId, current);
        return current;
      });
      if (!claimed.size || signal.aborted) return;
      const matches = (bundle: CourseBundle, id: string) => {
        const job = bundle.manifest.documents.find(doc => doc.id === id)?.processing;
        return job?.phase === phase && job.status === 'running' && job.updatedAt === claimed.get(id);
      };
      const storage = this.courses.get(courseId)!;
      if (phase === 'document') {
        const id = [...claimed.keys()][0];
        const document = snapshot.manifest.documents.find(doc => doc.id === id)!;
        const digest = await this.deps.analyze(storage, document, signal, message => this.deps.onProgress?.(`${document.fileName}：${message}`));
        if (signal.aborted) return;
        await this.mutate(courseId, async (currentStorage, current) => {
          if (signal.aborted || !matches(current,id)) return;
          this.deps.onBundle(courseId, await currentStorage.updateDocumentArtifacts(id, current.manifest.revision, digest));
        });
      } else {
        const ids = [...claimed.keys()];
        this.deps.onProgress?.(`后台正在统一更新课程汇总（${ids.length} 份新资料）；PDF 可正常阅读。`);
        const knowledge = await this.deps.synthesize(snapshot, ids, storage, signal);
        if (signal.aborted) return;
        await this.mutate(courseId, async (currentStorage, current) => {
          if (signal.aborted || ids.some(id => !matches(current,id))) return;
          // New raw PDFs are harmless; a changed summary or knowledge version is not.
          const relevant = snapshot.manifest.documents.filter(doc => doc.includedInCourse || ids.includes(doc.id));
          if (current.knowledge.version !== snapshot.knowledge.version || relevant.some(doc => JSON.stringify(current.digests[doc.id]) !== JSON.stringify(snapshot.digests[doc.id])))
            throw new Error('课程内容在整理期间已变更，请重试课程汇总；PDF 和单篇成果已保留。');
          this.deps.onBundle(courseId, await currentStorage.mergeDocuments(ids, current.manifest.revision, knowledge));
        });
      }
    } catch (error) {
      if (signal.aborted) return; // Running checkpoint is resumed after restart.
      const message = error instanceof Error ? error.message : String(error);
      await this.mutate(courseId, async (storage, current) => {
        for (const [id, timestamp] of claimed) {
          const job = current.manifest.documents.find(doc => doc.id === id)?.processing;
          if (!job || job.phase !== phase || job.updatedAt !== timestamp) continue;
          current = await storage.setDocumentProcessing(id, {...job, status:'failed', error:message, updatedAt:new Date().toISOString()}, current.manifest.revision);
        }
        this.deps.onBundle(courseId, current);
      });
      this.deps.onError?.(`PDF 已保存，${phase === 'document' ? '单篇整理' : '课程汇总'}失败：${message}`);
    }
  }
}
