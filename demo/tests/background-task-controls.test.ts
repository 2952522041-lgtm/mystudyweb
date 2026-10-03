import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundImports } from '../lib/background-imports.ts';
import { MemoryCourseStorage } from '../lib/course-storage/memory-course-storage.ts';
import { withLocalWriteLock } from '../lib/course-storage/study-tools.ts';
import {
  getBackgroundSnapshot,
  removeTaskCourse,
  tasksFromBundle,
  updateTaskBundle,
  updateTaskProgress,
} from '../lib/background-task-store.ts';
import {
  sanitizeBackgroundSnapshot,
  validateBackgroundAction,
} from '../electron/background-types.ts';
import type {
  AiCourseKnowledge,
  CourseStorage,
  DocumentDigest,
  DocumentRecord,
  ImportOptions,
} from '../lib/course-storage/types.ts';

const documentOptions: ImportOptions = {
  generateSummary: true,
  generateMindmap: true,
  mergeIntoCourse: false,
  includeConversationInsights: false,
};
const courseOptions = { ...documentOptions, mergeIntoCourse: true };
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label = 'condition',
  timeout = 1800,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(5);
  }
  assert.fail(`Timed out: ${label}`);
}
function digest(
  document: DocumentRecord,
  title = document.fileName,
): DocumentDigest {
  return {
    schemaVersion: 3,
    documentId: document.id,
    fingerprint: document.fingerprint,
    title,
    overview: title,
    sections: [],
    concepts: [],
    relations: [],
    unresolvedQuestions: [],
    sourcePages: [1],
    promptVersion: 'test',
    updatedAt: new Date().toISOString(),
  };
}
function knowledge(): AiCourseKnowledge {
  return {
    theme: '课程',
    nodes: [],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
    provider: 'test',
    model: 'test',
    promptVersion: 'test',
  };
}
async function fixture(count = 2, options = documentOptions) {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('控制测试');
  const docs: DocumentRecord[] = [];
  for (let i = 0; i < count; i++) {
    const current = await storage.load();
    const result = await storage.savePdf(
      new File([`pdf-${i}`], `lesson-${i}.pdf`, { type: 'application/pdf' }),
      { fingerprint: (i + 1).toString(16).repeat(64), pageCount: 1 },
      options,
      current.manifest.revision,
    );
    docs.push(result.document);
  }
  return { storage, docs, id: initial.manifest.id };
}
const job = async (storage: CourseStorage, id: string) =>
  (await storage.load()).manifest.documents.find((doc) => doc.id === id)
    ?.processing;
const worker = (
  overrides: Partial<ConstructorParameters<typeof BackgroundImports>[0]> = {},
) =>
  new BackgroundImports({
    analyze: async (_storage, document) => digest(document),
    synthesize: async () => knowledge(),
    onBundle: () => undefined,
    ...overrides,
  });

void test('paused and cancelled intentions survive restart and only explicit resume schedules work', async () => {
  const { storage, docs, id } = await fixture();
  let calls = 0;
  const control = worker({ execute: false });
  control.register(id, storage);
  await control.control({
    action: 'pause',
    courseId: id,
    documentId: docs[0].id,
  });
  await control.control({
    action: 'cancel',
    courseId: id,
    documentId: docs[1].id,
  });
  control.stop();
  const restarted = worker({
    analyze: async (_storage, document) => {
      calls++;
      return digest(document);
    },
  });
  restarted.register(id, storage);
  restarted.resume();
  try {
    await sleep(320);
    assert.equal(calls, 0);
    assert.equal((await job(storage, docs[0].id))?.status, 'paused');
    assert.equal((await job(storage, docs[1].id))?.status, 'cancelled');
    await restarted.control({ action: 'resume-paused' });
    await waitFor(
      async () => !(await job(storage, docs[0].id)),
      'resumed completion',
    );
    assert.equal(calls, 1);
    assert.equal((await job(storage, docs[1].id))?.status, 'cancelled');
    assert.equal(await (await storage.openPdf(docs[1].id)).text(), 'pdf-1');
  } finally {
    restarted.stop();
  }
});

void test('cancelling active document aborts it and continues the next queued PDF', async () => {
  const { storage, docs, id } = await fixture();
  const calls: string[] = [];
  let aborted = false;
  const runner = worker({
    analyze: async (_storage, document, signal) => {
      calls.push(document.id);
      if (document.id !== docs[0].id) return digest(document);
      return new Promise<DocumentDigest>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        ),
      );
    },
  });
  runner.register(id, storage);
  runner.resume();
  try {
    await waitFor(() => calls.length === 1);
    await runner.control({
      action: 'cancel',
      courseId: id,
      documentId: docs[0].id,
    });
    await waitFor(async () => !(await job(storage, docs[1].id)));
    assert.equal(aborted, true);
    assert.deepEqual(
      calls,
      docs.map((doc) => doc.id),
    );
    assert.equal((await job(storage, docs[0].id))?.status, 'cancelled');
    assert.equal((await storage.load()).digests[docs[0].id], undefined);
  } finally {
    runner.stop();
  }
});

void test('cancelling a member of shared synthesis requeues others without reanalysis', async () => {
  const { storage, docs, id } = await fixture(2, courseOptions);
  for (const document of docs)
    await storage.updateDocumentArtifacts(
      document.id,
      (await storage.load()).manifest.revision,
      digest(document),
    );
  let analyses = 0;
  const idsSeen: string[][] = [];
  const runner = worker({
    analyze: async (_storage, document) => {
      analyses++;
      return digest(document);
    },
    synthesize: async (_bundle, ids, _storage, signal) => {
      idsSeen.push([...ids]);
      if (idsSeen.length > 1) return knowledge();
      return new Promise<AiCourseKnowledge>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    },
  });
  runner.register(id, storage);
  runner.resume();
  try {
    await waitFor(() => idsSeen.length === 1);
    await runner.control({
      action: 'cancel',
      courseId: id,
      documentId: docs[0].id,
    });
    await waitFor(async () => !(await job(storage, docs[1].id)));
    assert.equal(analyses, 0);
    assert.deepEqual(idsSeen, [[docs[0].id, docs[1].id], [docs[1].id]]);
    const final = await storage.load();
    assert.equal(final.manifest.documents[0].processing?.status, 'cancelled');
    assert.equal(final.manifest.documents[0].includedInCourse, false);
    assert.equal(final.manifest.documents[1].includedInCourse, true);
    assert.ok(final.digests[docs[0].id]);
  } finally {
    runner.stop();
  }
});

void test('late successful results cannot replace a resumed worker outcome', async () => {
  const { storage, docs, id } = await fixture(1);
  const oldGate = gate<DocumentDigest>();
  let oldStarted = false;
  const first = worker({
    analyze: async () => {
      oldStarted = true;
      return oldGate.promise;
    },
  });
  first.register(id, storage);
  first.resume();
  const second = worker({
    analyze: async (_storage, document) => digest(document, 'new-result'),
  });
  second.register(id, storage);
  try {
    await waitFor(() => oldStarted);
    await first.control({
      action: 'pause',
      courseId: id,
      documentId: docs[0].id,
    });
    await second.control({
      action: 'resume',
      courseId: id,
      documentId: docs[0].id,
    });
    second.resume();
    await waitFor(async () => !(await job(storage, docs[0].id)));
    oldGate.resolve(digest(docs[0], 'stale-result'));
    await sleep(30);
    assert.equal(
      (await storage.load()).digests[docs[0].id].title,
      'new-result',
    );
  } finally {
    first.stop();
    second.stop();
    oldGate.resolve(digest(docs[0]));
  }
});

void test('cancel does not wait for a provider that ignores abort, and its late result is discarded', async () => {
  const { storage, docs, id } = await fixture();
  const late = gate<DocumentDigest>();
  let started = false;
  const calls: string[] = [];
  const runner = worker({
    analyze: async (_storage, document) => {
      calls.push(document.id);
      if (document.id === docs[0].id) {
        started = true;
        return late.promise;
      }
      return digest(document);
    },
  });
  runner.register(id, storage);
  runner.resume();
  try {
    await waitFor(() => started);
    await runner.control({
      action: 'cancel',
      courseId: id,
      documentId: docs[0].id,
    });
    await waitFor(
      async () => !(await job(storage, docs[1].id)),
      'next task despite ignored abort',
      600,
    );
    assert.deepEqual(
      calls,
      docs.map((doc) => doc.id),
    );
    late.resolve(digest(docs[0], 'stale'));
    await sleep(20);
    assert.equal((await job(storage, docs[0].id))?.status, 'cancelled');
    assert.equal((await storage.load()).digests[docs[0].id], undefined);
  } finally {
    runner.stop();
    late.resolve(digest(docs[0]));
  }
});

void test('retry-failed uses course checkpoints and never restarts cancelled jobs', async () => {
  const { storage, docs, id } = await fixture(2, courseOptions);
  for (const document of docs)
    await storage.updateDocumentArtifacts(
      document.id,
      (await storage.load()).manifest.revision,
      digest(document),
    );
  let current = await storage.load();
  await storage.setDocumentProcessing(
    docs[0].id,
    {
      ...current.manifest.documents[0].processing!,
      status: 'failed',
      error: 'temporary',
    },
    current.manifest.revision,
  );
  current = await storage.load();
  await storage.setDocumentProcessing(
    docs[1].id,
    { ...current.manifest.documents[1].processing!, status: 'cancelled' },
    current.manifest.revision,
  );
  let analyses = 0;
  let synthesized: string[] = [];
  const runner = worker({
    analyze: async (_storage, document) => {
      analyses++;
      return digest(document);
    },
    synthesize: async (_bundle, ids) => {
      synthesized = ids;
      return knowledge();
    },
  });
  runner.register(id, storage);
  try {
    await runner.control({ action: 'retry-failed' });
    runner.resume();
    await waitFor(async () => !(await job(storage, docs[0].id)));
    assert.equal(analyses, 0);
    assert.deepEqual(synthesized, [docs[0].id]);
    assert.equal((await job(storage, docs[1].id))?.status, 'cancelled');
  } finally {
    runner.stop();
  }
});

void test('background writes honor storage lock while AI runs outside it', async () => {
  class LockedStorage extends MemoryCourseStorage {
    locked = false;
    locks = 0;
    withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
      return withLocalWriteLock(this, async () => {
        assert.equal(this.locked, false);
        this.locked = true;
        this.locks++;
        try {
          return await operation();
        } finally {
          this.locked = false;
        }
      });
    }
  }
  const storage = new LockedStorage();
  const { manifest } = await storage.initialize('lock');
  const { document } = await storage.savePdf(
    new File(['pdf'], 'lock.pdf'),
    { fingerprint: 'f'.repeat(64), pageCount: 1 },
    documentOptions,
    0,
  );
  const runner = worker({
    analyze: async (_storage, record) => {
      assert.equal(storage.locked, false);
      return digest(record);
    },
  });
  runner.register(manifest.id, storage);
  runner.resume();
  try {
    await waitFor(async () => !(await job(storage, document.id)));
    assert.ok(storage.locks >= 2);
  } finally {
    runner.stop();
  }
});

void test('persisted progress cannot overwrite a newer live progress update', async () => {
  const { storage, docs, id } = await fixture(1);
  const result = gate<DocumentDigest>();
  let reportsSent = false;
  const runner = worker({
    onBundle: (_id, bundle) => updateTaskBundle(bundle),
    onTaskProgress: updateTaskProgress,
    analyze: async (_storage, _document, _signal, report) => {
      report('分析分块 1/10');
      report('分析分块 2/10');
      reportsSent = true;
      return result.promise;
    },
  });
  runner.register(id, storage);
  updateTaskBundle(await storage.load());
  runner.resume();
  try {
    await waitFor(() => reportsSent);
    await sleep(20);
    const task = getBackgroundSnapshot().tasks.find(
      (task) => task.documentId === docs[0].id && task.courseId === id,
    );
    assert.equal(
      task?.completedUnits,
      2,
      'late persisted 1/10 must not roll live 2/10 back',
    );
    assert.equal(task?.totalUnits, 10);
  } finally {
    runner.stop();
    result.resolve(digest(docs[0]));
    removeTaskCourse(id);
  }
});

void test('late failed runs cannot overwrite a new run token with a coincident timestamp', async () => {
  const { storage, docs, id } = await fixture(1);
  const result = gate<DocumentDigest>();
  let started = false;
  const runner = worker({
    analyze: async () => {
      started = true;
      return result.promise;
    },
  });
  runner.register(id, storage);
  runner.resume();
  try {
    await waitFor(() => started);
    runner.hold();
    const current = await storage.load();
    const previous = current.manifest.documents[0].processing!;
    await storage.setDocumentProcessing(
      docs[0].id,
      {
        ...previous,
        runId: 'new-owner-token',
        status: 'paused',
        message: 'new intention',
      },
      current.manifest.revision,
    );
    result.reject(new Error('late error'));
    await sleep(30);
    assert.equal(
      (await job(storage, docs[0].id))?.status,
      'paused',
      'stale failure must check run token/status, not timestamp alone',
    );
    assert.equal((await job(storage, docs[0].id))?.runId, 'new-owner-token');
  } finally {
    runner.stop();
    result.resolve(digest(docs[0]));
  }
});

void test('task projection drops credentials and arbitrary fields at IPC boundary', async () => {
  const { storage } = await fixture(1);
  const projected = tasksFromBundle(await storage.load());
  const snapshot = sanitizeBackgroundSnapshot({
    tasks: [
      {
        ...projected[0],
        apiKey: 'secret',
        message: 'private body sk-12345678901234567890',
        error: 'bearer private-secret-token-123456 /private/file',
        digest: { overview: 'private body' },
        absolutePath: '/private/file',
        options: { apiKey: 'hidden' },
      },
    ],
    executor: 'browser',
    available: false,
    error: 'private host failure',
  });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(
    serialized,
    /secret|private body|private\/file|hidden|private host failure|apiKey|digest|absolutePath|options/,
  );
  assert.equal(snapshot.executor, 'desktop');
  assert.equal(snapshot.available, false);
  assert.deepEqual(
    validateBackgroundAction({
      action: 'cancel',
      courseId: 'course',
      documentId: 'doc',
      apiKey: 'ignored',
    }),
    { action: 'cancel', courseId: 'course', documentId: 'doc' },
  );
  assert.throws(() => validateBackgroundAction({ action: 'cancel' }), /请选择/);
});

void test('bulk pause-queued leaves running work alone and bulk resume restores only paused work', async () => {
  const { storage, docs, id } = await fixture(3);
  const active = gate<DocumentDigest>();
  let started = false;
  let calls = 0;
  const runner = worker({
    analyze: async (_storage, document) => {
      calls++;
      if (document.id === docs[0].id) {
        started = true;
        return active.promise;
      }
      return digest(document);
    },
  });
  runner.register(id, storage);
  runner.resume();
  try {
    await waitFor(() => started);
    await runner.control({
      action: 'cancel',
      courseId: id,
      documentId: docs[2].id,
    });
    await runner.control({ action: 'pause-queued' });
    assert.equal((await job(storage, docs[0].id))?.status, 'running');
    assert.equal((await job(storage, docs[1].id))?.status, 'paused');
    assert.equal((await job(storage, docs[2].id))?.status, 'cancelled');
    active.resolve(digest(docs[0]));
    await waitFor(async () => !(await job(storage, docs[0].id)));
    assert.equal(calls, 1);
    await runner.control({ action: 'resume-paused' });
    await waitFor(async () => !(await job(storage, docs[1].id)));
    assert.equal(calls, 2);
    assert.equal((await job(storage, docs[2].id))?.status, 'cancelled');
  } finally {
    runner.stop();
    active.resolve(digest(docs[0]));
  }
});

void test('course round-robin prevents a large import from consuming every document turn', async () => {
  const first = await fixture(3);
  await sleep(2);
  const second = await fixture(1);
  const order: string[] = [];
  const runner = worker({
    analyze: async (storage, document) => {
      order.push(storage === first.storage ? 'first' : 'second');
      return digest(document);
    },
  });
  runner.register(first.id, first.storage);
  runner.register(second.id, second.storage);
  runner.resume();
  try {
    await waitFor(
      async () =>
        !(await first.storage.load()).manifest.documents.some(
          (doc) => doc.processing,
        ) &&
        !(await second.storage.load()).manifest.documents.some(
          (doc) => doc.processing,
        ),
    );
    assert.deepEqual(order, ['first', 'second', 'first', 'first']);
  } finally {
    runner.stop();
  }
});

void test('task snapshots distinguish no-AI PDFs from completed artifacts and retain real checkpoint fields', async () => {
  const { storage, docs } = await fixture(1);
  let current = await storage.load();
  await storage.setDocumentProcessing(
    docs[0].id,
    {
      ...current.manifest.documents[0].processing!,
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      lastActivityAt: '2026-01-01T00:00:02Z',
      attempt: 2,
      completedUnits: 3,
      totalUnits: 7,
      message: 'OCR 3/7',
    },
    current.manifest.revision,
  );
  current = await storage.load();
  const running = tasksFromBundle(current)[0];
  assert.equal(running.completedUnits, 3);
  assert.equal(running.totalUnits, 7);
  assert.equal(running.attempt, 2);
  assert.equal(running.status, 'running');
  assert.equal(running.lastActivityAt, '2026-01-01T00:00:02Z');
  await storage.updateDocumentArtifacts(
    docs[0].id,
    current.manifest.revision,
    digest(docs[0]),
  );
  current = await storage.load();
  await storage.savePdf(
    new File(['raw'], 'raw.pdf'),
    { fingerprint: 'b'.repeat(64), pageCount: 1 },
    {
      generateSummary: false,
      generateMindmap: false,
      mergeIntoCourse: false,
      includeConversationInsights: false,
    },
    current.manifest.revision,
  );
  const tasks = tasksFromBundle(await storage.load());
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].documentId, docs[0].id);
});
