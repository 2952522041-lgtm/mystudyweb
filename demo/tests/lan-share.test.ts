import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getLanShareAddresses,
  LanShareServer,
  type LanSharePdfImportRequest,
} from '../electron/lan-share.ts';
import {
  createCourseDirectory,
  ensureWorkspace,
  writeCourseFile,
} from '../electron/workspace.ts';
import { resolveWorkspaceLayout } from '../electron/workspace-paths.ts';

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function request(
  port: number,
  pathname: string,
  options: {
    method?: string;
    cookie?: string;
    body?: string | Buffer;
    contentType?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? '';
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method ?? 'GET',
        headers: {
          ...options.headers,
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...(body
            ? {
                'Content-Length': Buffer.byteLength(body),
                'Content-Type': options.contentType ?? 'application/json',
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<
              string,
              string | string[] | undefined
            >,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function json<T>(result: HttpResult): T {
  return JSON.parse(result.body.toString('utf8')) as T;
}

function cookieFrom(result: HttpResult): string {
  const setCookie = result.headers['set-cookie'];
  assert.ok(Array.isArray(setCookie) && setCookie[0]);
  return setCookie[0]!.split(';', 1)[0]!;
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, relative);
      } else if (entry.isFile()) {
        snapshot[relative] = createHash('sha256')
          .update(await readFile(fullPath))
          .digest('hex');
      }
    }
  };
  await visit(root, '');
  return snapshot;
}

const manifestFor = (
  name: string,
  id: string,
  document: Record<string, unknown>,
) => ({
  schemaVersion: 1,
  id,
  name,
  revision: 1,
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T01:00:00.000Z',
  activeKnowledgeVersion: 1,
  documents: [document],
});

async function createFixture(root: string) {
  const layout = resolveWorkspaceLayout(root);
  await ensureWorkspace(layout);
  const { directoryName } = await createCourseDirectory(
    layout.coursesRoot,
    '中文 课程',
  );
  const document = {
    id: 'doc-中文-1',
    fingerprint: 'fingerprint-1',
    fileName: '第一 讲义.pdf',
    storedFileName: '第一 讲义.pdf',
    pageCount: 2,
    status: 'course-merged',
    includedInCourse: true,
    includeConversationInsights: false,
    hasSummary: true,
    hasMindmap: true,
    importedAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T01:00:00.000Z',
  };
  const emptyDocument = {
    ...document,
    id: 'doc-empty-2',
    fileName: '无成果.pdf',
    storedFileName: '无成果.pdf',
    hasSummary: false,
    hasMindmap: false,
  };
  const manifest = {
    ...manifestFor('中文 课程', 'course-中文-1', document),
    documents: [document, emptyDocument],
    apiKey: 'sk-leaked-from-old-file',
  };
  const knowledge = {
    schemaVersion: 2,
    courseId: manifest.id,
    version: 1,
    nodes: [
      {
        id: 'course:course-中文-1',
        label: '中文 课程',
        description: '课程主题',
        kind: 'course',
        ownership: 'generated',
        sources: [],
      },
      {
        id: 'concept-1',
        label: '关键概念',
        description: '概念说明',
        kind: 'concept',
        ownership: 'generated',
        sources: [
          {
            documentId: document.id,
            fileName: document.fileName,
            pageStart: 2,
            type: 'pdf',
          },
        ],
      },
    ],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
    updatedAt: manifest.updatedAt,
    apiKey: 'sk-leaked-from-knowledge',
  };
  const digest = {
    schemaVersion: 2,
    documentId: document.id,
    fingerprint: document.fingerprint,
    title: '第一讲义',
    overview: '这是一份中文 PDF 总结。',
    sections: [
      {
        id: 'section-1',
        title: '第一节',
        summary: '第一节内容',
        pageStart: 2,
        pageEnd: 2,
      },
    ],
    concepts: [
      {
        id: 'concept-1',
        label: '关键概念',
        description: '概念说明',
        sources: [
          {
            documentId: document.id,
            fileName: document.fileName,
            pageStart: 2,
            type: 'pdf',
          },
        ],
      },
    ],
    relations: [],
    unresolvedQuestions: [],
    sourcePages: [1, 2],
    promptVersion: 'local-structure-v1',
    updatedAt: manifest.updatedAt,
    apiKey: 'sk-leaked-from-digest',
  };
  await writeCourseFile(
    layout.coursesRoot,
    directoryName,
    ['course.json'],
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  await writeCourseFile(
    layout.coursesRoot,
    directoryName,
    ['Knowledge', 'knowledge-v1.json'],
    new TextEncoder().encode(JSON.stringify(knowledge)),
  );
  await writeCourseFile(
    layout.coursesRoot,
    directoryName,
    ['课程脑图.json'],
    new TextEncoder().encode(JSON.stringify(knowledge)),
  );
  await writeCourseFile(
    layout.coursesRoot,
    directoryName,
    ['Documents', document.id, 'document.json'],
    new TextEncoder().encode(JSON.stringify(digest)),
  );
  await writeCourseFile(
    layout.coursesRoot,
    directoryName,
    ['PDFs', document.storedFileName],
    Buffer.from('%PDF-中文测试'),
  );
  return {
    layout,
    directoryName,
    manifest,
    document,
    emptyDocument,
    knowledge,
    digest,
  };
}

async function addEmptyCourse(layoutRoot: string, name: string, id: string) {
  const layout = resolveWorkspaceLayout(layoutRoot);
  const { directoryName } = await createCourseDirectory(
    layout.coursesRoot,
    name,
  );
  const manifest = { ...manifestFor(name, id, {}), documents: [] };
  await writeCourseFile(
    layout.coursesRoot,
    directoryName,
    ['course.json'],
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
}

function publishedTranslation(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    documentId: fixture.document.id,
    fingerprint: fixture.document.fingerprint,
    pageNumber: 2,
    sourceHash: 'a'.repeat(64),
    targetLanguage: '简体中文',
    provider: 'openai-compatible',
    model: 'test-model',
    promptVersion: 4,
    paragraphs: ['这是已发布的译文。'],
    updatedAt: '2026-09-10T01:00:00.000Z',
    ...overrides,
  };
}

void test('LAN share exposes only authenticated, valid published translations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lan-share-'));
  const client = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-client-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-outside-'));
  const fixture = await createFixture(root);
  const courseRoot = path.join(
    fixture.layout.coursesRoot,
    fixture.directoryName,
  );
  await writeCourseFile(
    fixture.layout.coursesRoot,
    fixture.directoryName,
    ['Translations', fixture.document.id, 'valid.json'],
    new TextEncoder().encode(JSON.stringify(publishedTranslation(fixture))),
  );
  await writeCourseFile(
    fixture.layout.coursesRoot,
    fixture.directoryName,
    ['Translations', fixture.document.id, 'corrupt.json'],
    Buffer.from('{not-json'),
  );
  await writeCourseFile(
    fixture.layout.coursesRoot,
    fixture.directoryName,
    ['Translations', fixture.document.id, 'wrong-document.json'],
    new TextEncoder().encode(
      JSON.stringify(
        publishedTranslation(fixture, {
          documentId: 'another-document',
        }),
      ),
    ),
  );
  await writeCourseFile(
    fixture.layout.coursesRoot,
    fixture.directoryName,
    ['Translations', fixture.document.id, 'demo.json'],
    new TextEncoder().encode(
      JSON.stringify(publishedTranslation(fixture, { provider: 'mock' })),
    ),
  );
  await writeCourseFile(
    fixture.layout.coursesRoot,
    fixture.directoryName,
    ['Translations', fixture.document.id, 'oversized.json'],
    new TextEncoder().encode(
      JSON.stringify(
        publishedTranslation(fixture, {
          paragraphs: ['x'.repeat(200_001)],
        }),
      ),
    ),
  );
  await writeFile(
    path.join(outside, 'secret.json'),
    JSON.stringify({ secret: true }),
  );
  await symlink(
    path.join(outside, 'secret.json'),
    path.join(courseRoot, 'Translations', fixture.document.id, 'linked.json'),
  );
  await writeFile(path.join(client, 'index.html'), 'share');
  const server = new LanShareServer(fixture.layout, client, {
    host: '127.0.0.1',
  });
  try {
    const started = await server.start('翻译读取-abcdef', 0);
    const translationPath = `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/translations`;
    assert.equal((await request(started.port!, translationPath)).status, 401);
    const login = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '翻译读取-abcdef' }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);
    const response = await request(started.port!, translationPath, { cookie });
    assert.equal(response.status, 200);
    const payload = json<{ translations: Array<Record<string, unknown>> }>(
      response,
    );
    assert.equal(payload.translations.length, 1);
    assert.deepEqual(payload.translations[0]?.paragraphs, [
      '这是已发布的译文。',
    ]);
    assert.doesNotMatch(
      response.body.toString('utf8'),
      /secret|sourceText|ocr|apiKey|chat/iu,
    );
    assert.equal(
      (
        await request(started.port!, translationPath, {
          method: 'POST',
          cookie,
          body: '{}',
        })
      ).status,
      405,
    );
    const filtered = await request(
      started.port!,
      `${translationPath}?language=${encodeURIComponent('日本語')}`,
      { cookie },
    );
    assert.equal(filtered.status, 200);
    assert.deepEqual(
      json<{ translations: unknown[] }>(filtered).translations,
      [],
    );
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

void test('LAN share authenticates every data endpoint and reads Chinese files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lan-share-'));
  const client = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-client-'));
  const fixture = await createFixture(root);
  await writeFile(
    path.join(client, 'index.html'),
    '<!doctype html><title>share</title>',
  );
  try {
    const server = new LanShareServer(fixture.layout, client, {
      sessionTtlMs: 100,
      host: '127.0.0.1',
    });
    const status = await server.start('正确密码-123', 0);
    assert.equal(status.running, true);
    assert.ok(status.port);

    assert.equal(
      (await request(status.port!, '/api/share/courses')).status,
      401,
    );
    assert.equal(
      (
        await request(
          status.port!,
          `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/file`,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          status.port!,
          `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/artifacts/summary`,
        )
      ).status,
      401,
    );

    const wrong = await request(status.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '错误密码' }),
    });
    assert.equal(wrong.status, 401);
    assert.doesNotMatch(wrong.body.toString('utf8'), /错误密码|正确密码/);

    const login = await request(status.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '正确密码-123' }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);
    const courses = await request(status.port!, '/api/share/courses', {
      cookie,
    });
    assert.equal(courses.status, 200);
    const listed = json<{ courses: Array<{ name: string }> }>(courses);
    assert.equal(listed.courses[0]?.name, '中文 课程');

    const detail = await request(
      status.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}`,
      { cookie },
    );
    assert.equal(detail.status, 200);
    const loaded = json<{
      manifest: { name: string };
      digests: Record<string, { overview: string }>;
    }>(detail);
    assert.equal(loaded.manifest.name, '中文 课程');
    assert.equal(
      loaded.digests[fixture.document.id]?.overview,
      '这是一份中文 PDF 总结。',
    );
    assert.equal(loaded.digests[fixture.emptyDocument.id], undefined);
    assert.doesNotMatch(detail.body.toString('utf8'), /sk-leaked/);

    const pdf = await request(
      status.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/file`,
      { cookie },
    );
    assert.equal(pdf.status, 200);
    assert.match(String(pdf.headers['content-type']), /application\/pdf/);
    assert.equal(pdf.body.toString(), '%PDF-中文测试');

    const summary = await request(
      status.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/artifacts/summary`,
      { cookie },
    );
    assert.equal(summary.status, 200);
    assert.equal(
      json<{ digest: { title: string } }>(summary).digest.title,
      '第一讲义',
    );
    const missingArtifact = await request(
      status.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${fixture.emptyDocument.id}/artifacts/summary`,
      { cookie },
    );
    assert.equal(missingArtifact.status, 404);

    // The server scans the same workspace on every request; no restart is needed.
    await addEmptyCourse(root, '新增课程', 'course-new');
    const refreshed = json<{ courses: Array<{ name: string }> }>(
      await request(status.port!, '/api/share/courses', { cookie }),
    );
    assert.deepEqual(refreshed.courses.map((course) => course.name).sort(), [
      '中文 课程',
      '新增课程',
    ]);

    await server.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

void test('LAN share persists versioned reading state and rejects stale writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lan-share-'));
  const client = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-client-'));
  const fixture = await createFixture(root);
  await writeFile(path.join(client, 'index.html'), 'share');
  let now = Date.parse('2026-09-28T01:00:00.000Z');
  const endpoint = `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/reading-state`;
  const createServer = () =>
    new LanShareServer(fixture.layout, client, {
      host: '127.0.0.1',
      now: () => now,
    });
  let server = createServer();
  try {
    let started = await server.start('进度同步-abcdef', 0);
    const login = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '进度同步-abcdef' }),
    });
    assert.equal(login.status, 200);
    const session = json<{
      csrfToken: string;
      capabilities: {
        readingState: boolean;
        courseContent: string;
        importPdf: boolean;
        ai: boolean;
        manage: boolean;
      };
    }>(login);
    assert.equal(session.capabilities.readingState, true);
    assert.equal(session.capabilities.courseContent, 'read');
    assert.equal(session.capabilities.importPdf, false);
    assert.equal(session.capabilities.ai, false);
    const cookie = cookieFrom(login);

    const unavailableImport = await request(
      started.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/import?fileName=blocked.pdf`,
      {
        method: 'POST',
        cookie,
        headers: { 'X-Yeyu-CSRF': session.csrfToken },
        body: Buffer.from('%PDF-1.7\nblocked'),
        contentType: 'application/pdf',
      },
    );
    assert.equal(unavailableImport.status, 503);

    const empty = await request(started.port!, endpoint, { cookie });
    assert.equal(empty.status, 200);
    assert.deepEqual(json(empty), { state: null });

    const noCsrf = await request(started.port!, endpoint, {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ page: 2, zoom: 110, expectedVersion: 0 }),
    });
    assert.equal(noCsrf.status, 403);

    const first = await request(started.port!, endpoint, {
      method: 'PUT',
      cookie,
      headers: { 'X-Yeyu-CSRF': session.csrfToken },
      body: JSON.stringify({ page: 2, zoom: 110, expectedVersion: 0, pageFraction: .42, rightMode: 'chat', pdfPanelPercent: 62, unknownField: 'must-not-persist' }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(json(first), {
      state: {
        page: 2,
        zoom: 110,
        pageFraction: .42,
        rightMode: 'chat',
        pdfPanelPercent: 62,
        version: 1,
        updatedAt: '2026-09-28T01:00:00.000Z',
      },
    });

    now += 1000;
    const conflict = await request(started.port!, endpoint, {
      method: 'PUT',
      cookie,
      headers: { 'X-Yeyu-CSRF': session.csrfToken },
      body: JSON.stringify({ page: 1, zoom: 95, expectedVersion: 0 }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(
      json<{ state: { version: number } }>(conflict).state.version,
      1,
    );
    assert.equal(json<{ state: { pageFraction: number } }>(conflict).state.pageFraction, .42);
    for (const fields of [{ pageFraction: -1 }, { pageFraction: 1.1 }, { pageFraction: '0.5' }, { pdfPanelPercent: 39 }, { pdfPanelPercent: 71 }, { rightMode: 'settings' }]) {
      const invalidView = await request(started.port!, endpoint, { method: 'PUT', cookie, headers: { 'X-Yeyu-CSRF': session.csrfToken }, body: JSON.stringify({ page: 2, zoom: 110, expectedVersion: 1, ...fields }) });
      assert.equal(invalidView.status, 400, JSON.stringify(fields));
    }

    const invalidPage = await request(started.port!, endpoint, {
      method: 'PUT',
      cookie,
      headers: { 'X-Yeyu-CSRF': session.csrfToken },
      body: JSON.stringify({ page: 3, zoom: 110, expectedVersion: 1 }),
    });
    assert.equal(invalidPage.status, 400);

    const previousPort = started.port!;
    await server.stop();
    server = createServer();
    started = await server.start('进度同步-new-password', previousPort);
    const relogin = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '进度同步-new-password' }),
    });
    const restored = await request(started.port!, endpoint, {
      cookie: cookieFrom(relogin),
    });
    assert.equal(restored.status, 200);
    assert.equal(json<{ state: { page: number } }>(restored).state.page, 2);
    assert.equal(json<{ state: { pageFraction: number } }>(restored).state.pageFraction, .42);
    assert.equal(json<{ state: { rightMode: string } }>(restored).state.rightMode, 'chat');
    assert.equal(json<{ state: { pdfPanelPercent: number } }>(restored).state.pdfPanelPercent, 62);

    const persisted = JSON.parse(
      await readFile(
        path.join(fixture.layout.settingsRoot, 'shared-reading-state.json'),
        'utf8',
      ),
    ) as { states: Array<Record<string, unknown>> };
    assert.equal(persisted.states.length, 1);
    assert.equal(persisted.states[0]?.courseId, fixture.manifest.id);
    assert.equal(persisted.states[0]?.documentId, fixture.document.id);
    assert.equal('csrfToken' in persisted.states[0]!, false);
    assert.equal('unknownField' in persisted.states[0]!, false);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

void test('LAN share imports a validated PDF through the host renderer bridge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lan-share-'));
  const client = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-client-'));
  const fixture = await createFixture(root);
  await writeFile(path.join(client, 'index.html'), 'share');
  const captured: LanSharePdfImportRequest[] = [];
  let processingStatus = 'queued';
  const server = new LanShareServer(fixture.layout, client, {
    host: '127.0.0.1',
    importPdf: async (requestValue) => {
      captured.push(requestValue);
      return {
        courseId: requestValue.courseId,
        courseName: fixture.manifest.name,
        fileName: requestValue.fileName,
        documentId: 'new-document',
        processing: { phase: 'document', status: processingStatus, updatedAt: '2026-10-02T00:00:00Z', error: 'private-task-details' },
        message: 'PDF 已保存，可立即阅读；AI 整理已加入后台队列。',
        apiKey: 'sk-must-not-leak',
        workspacePath: '/private/course/path',
      };
    },
  });
  try {
    const started = await server.start('上传测试-abcdef', 0);
    const fileName = '第二 讲义.pdf';
    const endpoint =
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/import` +
      `?fileName=${encodeURIComponent(fileName)}` +
      '&fileLastModified=1780000000000' +
      '&generateSummary=1&generateMindmap=0&mergeIntoCourse=1';
    const pdf = Buffer.from('%PDF-1.7\nremote upload');
    assert.equal(
      (
        await request(started.port!, endpoint, {
          method: 'POST',
          body: pdf,
          contentType: 'application/pdf',
        })
      ).status,
      401,
    );
    const login = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '上传测试-abcdef' }),
    });
    assert.equal(login.status, 200);
    const session = json<{
      csrfToken: string;
      capabilities: {
        readingState: boolean;
        courseContent: string;
        importPdf: boolean;
        ai: boolean;
        manage: boolean;
      };
    }>(login);
    assert.equal(session.capabilities.courseContent, 'write');
    assert.equal(session.capabilities.importPdf, true);
    assert.equal(session.capabilities.ai, true);
    assert.equal(session.capabilities.manage, false);
    const cookie = cookieFrom(login);

    assert.equal(
      (
        await request(started.port!, endpoint, {
          method: 'POST',
          cookie,
          body: pdf,
          contentType: 'application/pdf',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(started.port!, endpoint, {
          method: 'POST',
          cookie,
          headers: { 'X-Yeyu-CSRF': session.csrfToken },
          body: Buffer.from('not a PDF'),
          contentType: 'application/pdf',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(started.port!, endpoint, {
          method: 'POST',
          cookie,
          headers: { 'X-Yeyu-CSRF': session.csrfToken },
          body: pdf,
          contentType: 'application/octet-stream',
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await request(
          started.port!,
          endpoint.replace(
            `fileName=${encodeURIComponent(fileName)}`,
            `fileName=${encodeURIComponent('../escape.pdf')}`,
          ),
          {
            method: 'POST',
            cookie,
            headers: { 'X-Yeyu-CSRF': session.csrfToken },
            body: pdf,
            contentType: 'application/pdf',
          },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          started.port!,
          endpoint.replace('generateSummary=1', 'generateSummary=yes'),
          {
            method: 'POST',
            cookie,
            headers: { 'X-Yeyu-CSRF': session.csrfToken },
            body: pdf,
            contentType: 'application/pdf',
          },
        )
      ).status,
      400,
    );

    const imported = await request(started.port!, endpoint, {
      method: 'POST',
      cookie,
      headers: { 'X-Yeyu-CSRF': session.csrfToken },
      body: pdf,
      contentType: 'application/pdf',
    });
    assert.equal(imported.status, 202);
    assert.equal(
      json<{ import: { documentId: string } }>(imported).import.documentId,
      'new-document',
    );
    assert.doesNotMatch(
      imported.body.toString('utf8'),
      /sk-must|private\/course/,
    );
    const received = captured[0];
    assert.ok(received);
    assert.equal(received.courseId, fixture.manifest.id);
    assert.equal(received.fileName, fileName);
    assert.equal(received.fileLastModified, 1780000000000);
    assert.equal(received.generateSummary, true);
    assert.equal(received.generateMindmap, false);
    assert.equal(received.mergeIntoCourse, true);
    assert.deepEqual(Buffer.from(received.fileData), pdf);
    for (const status of ['paused', 'cancelled']) {
      processingStatus = status;
      const result = await request(started.port!, endpoint, { method: 'POST', cookie, headers: { 'X-Yeyu-CSRF': session.csrfToken }, body: pdf, contentType: 'application/pdf' });
      assert.equal(result.status, 202);
      assert.equal(json<{import:{processing:{status:string}}}>(result).import.processing.status, status);
      assert.doesNotMatch(result.body.toString('utf8'), /private-task-details/);
    }
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

void test('LAN share actions enforce CSRF and per-session permissions without leaking host fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lan-share-'));
  const client = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-client-'));
  const fixture = await createFixture(root);
  await writeFile(path.join(client, 'index.html'), 'share');
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = new LanShareServer(fixture.layout, client, {
    host: '127.0.0.1',
    action: async (action) => {
      calls.push(action);
      if (action.name === 'translate_page') {
        return {
          translation: {
            pageNumber: 1,
            targetLanguage: '简体中文',
            paragraphs: ['译文'],
            provider: 'host-provider',
            model: 'host-model',
            updatedAt: '2026-09-28T00:00:00.000Z',
            apiKey: 'sk-never-return',
          },
          workspacePath: '/private/path',
        };
      }
      return {
        removed: true,
        courseId: fixture.manifest.id,
        apiKey: 'sk-never-return',
      };
    },
  });
  try {
    let started = await server.start('动作权限-abcdef', 0, {
      importPdf: false,
      ai: true,
      manage: false,
    });
    let login = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '动作权限-abcdef' }),
    });
    let session = json<{
      csrfToken: string;
      capabilities: {
        importPdf: boolean;
        ai: boolean;
        manage: boolean;
      };
    }>(login);
    let cookie = cookieFrom(login);
    assert.deepEqual(session.capabilities, {
      readingState: true,
      courseContent: 'read',
      importPdf: false,
      ai: true,
      manage: false,
    });
    const translationPath = '/api/share/actions/translate_page';
    const translationBody = JSON.stringify({
      args: {
        courseId: fixture.manifest.id,
        documentId: fixture.document.id,
        page: 1,
        targetLanguage: '简体中文',
      },
    });
    assert.equal(
      (
        await request(started.port!, translationPath, {
          method: 'POST',
          cookie,
          body: translationBody,
        })
      ).status,
      403,
    );
    const translated = await request(started.port!, translationPath, {
      method: 'POST',
      cookie,
      headers: { 'X-Yeyu-CSRF': session.csrfToken },
      body: translationBody,
    });
    assert.equal(translated.status, 200);
    assert.match(translated.body.toString('utf8'), /译文/);
    assert.doesNotMatch(
      translated.body.toString('utf8'),
      /sk-never|private\/path/,
    );
    assert.equal(
      (
        await request(started.port!, '/api/share/actions/remove_course', {
          method: 'POST',
          cookie,
          headers: { 'X-Yeyu-CSRF': session.csrfToken },
          body: JSON.stringify({ args: { courseId: fixture.manifest.id } }),
        })
      ).status,
      403,
    );
    assert.equal(calls.length, 1);

    await server.stop();
    started = await server.start('管理权限-abcdef', started.port!, {
      importPdf: false,
      ai: false,
      manage: true,
    });
    login = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '管理权限-abcdef' }),
    });
    session = json<typeof session>(login);
    cookie = cookieFrom(login);
    assert.equal(session.capabilities.ai, false);
    assert.equal(session.capabilities.manage, true);
    assert.equal(
      (
        await request(started.port!, translationPath, {
          method: 'POST',
          cookie,
          headers: { 'X-Yeyu-CSRF': session.csrfToken },
          body: translationBody,
        })
      ).status,
      403,
    );
    const removed = await request(
      started.port!,
      '/api/share/actions/remove_course',
      {
        method: 'POST',
        cookie,
        headers: { 'X-Yeyu-CSRF': session.csrfToken },
        body: JSON.stringify({ args: { courseId: fixture.manifest.id } }),
      },
    );
    assert.equal(removed.status, 200);
    assert.doesNotMatch(removed.body.toString('utf8'), /sk-never/);
    assert.equal(calls.at(-1)?.name, 'remove_course');
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

void test('disconnecting an AI action aborts the corresponding host task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lan-share-'));
  const client = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-client-'));
  const fixture = await createFixture(root);
  await writeFile(path.join(client, 'index.html'), 'share');
  let markStarted!: () => void;
  let markAborted!: () => void;
  const startedAction = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const abortedAction = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const server = new LanShareServer(fixture.layout, client, {
    host: '127.0.0.1',
    action: (action) =>
      new Promise((_resolve, reject) => {
        markStarted();
        action.signal?.addEventListener(
          'abort',
          () => {
            markAborted();
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      }),
  });
  try {
    const running = await server.start('取消任务-abcdef', 0);
    const login = await request(running.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '取消任务-abcdef' }),
    });
    const session = json<{ csrfToken: string }>(login);
    const body = JSON.stringify({
      args: {
        courseId: fixture.manifest.id,
        documentId: fixture.document.id,
        page: 1,
        targetLanguage: '简体中文',
      },
    });
    const pending = httpRequest({
      host: '127.0.0.1',
      port: running.port!,
      path: '/api/share/actions/translate_page',
      method: 'POST',
      headers: {
        Cookie: cookieFrom(login),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Yeyu-CSRF': session.csrfToken,
      },
    });
    pending.on('error', () => undefined);
    pending.end(body);
    await startedAction;
    pending.destroy();
    await Promise.race([
      abortedAction,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('主电脑任务未收到取消信号。')), 2000),
      ),
    ]);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

void test('LAN share sessions expire, logout, stop, and restart safely', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lan-share-'));
  const client = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-client-'));
  const fixture = await createFixture(root);
  await writeFile(path.join(client, 'index.html'), 'share');
  let now = Date.now();
  const server = new LanShareServer(fixture.layout, client, {
    sessionTtlMs: 1000,
    now: () => now,
    host: '127.0.0.1',
  });
  try {
    const started = await server.start('密码-abcdef', 0);
    const login = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '密码-abcdef' }),
    });
    const cookie = cookieFrom(login);
    assert.equal(
      (await request(started.port!, '/api/share/courses', { cookie })).status,
      200,
    );

    now += 1001;
    assert.equal(
      (await request(started.port!, '/api/share/courses', { cookie })).status,
      401,
    );

    const secondLogin = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '密码-abcdef' }),
    });
    const secondCookie = cookieFrom(secondLogin);
    assert.equal(
      (
        await request(started.port!, '/api/share/logout', {
          method: 'POST',
          cookie: secondCookie,
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await request(started.port!, '/api/share/courses', {
          cookie: secondCookie,
        })
      ).status,
      401,
    );

    const thirdLogin = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '密码-abcdef' }),
    });
    const thirdCookie = cookieFrom(thirdLogin);
    await server.stop();
    assert.deepEqual(server.getStatus(), {
      running: false,
      port: null,
      addresses: [],
    });
    await assert.rejects(() =>
      request(started.port!, '/api/share/courses', { cookie: thirdCookie }),
    );

    const restarted = await server.start('新密码-abcdef', started.port!);
    assert.equal(restarted.running, true);
    assert.equal(
      (
        await request(restarted.port!, '/api/share/courses', {
          cookie: thirdCookie,
        })
      ).status,
      401,
    );
    await server.stop();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

void test('LAN share rejects path escapes, symlinks, and mutating endpoints', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lan-share-'));
  const client = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-client-'));
  const fixture = await createFixture(root);
  await writeFile(path.join(client, 'index.html'), 'share');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-outside-'));
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(
    path.join(outside, 'secret.txt'),
    path.join(client, 'linked.js'),
  );
  const server = new LanShareServer(fixture.layout, client, {
    host: '127.0.0.1',
  });
  try {
    const started = await server.start('路径测试-abcdef', 0);
    const linkedAsset = await request(started.port!, '/linked.js');
    assert.equal(linkedAsset.status, 403);
    assert.doesNotMatch(linkedAsset.body.toString('utf8'), /secret/);
    const login = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '路径测试-abcdef' }),
    });
    const cookie = cookieFrom(login);
    const before = await readFile(
      path.join(
        fixture.layout.coursesRoot,
        fixture.directoryName,
        'course.json',
      ),
      'utf8',
    );

    const traversal = await request(
      started.port!,
      '/api/share/courses/../../outside',
      { cookie },
    );
    assert.equal(traversal.status, 404);
    assert.equal(
      (
        await request(
          started.port!,
          `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/nope/file`,
          { cookie },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          started.port!,
          `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/file?path=../../outside`,
          { cookie },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(started.port!, '/api/share/courses', {
          method: 'POST',
          cookie,
          body: '{}',
        })
      ).status,
      405,
    );
    assert.equal(
      (
        await request(started.port!, '/api/share/ai/generate', {
          method: 'POST',
          cookie,
          body: '{}',
        })
      ).status,
      404,
    );

    const courseRoot = path.join(
      fixture.layout.coursesRoot,
      fixture.directoryName,
    );
    await rm(path.join(courseRoot, 'PDFs', fixture.document.storedFileName));
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(
      path.join(outside, 'secret.txt'),
      path.join(courseRoot, 'PDFs', fixture.document.storedFileName),
    );
    const symlinked = await request(
      started.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/file`,
      { cookie },
    );
    assert.equal(symlinked.status, 404);
    assert.equal(
      await readFile(
        path.join(courseRoot, 'PDFs', fixture.document.storedFileName),
        'utf8',
      ),
      'secret',
    );
    assert.equal(
      await readFile(path.join(courseRoot, 'course.json'), 'utf8'),
      before,
    );

    const manifestPath = path.join(courseRoot, 'course.json');
    const outsideManifestPath = path.join(outside, 'course.json');
    await writeFile(outsideManifestPath, before);
    await rm(manifestPath);
    await symlink(outsideManifestPath, manifestPath);
    const symlinkedManifestList = await request(
      started.port!,
      '/api/share/courses',
      { cookie },
    );
    assert.equal(symlinkedManifestList.status, 200);
    assert.deepEqual(
      json<{ courses: unknown[] }>(symlinkedManifestList).courses,
      [],
    );
    await rm(manifestPath);
    await writeFile(manifestPath, before);
    await server.stop();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

void test('LAN share advertises only non-loopback IPv4 addresses', () => {
  const addresses = getLanShareAddresses(37891, {
    campus: [
      {
        address: '192.168.1.20',
        netmask: '255.255.255.0',
        mac: '00:00:00:00:00:01',
        cidr: '192.168.1.20/24',
        family: 'IPv4',
        internal: false,
      },
      {
        address: 'fe80::1',
        netmask: 'ffff:ffff:ffff:ffff::',
        mac: '00:00:00:00:00:02',
        cidr: 'fe80::1/64',
        scopeid: 1,
        family: 'IPv6',
        internal: false,
      },
    ],
    loopback: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        mac: '00:00:00:00:00:00',
        cidr: '127.0.0.1/8',
        family: 'IPv4',
        internal: true,
      },
    ],
  } as ReturnType<typeof import('node:os').networkInterfaces>);
  assert.deepEqual(addresses, ['http://192.168.1.20:37891/share?yeyu-share=1']);
});

void test('read-only sharing leaves the temporary course workspace unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lan-share-'));
  const client = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-client-'));
  const fixture = await createFixture(root);
  await writeFile(path.join(client, 'index.html'), 'share');
  const server = new LanShareServer(fixture.layout, client, {
    host: '127.0.0.1',
  });
  try {
    const started = await server.start('只读校验-abcdef', 0);
    const login = await request(started.port!, '/api/share/login', {
      method: 'POST',
      body: JSON.stringify({ password: '只读校验-abcdef' }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);
    const before = await snapshotFiles(fixture.layout.root);
    const courses = await request(started.port!, '/api/share/courses', {
      cookie,
    });
    assert.equal(courses.status, 200);
    assert.deepEqual(
      json<{
        courses: Array<{
          id: string;
          name: string;
          updatedAt: string;
          documentCount: number;
        }>;
      }>(courses),
      {
        courses: [
          {
            id: fixture.manifest.id,
            name: fixture.manifest.name,
            updatedAt: fixture.manifest.updatedAt,
            documentCount: fixture.manifest.documents.length,
          },
        ],
      },
    );

    const detail = await request(
      started.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}`,
      { cookie },
    );
    assert.equal(detail.status, 200);
    const loaded = json<{
      manifest: { id: string; name: string };
      knowledge: { courseId: string };
      digests: Record<string, { overview: string }>;
    }>(detail);
    assert.equal(loaded.manifest.id, fixture.manifest.id);
    assert.equal(loaded.manifest.name, fixture.manifest.name);
    assert.equal(loaded.knowledge.courseId, fixture.manifest.id);
    assert.equal(
      loaded.digests[fixture.document.id]?.overview,
      fixture.digest.overview,
    );

    const pdf = await request(
      started.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/file`,
      { cookie },
    );
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.body.toString(), '%PDF-中文测试');

    const summary = await request(
      started.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/artifacts/summary`,
      { cookie },
    );
    assert.equal(summary.status, 200);
    const summaryPayload = json<{
      digest: { title: string; overview: string };
    }>(summary);
    assert.equal(summaryPayload.digest.title, fixture.digest.title);
    assert.equal(summaryPayload.digest.overview, fixture.digest.overview);

    const after = await snapshotFiles(fixture.layout.root);
    assert.deepEqual(after, before);
    assert.ok(Object.keys(before).some((file) => file.endsWith('course.json')));
    assert.ok(Object.keys(before).some((file) => file.includes('PDFs')));
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});

void test('LAN share reports occupied ports and can restart after release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lan-share-'));
  const client = await mkdtemp(path.join(os.tmpdir(), 'yeyu-share-client-'));
  const fixture = await createFixture(root);
  await mkdir(path.join(client, 'assets'));
  await writeFile(path.join(client, 'index.html'), 'share');
  const first = new LanShareServer(fixture.layout, client, {
    host: '127.0.0.1',
  });
  const second = new LanShareServer(fixture.layout, client, {
    host: '127.0.0.1',
  });
  try {
    const started = await first.start('端口测试-abcdef', 0);
    await assert.rejects(
      () => second.start('端口测试-abcdef', started.port!),
      /已被占用/,
    );
    await first.stop();
    const restarted = await second.start('端口测试-abcdef', started.port!);
    assert.equal(restarted.port, started.port);
  } finally {
    await first.stop();
    await second.stop();
    await rm(root, { recursive: true, force: true });
    await rm(client, { recursive: true, force: true });
  }
});
