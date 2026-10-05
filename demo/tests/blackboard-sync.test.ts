import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  atomicJson,
  findCourse,
  importBatch,
  loadConfig,
  readLedger,
  saveReport,
  status,
  validateBatch,
  verifyDocument,
  waitForJobs,
  withLock,
} from '../scripts/blackboard/sync.mjs';
import { contentUrl } from '../scripts/blackboard/rules.mjs';
import {
  scanBlackboard,
  downloadAttachment,
} from '../scripts/blackboard/browser.mjs';

void test('fixed wait polls jobs without reimporting and returns completion or bounded pending timeout', async () => {
  let polls = 0;
  let clock = 0;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const finished = await waitForJobs({}, undefined, {
    now: () => clock,
    sleep,
    intervalMs: 10,
    timeoutMs: 30,
    poll: async () => ({ status: ++polls < 3 ? 'pending' : 'complete' }),
  });
  assert.equal(finished.status, 'complete');
  assert.equal(polls, 3);
  const timedOut = await waitForJobs({}, undefined, {
    now: () => clock,
    sleep,
    intervalMs: 10,
    timeoutMs: 30,
    poll: async () => ({ status: 'pending' }),
  });
  assert.equal(timedOut.status, 'pending');
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.code, 'AI_PENDING_TIMEOUT');
});

const config = {
  schemaVersion: 1,
  site: 'https://bb.cuhk.edu.cn',
  semester: '2610UG',
  courses: [
    {
      code: 'ECE3060',
      blackboardId: '_17870_1',
      yeyuName: 'ece3060',
      enabled: true,
      roots: [{ contentId: '_642863_1', label: 'Content' }],
    },
  ],
};
const pageUrl = contentUrl(config, config.courses[0], '_642863_1');
const attachment = {
  course: 'ECE3060',
  sourceUrl:
    'https://bb.cuhk.edu.cn/bbcswebdav/pid-1-dt-content-rid-2_1/xid-2_1',
  fileName: 'Lecture 1.pdf',
  title: 'Lecture 1',
  trail: ['Content'],
  pageUrl,
};
const bytes = Buffer.from('PDF test boundary fixture');
const fingerprint = createHash('sha256').update(bytes).digest('hex');
function batch(localPath: string) {
  return {
    schemaVersion: 1,
    semester: '2610UG',
    complete: true,
    scannedAt: new Date().toISOString(),
    pages: [{ course: 'ECE3060', url: pageUrl }],
    attachments: [{ ...attachment, localPath }],
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yeyu-bb-sync-'));
  const paths = {
    root: path.join(root, 'sync'),
    workspace: path.join(root, 'workspace'),
    sofficePath: '/not-used',
  };
  const directory = path.join(paths.workspace, 'Courses', 'ece3060');
  await fs.mkdir(path.join(directory, 'PDFs'), { recursive: true });
  const source = path.join(root, 'Lecture 1.pdf');
  await fs.writeFile(source, bytes);
  const manifest = {
    schemaVersion: 1,
    id: 'course-test',
    name: 'ece3060',
    revision: 1,
    activeKnowledgeVersion: 1,
    documents: [] as Record<string, unknown>[],
  };
  await atomicJson(path.join(directory, 'course.json'), manifest);
  let calls = 0;
  const prepared = {
    originalPath: source,
    pdfPath: source,
    sourceSha256: fingerprint,
    pdfSha256: fingerprint,
    pageCount: 1,
    converted: false,
  };
  const save = async (
    processing: unknown = { phase: 'document', status: 'queued' },
  ) => {
    manifest.documents = [
      {
        id: 'doc-test',
        fingerprint,
        storedFileName: 'Lecture 1.pdf',
        fileName: 'Lecture 1.pdf',
        pageCount: 1,
        hasSummary: !processing,
        hasMindmap: !processing,
        includedInCourse: !processing,
        ...(processing ? { processing } : {}),
      },
    ];
    await fs.writeFile(path.join(directory, 'PDFs', 'Lecture 1.pdf'), bytes);
    await atomicJson(path.join(directory, 'course.json'), manifest);
    if (!processing) {
      const docDir = path.join(directory, 'Documents', 'doc-test');
      await atomicJson(path.join(docDir, 'document.json'), {
        documentId: 'doc-test',
        fingerprint,
      });
      await atomicJson(path.join(docDir, 'PDF脑图.json'), { nodes: [] });
      await fs.writeFile(path.join(docDir, 'PDF总结.md'), 'Summary');
      await fs.writeFile(path.join(docDir, 'PDF脑图.svg'), '<svg/>');
      await atomicJson(path.join(directory, 'Knowledge', 'knowledge-v1.json'), {
        courseId: 'course-test',
        version: 1,
      });
    }
  };
  const dependencies = {
    preparePdf: async () => prepared,
    connectYeyu: async () => ({
      call: async (name: string) => {
        if (name === 'yeyu_get_state')
          return { courseLibrary: { loading: false } };
        assert.equal(name, 'yeyu_import_pdf');
        calls++;
        await save();
        return { documentId: 'doc-test' };
      },
      close: async () => {},
    }),
  };
  return {
    root,
    paths,
    directory,
    manifest,
    source,
    prepared,
    save,
    dependencies,
    calls: () => calls,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

void test('configuration fixes the three enabled courses and pauses CSC3002', async () => {
  const value = await loadConfig();
  assert.deepEqual(
    value.courses
      .filter((c: { enabled: boolean }) => c.enabled)
      .map((c: { code: string }) => c.code),
    ['ECE3060', 'ECE3080', 'ECE3250'],
  );
  assert.equal(
    value.courses.find((c: { code: string }) => c.code === 'CSC3002').enabled,
    false,
  );
});
void test('batch rejects stale/partial scans, missing download paths and paused courses', () => {
  assert.doesNotThrow(() => validateBatch(config, batch('/tmp/Lecture 1.pdf')));
  for (const changed of [
    { complete: false },
    { pages: [] },
    { scannedAt: '2020-01-01' },
    { attachments: [{ ...attachment }] },
    {
      attachments: [
        { ...attachment, course: 'CSC3002', localPath: '/tmp/file.pdf' },
      ],
    },
  ])
    assert.throws(() =>
      validateBatch(config, { ...batch('/tmp/Lecture 1.pdf'), ...changed }),
    );
  assert.throws(() =>
    validateBatch(config, {
      ...batch('/tmp/a.pdf'),
      attachments: [
        {
          ...attachment,
          fileName: 'Lecture preview.pdf',
          localPath: '/tmp/a.pdf',
        },
      ],
    }),
  );
});
void test('import persists queued state; second run checks real hash and never reimports', async () => {
  const f = await fixture();
  try {
    const first = await importBatch(
      config,
      batch(f.source),
      f.paths,
      f.dependencies,
    );
    assert.equal(first.status, 'pending');
    assert.equal(first.items[0].newlyImported, true);
    assert.equal(f.calls(), 1);
    const second = await importBatch(
      config,
      batch(f.source),
      f.paths,
      f.dependencies,
    );
    assert.equal(second.status, 'pending');
    assert.equal(f.calls(), 1);
    assert.equal(second.notify, false);
    assert.equal((await readLedger(f.paths.root)).items.length, 1);
    await f.save(null);
    const done = await status(config, f.paths);
    assert.equal(done.status, 'complete');
    assert.equal(done.sourceChecked, false);
  } finally {
    await f.cleanup();
  }
});
void test('replacement bytes at the same source URL create a new version and preserve old records', async () => {
  const f = await fixture();
  try {
    await importBatch(config, batch(f.source), f.paths, f.dependencies);
    const replacement = Buffer.from('different file version');
    const updatedHash = createHash('sha256').update(replacement).digest('hex');
    const base = await f.dependencies.connectYeyu();
    const updated = await importBatch(config, batch(f.source), f.paths, {
      preparePdf: async () => ({
        ...f.prepared,
        sourceSha256: updatedHash,
        pdfSha256: updatedHash,
      }),
      connectYeyu: async () => ({
        ...base,
        call: async (name: string) => {
          if (name === 'yeyu_get_state') return base.call(name);
          f.manifest.documents.push({
            id: 'doc-updated',
            fingerprint: updatedHash,
            storedFileName: 'Lecture 1-2.pdf',
            fileName: 'Lecture 1.pdf',
            pageCount: 1,
            processing: { phase: 'document', status: 'queued' },
          });
          await fs.writeFile(
            path.join(f.directory, 'PDFs', 'Lecture 1-2.pdf'),
            replacement,
          );
          await atomicJson(path.join(f.directory, 'course.json'), f.manifest);
          return { documentId: 'doc-updated' };
        },
      }),
    });
    assert.equal(updated.items[0].newlyImported, true);
    assert.equal((await readLedger(f.paths.root)).items.length, 2);
    assert.equal(f.manifest.documents.length, 2);
    assert.deepEqual(
      await fs.readFile(path.join(f.directory, 'PDFs', 'Lecture 1.pdf')),
      bytes,
    );
  } finally {
    await f.cleanup();
  }
});
void test('saved PDF after ambiguous MCP timeout is reconciled without a duplicate', async () => {
  const f = await fixture();
  try {
    const base = await f.dependencies.connectYeyu();
    const first = await importBatch(config, batch(f.source), f.paths, {
      ...f.dependencies,
      connectYeyu: async () => ({
        ...base,
        call: async (name: string) => {
          const result = await base.call(name);
          if (name === 'yeyu_import_pdf') throw Error('timeout');
          return result;
        },
      }),
    });
    assert.equal(first.status, 'needs_attention');
    assert.equal(f.calls(), 1);
    await importBatch(config, batch(f.source), f.paths, f.dependencies);
    assert.equal(f.calls(), 1);
  } finally {
    await f.cleanup();
  }
});
void test('AI failure and missing artifacts are not called complete or blindly reimported', async () => {
  const f = await fixture();
  try {
    await f.save({ phase: 'course', status: 'failed' });
    const result = await importBatch(
      config,
      batch(f.source),
      f.paths,
      f.dependencies,
    );
    assert.equal(result.items[0].status, 'failed');
    assert.equal(f.calls(), 0);
    await f.save(null);
    await fs.unlink(
      path.join(f.directory, 'Documents', 'doc-test', 'PDF脑图.svg'),
    );
    assert.equal((await status(config, f.paths)).status, 'needs_attention');
  } finally {
    await f.cleanup();
  }
});
void test('converter output requires explicit visual review before importing new slides', async () => {
  const f = await fixture();
  try {
    const result = await importBatch(config, batch(f.source), f.paths, {
      ...f.dependencies,
      preparePdf: async () => ({
        ...f.prepared,
        converted: true,
        visualReviewRequired: true,
      }),
    });
    assert.equal(result.items[0].code, 'CONVERSION_REVIEW_REQUIRED');
    assert.equal(f.calls(), 0);
  } finally {
    await f.cleanup();
  }
});
void test('destination bytes and unsafe manifest paths fail verification', async () => {
  const f = await fixture();
  try {
    await f.save();
    await fs.writeFile(
      path.join(f.directory, 'PDFs', 'Lecture 1.pdf'),
      'changed',
    );
    await assert.rejects(
      () =>
        verifyDocument(
          { directory: f.directory, manifest: f.manifest },
          fingerprint,
          1,
        ),
      /哈希/,
    );
    f.manifest.documents[0].storedFileName = '../secret';
    await assert.rejects(
      () =>
        verifyDocument(
          { directory: f.directory, manifest: f.manifest },
          fingerprint,
          1,
        ),
      /不安全/,
    );
    await fs.symlink(
      f.directory,
      path.join(f.paths.workspace, 'Courses', 'alias'),
    );
    assert.equal(
      (await findCourse(f.paths.workspace, 'ece3060')).manifest.id,
      'course-test',
    );
  } finally {
    await f.cleanup();
  }
});
void test('overlapping runs fail closed and release the lock on errors', async () => {
  const f = await fixture();
  try {
    await withLock(f.paths.root, async () => {
      await assert.rejects(
        () => withLock(f.paths.root, async () => {}),
        /已有同步/,
      );
    });
    await assert.rejects(
      () =>
        withLock(f.paths.root, async () => {
          throw Error('test');
        }),
      /test/,
    );
    await withLock(f.paths.root, async () => {});
  } finally {
    await f.cleanup();
  }
});
void test('unchanged and repeated identical failure reports do not notify again', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await saveReport(f.paths.root, { status: 'unchanged', items: [] }))
        .notify,
      false,
    );
    assert.equal(
      (
        await saveReport(f.paths.root, {
          status: 'blocked',
          code: 'AUTH_REQUIRED',
          items: [],
        })
      ).notify,
      true,
    );
    assert.equal(
      (
        await saveReport(f.paths.root, {
          status: 'blocked',
          code: 'AUTH_REQUIRED',
          items: [],
        })
      ).notify,
      false,
    );
  } finally {
    await f.cleanup();
  }
});
void test('browser collector fails on login and never guesses download URLs', async () => {
  const tab = {
    url: async () => pageUrl,
    title: async () => '',
    goto: async () => {},
    playwright: {
      evaluate: async () => ({ text: 'LOGIN', contentFound: false, links: [] }),
    },
  };
  await assert.rejects(
    () => scanBlackboard(tab, config),
    (e: unknown) => (e as { code: string }).code === 'AUTH_REQUIRED',
  );
  const disabled = { ...attachment, course: 'CSC3002' };
  await assert.rejects(
    () => downloadAttachment(tab, config, disabled),
    /未启用/,
  );
});
void test('browser collector visits folders once, excludes previews and emits complete manifest', async () => {
  let current = pageUrl;
  const folder = contentUrl(config, config.courses[0], '_660549_1');
  const pages: Record<string, unknown> = {
    [pageUrl]: {
      contentFound: true,
      text: 'Lecture Notes',
      links: [{ href: folder, text: 'Lecture Notes', context: '' }],
    },
    [folder]: {
      contentFound: true,
      text: 'Lecture 1',
      links: [
        { href: folder, text: 'Lecture Notes', context: '' },
        { href: attachment.sourceUrl, text: 'Lecture 1.pdf', context: '' },
        {
          href: attachment.sourceUrl + '/preview',
          text: 'Lecture preview.pdf',
          context: '',
        },
      ],
    },
  };
  const tab = {
    url: async () => current,
    title: async () => 'Content',
    goto: async (url: string) => {
      current = url;
    },
    playwright: { evaluate: async () => pages[current] },
  };
  const scan = await scanBlackboard(tab, config);
  assert.equal(scan.complete, true);
  assert.equal(scan.pages.length, 2);
  assert.equal(scan.attachments.length, 1);
  assert.equal(scan.excluded.length, 1);
});

void test('review, paused and cancelled imports stop polling without duplicate submission', async () => {
  const f = await fixture();
  try {
    await importBatch(config, batch(f.source), f.paths, f.dependencies);
    for (const [state, code] of [['review','COURSE_REVIEW_REQUIRED'],['paused','AI_PAUSED'],['cancelled','AI_CANCELLED']]) {
      await f.save({phase:'course', status:state});
      const checked = await status(config, f.paths);
      assert.equal(checked.status, 'needs_attention');
      assert.equal(checked.items[0].code, code);
      const repeat = await importBatch(config, batch(f.source), f.paths, f.dependencies);
      assert.equal(repeat.status, 'needs_attention');
      assert.equal(f.calls(), 1);
      const done = await waitForJobs({}, undefined, {
        poll: async () => checked,
        sleep: async () => assert.fail('review/control states must not continue polling'),
      });
      assert.equal(done.status, 'needs_attention');
    }
  } finally { await f.cleanup(); }
});
