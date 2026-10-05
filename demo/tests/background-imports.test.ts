import assert from 'node:assert/strict';
import test from 'node:test';

import { createCourseId } from '../lib/course-storage/file-utils.ts';
import { BackgroundImports } from '../lib/background-imports.ts';
import { MemoryCourseStorage } from '../lib/course-storage/memory-course-storage.ts';
import type {
  AiCourseKnowledge,
  CourseBundle,
  DocumentDigest,
  DocumentRecord,
  ImportOptions,
} from '../lib/course-storage/types.ts';

const mergeOptions: ImportOptions = {
  generateSummary: true,
  generateMindmap: true,
  mergeIntoCourse: true,
  includeConversationInsights: false,
};

const documentOptions: ImportOptions = {
  generateSummary: true,
  generateMindmap: true,
  mergeIntoCourse: false,
  includeConversationInsights: false,
};

const rawOptions: ImportOptions = {
  generateSummary: false,
  generateMindmap: false,
  mergeIntoCourse: false,
  includeConversationInsights: false,
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message = 'timed out waiting for background import',
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function pdfFile(name: string, body = `bytes:${name}`): File {
  return new File([body], name, { type: 'application/pdf' });
}

function fingerprint(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function makeDigest(
  document: DocumentRecord,
  label = document.fileName,
): DocumentDigest {
  return {
    schemaVersion: 1,
    documentId: document.id,
    fingerprint: document.fingerprint,
    title: label,
    overview: `${label} 摘要`,
    sections: [
      {
        id: `${document.id}-section`,
        title: label,
        summary: `${label} 内容`,
        pageStart: 1,
        pageEnd: document.pageCount,
      },
    ],
    concepts: [
      {
        id: `${document.id}-concept`,
        label,
        description: `${label} 概念`,
        sources: [
          {
            documentId: document.id,
            fileName: document.fileName,
            pageStart: 1,
            type: 'pdf',
          },
        ],
      },
    ],
    relations: [],
    unresolvedQuestions: [],
    sourcePages: [1],
    promptVersion: 'test',
    updatedAt: new Date().toISOString(),
  };
}

function makeKnowledge(label = 'AI 课程主题'): AiCourseKnowledge {
  return {
    theme: label,
    nodes: [
      {
        id: `ai-${label}`,
        label,
        description: `${label} 生成的知识节点`,
        sources: [],
      },
    ],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
    provider: 'test-provider',
    model: 'test-model',
    promptVersion: 'test-prompt',
  };
}

function findDocument(
  bundle: CourseBundle,
  documentId: string,
): DocumentRecord {
  const document = bundle.manifest.documents.find(
    (item) => item.id === documentId,
  );
  assert.ok(document, `document ${documentId} should exist`);
  return document;
}

async function save(
  storage: MemoryCourseStorage,
  name: string,
  options: ImportOptions,
  seed: string,
): Promise<DocumentRecord> {
  const current = await storage.load();
  const result = await storage.savePdf(
    pdfFile(name),
    { fingerprint: fingerprint(seed), pageCount: 1 },
    options,
    current.manifest.revision,
  );
  return result.document;
}

void test('raw PDF is saved before AI, remains readable after AI failure, and failed work does not loop', async () => {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('后台导入');
  const saved = await storage.savePdf(
    pdfFile('failed.pdf', 'raw bytes survive'),
    { fingerprint: fingerprint('a'), pageCount: 1 },
    documentOptions,
    initial.manifest.revision,
  );
  assert.equal(saved.document.status, 'copied');
  assert.equal(saved.document.processing?.status, 'queued');
  assert.equal(
    await (await storage.openPdf(saved.document.id)).text(),
    'raw bytes survive',
  );

  let analyzeCalls = 0;
  const errors: string[] = [];
  const worker = new BackgroundImports({
    analyze: async () => {
      analyzeCalls += 1;
      throw new Error('AI 未配置');
    },
    synthesize: async () => {
      throw new Error('synthesis must not run');
    },
    onBundle: () => undefined,
    onError: (message) => errors.push(message),
  });
  worker.register(initial.manifest.id, storage);
  worker.resume();
  await waitFor(
    async () =>
      (await storage.load()).manifest.documents[0]?.processing?.status ===
      'failed',
  );
  const failed = await storage.load();
  assert.equal(analyzeCalls, 1);
  assert.equal(failed.digests[saved.document.id], undefined);
  assert.equal(
    await (await storage.openPdf(saved.document.id)).text(),
    'raw bytes survive',
  );
  assert.match(
    failed.manifest.documents[0]!.processing?.error ?? '',
    /AI 未配置/,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(analyzeCalls, 1, 'failed jobs require an explicit retry');
  assert.ok(errors.some((message) => message.includes('PDF 已保存')));
  worker.stop();
});

void test('PDF reading and raw imports do not wait for AI, and no-AI options make zero AI requests', async () => {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('无需等待');
  const pending = await storage.savePdf(
    pdfFile('pending.pdf', 'read immediately'),
    { fingerprint: fingerprint('b'), pageCount: 1 },
    documentOptions,
    initial.manifest.revision,
  );
  const analyzeGate = deferred<DocumentDigest>();
  let analyzeCalls = 0;
  const worker = new BackgroundImports({
    analyze: async (courseStorage, _document) => {
      assert.equal(courseStorage, storage);
      analyzeCalls += 1;
      return analyzeGate.promise;
    },
    synthesize: async () => makeKnowledge(),
    onBundle: () => undefined,
  });
  worker.register(initial.manifest.id, storage);
  worker.resume();
  await waitFor(() => analyzeCalls === 1);
  const read = await Promise.race([
    storage.openPdf(pending.document.id),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('openPdf waited for AI')), 200),
    ),
  ]);
  assert.equal(await read.text(), 'read immediately');
  analyzeGate.resolve(makeDigest(pending.document));
  await waitFor(
    async () => !(await storage.load()).manifest.documents[0]?.processing,
  );
  worker.stop();

  const noAiStorage = new MemoryCourseStorage();
  const noAiInitial = await noAiStorage.initialize('无 AI');
  const noAi = await noAiStorage.savePdf(
    pdfFile('raw-only.pdf'),
    { fingerprint: fingerprint('c'), pageCount: 2 },
    rawOptions,
    noAiInitial.manifest.revision,
  );
  let noAiCalls = 0;
  const noAiWorker = new BackgroundImports({
    analyze: async () => {
      noAiCalls += 1;
      return makeDigest(noAi.document);
    },
    synthesize: async () => {
      noAiCalls += 1;
      return makeKnowledge();
    },
    onBundle: () => undefined,
  });
  noAiWorker.register(noAiInitial.manifest.id, noAiStorage);
  noAiWorker.resume();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(noAiCalls, 0);
  assert.equal(
    (await noAiStorage.load()).manifest.documents[0]?.processing,
    undefined,
  );
  noAiWorker.stop();
});

void test('two queued documents save each digest first and trigger one batched course synthesis', async () => {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('批量综合');
  const first = await save(storage, 'first.pdf', mergeOptions, 'd');
  const second = await save(storage, 'second.pdf', mergeOptions, 'e');
  const analysisGates: Array<Deferred<DocumentDigest>> = [];
  let analyzeCalls = 0;
  let synthesizeCalls = 0;
  let synthesizedIds: string[] = [];
  let synthesizedDigests: string[] = [];
  const synthesisGate = deferred<AiCourseKnowledge>();
  const worker = new BackgroundImports({
    analyze: async (_storage, _document) => {
      analyzeCalls += 1;
      const gate = deferred<DocumentDigest>();
      analysisGates.push(gate);
      return gate.promise;
    },
    synthesize: async (bundle, documentIds) => {
      synthesizeCalls += 1;
      synthesizedIds = [...documentIds];
      synthesizedDigests = documentIds.map(
        (id) => bundle.digests[id]?.documentId ?? 'missing',
      );
      return synthesisGate.promise;
    },
    onBundle: () => undefined,
  });
  worker.register(initial.manifest.id, storage);
  worker.hold();
  worker.resume();
  worker.release();
  await waitFor(() => analyzeCalls === 1);
  analysisGates[0]!.resolve(makeDigest(first));
  await waitFor(() => analyzeCalls === 2);
  analysisGates[1]!.resolve(makeDigest(second));
  await waitFor(() => synthesizeCalls === 1);
  assert.deepEqual(new Set(synthesizedIds), new Set([first.id, second.id]));
  assert.deepEqual(new Set(synthesizedDigests), new Set([first.id, second.id]));
  assert.equal(synthesizeCalls, 1);
  synthesisGate.resolve(makeKnowledge('批量 AI 主题'));
  await waitFor(async () =>
    (await storage.load()).manifest.documents.every(
      (doc) => doc.status === 'course-merged',
    ),
  );
  const done = await storage.load();
  assert.equal(
    done.manifest.documents.filter((doc) => doc.status === 'course-merged')
      .length,
    2,
  );
  assert.equal(done.knowledge.version, 1);
  worker.stop();
});

void test('retrying a failed course synthesis does not re-analyze completed documents', async () => {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('课程重试');
  const document = await save(storage, 'retry.pdf', mergeOptions, 'f');
  const synthesisGates: Array<Deferred<AiCourseKnowledge>> = [];
  let analyzeCalls = 0;
  let synthesizeCalls = 0;
  const worker = new BackgroundImports({
    analyze: async (_storage, item) => {
      analyzeCalls += 1;
      return makeDigest(item);
    },
    synthesize: async () => {
      synthesizeCalls += 1;
      const gate = deferred<AiCourseKnowledge>();
      synthesisGates.push(gate);
      return gate.promise;
    },
    onBundle: () => undefined,
  });
  worker.register(initial.manifest.id, storage);
  worker.resume();
  await waitFor(() => synthesizeCalls === 1);
  synthesisGates[0]!.reject(new Error('课程综合失败'));
  await waitFor(
    async () =>
      (await storage.load()).manifest.documents[0]?.processing?.status ===
      'failed',
  );
  assert.equal(analyzeCalls, 1);
  await worker.retry(initial.manifest.id, document.id);
  await waitFor(() => synthesizeCalls === 2);
  assert.equal(
    analyzeCalls,
    1,
    'retry should reuse the persisted digest checkpoint',
  );
  synthesisGates[1]!.resolve(makeKnowledge('重试后的主题'));
  await waitFor(
    async () =>
      (await storage.load()).manifest.documents[0]?.status === 'course-merged',
  );
  worker.stop();
});

void test('stopping a worker leaves a running checkpoint; stale results are ignored by the next worker', async () => {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('恢复任务');
  const document = await save(storage, 'resume.pdf', documentOptions, '1');
  const firstGate = deferred<DocumentDigest>();
  const secondGate = deferred<DocumentDigest>();
  let analyzeCalls = 0;
  const worker = new BackgroundImports({
    analyze: async () => {
      analyzeCalls += 1;
      return analyzeCalls === 1 ? firstGate.promise : secondGate.promise;
    },
    synthesize: async () => makeKnowledge(),
    onBundle: () => undefined,
  });
  worker.register(initial.manifest.id, storage);
  worker.resume();
  await waitFor(() => analyzeCalls === 1);
  worker.stop();
  firstGate.resolve(makeDigest(document, '过期摘要'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stopped = await storage.load();
  assert.equal(stopped.digests[document.id], undefined);
  assert.equal(stopped.manifest.documents[0]?.processing?.status, 'running');

  const resumed = new BackgroundImports({
    analyze: async () => {
      analyzeCalls += 1;
      return secondGate.promise;
    },
    synthesize: async () => makeKnowledge(),
    onBundle: () => undefined,
  });
  resumed.register(initial.manifest.id, storage);
  resumed.resume();
  await waitFor(() => analyzeCalls === 2);
  secondGate.resolve(makeDigest(document, '恢复后的摘要'));
  await waitFor(
    async () => !(await storage.load()).manifest.documents[0]?.processing,
  );
  const recovered = await storage.load();
  assert.equal(recovered.digests[document.id]?.title, '恢复后的摘要');
  assert.equal(
    recovered.manifest.documents[0]?.status,
    'document-artifacts-ready',
  );
  worker.stop();
  resumed.stop();
});

void test('a raw save concurrent with AI synthesis survives the atomic course checkpoint', async () => {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('并发保存');
  const first = await save(storage, 'ai.pdf', mergeOptions, '2');
  const synthesisGate = deferred<AiCourseKnowledge>();
  let synthesizeCalls = 0;
  const worker = new BackgroundImports({
    analyze: async (_storage, document) => makeDigest(document),
    synthesize: async () => {
      synthesizeCalls += 1;
      return synthesisGate.promise;
    },
    onBundle: () => undefined,
  });
  worker.register(initial.manifest.id, storage);
  worker.resume();
  await waitFor(() => synthesizeCalls === 1);
  const current = await storage.load();
  const raw = await storage.savePdf(
    pdfFile('during-ai.pdf', 'raw concurrent bytes'),
    { fingerprint: fingerprint('3'), pageCount: 1 },
    rawOptions,
    current.manifest.revision,
  );
  synthesisGate.resolve(makeKnowledge('并发 AI 主题'));
  await waitFor(async () =>
    (await storage.load()).manifest.documents.some(
      (doc) => doc.status === 'course-merged',
    ),
  );
  const final = await storage.load();
  assert.equal(findDocument(final, first.id).status, 'course-merged');
  assert.equal(findDocument(final, raw.document.id).fileName, 'during-ai.pdf');
  assert.equal(
    await (await storage.openPdf(raw.document.id)).text(),
    'raw concurrent bytes',
  );
  worker.stop();
});

void test('savePdf rejects duplicate fingerprints and stale revisions', async () => {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('版本保护');
  const metadata = { fingerprint: fingerprint('4'), pageCount: 1 };
  await storage.savePdf(
    pdfFile('duplicate.pdf'),
    metadata,
    rawOptions,
    initial.manifest.revision,
  );
  await assert.rejects(
    () =>
      storage.savePdf(pdfFile('duplicate-again.pdf'), metadata, rawOptions, 1),
    /已经在课程中/,
  );
  await assert.rejects(
    () =>
      storage.savePdf(
        pdfFile('stale.pdf'),
        { fingerprint: fingerprint('5'), pageCount: 1 },
        rawOptions,
        0,
      ),
    /外部修改/,
  );
});

void test('review survives worker restart without publishing or re-running AI; new documents wait for review', async () => {
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('审阅恢复');
  const first = await save(storage, 'first.pdf', mergeOptions, 'a');
  let analyzes = 0, syntheses = 0;
  const dependencies = {
    reviewCourseChanges: true,
    analyze: async (_storage: unknown, doc: DocumentRecord) => { analyzes++; return makeDigest(doc); },
    synthesize: async () => { syntheses++; return makeKnowledge('待接受的主题'); },
    onBundle: () => undefined,
  };
  const worker = new BackgroundImports(dependencies);
  worker.register(initial.manifest.id, storage);
  worker.resume();
  await waitFor(async () => Boolean((await storage.load()).manifest.pendingReview));
  const staged = await storage.load();
  assert.deepEqual(staged.knowledge, initial.knowledge);
  assert.equal(findDocument(staged, first.id).processing?.status, 'review');
  worker.stop();
  const restarted = new BackgroundImports(dependencies);
  restarted.register(initial.manifest.id, storage);
  restarted.resume();
  try {
    const second = await save(storage, 'second.pdf', mergeOptions, 'b');
    restarted.wake();
    await waitFor(async () => Boolean((await storage.load()).digests[second.id]));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(analyzes, 2);
    assert.equal(syntheses, 1);
    const stillPending = await storage.load();
    assert.equal(stillPending.manifest.pendingReview?.id, staged.manifest.pendingReview?.id);
    assert.deepEqual(stillPending.knowledge, initial.knowledge);
    await storage.resolveCourseReview(staged.manifest.pendingReview!.id, true);
    restarted.wake();
    await waitFor(async () => Boolean((await storage.load()).manifest.pendingReview) && (await storage.load()).manifest.pendingReview?.id !== staged.manifest.pendingReview?.id && syntheses === 2);
    const next = await storage.load();
    assert.equal(next.knowledge.version, 1);
    assert.equal(findDocument(next, first.id).includedInCourse, true);
    assert.equal(findDocument(next, second.id).includedInCourse, false);
  } finally { restarted.stop(); }
});

void test('a ready course synthesizes while another course still has documents, preserving each course batch', async () => {
  const short = new MemoryCourseStorage();
  const long = new MemoryCourseStorage();
  const a = await short.initialize('先完成的课程');
  const b = await long.initialize('较多资料的课程');
  await save(short, 'a.pdf', mergeOptions, 'a');
  await save(long, 'b1.pdf', mergeOptions, 'b');
  await save(long, 'b2.pdf', mergeOptions, 'c');
  const order: string[] = [];
  const gate = deferred<DocumentDigest>();
  let blockedDocument: DocumentRecord | undefined;
  const worker = new BackgroundImports({
    analyze: async (_storage, doc) => {
      order.push(doc.fileName);
      if (doc.fileName === 'b2.pdf') { blockedDocument = doc; return gate.promise; }
      return makeDigest(doc);
    },
    synthesize: async (bundle, ids) => {
      order.push(`merge:${bundle.manifest.name}`);
      assert.ok(ids.every(id => bundle.digests[id]), 'course synthesis only receives saved digests');
      if (bundle.manifest.id === b.manifest.id) assert.equal(ids.length, 2, 'long course still synthesizes its batch once');
      return makeKnowledge(bundle.manifest.name);
    },
    onBundle: () => undefined,
  });
  worker.register(a.manifest.id, short);
  worker.register(b.manifest.id, long);
  worker.resume();
  try {
    await waitFor(() => Boolean(blockedDocument));
    assert.deepEqual(order, ['a.pdf', 'b1.pdf', 'merge:先完成的课程', 'b2.pdf']);
    assert.equal((await short.load()).knowledge.version, 1, 'ready course publishes without waiting for unrelated PDF');
    assert.equal((await long.load()).knowledge.version, 0);
    gate.resolve(makeDigest(blockedDocument!));
    await waitFor(async () => (await long.load()).knowledge.version === 1);
    assert.deepEqual(order, ['a.pdf', 'b1.pdf', 'merge:先完成的课程', 'b2.pdf', 'merge:较多资料的课程']);
  } finally { worker.stop(); }
});

void test('same-millisecond course creation produces distinct safe identities', () => {
  const ids = Array.from({length:100}, () => createCourseId(1791200000000));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^course-[a-z0-9]+-[a-f0-9-]{36}$/);
});
