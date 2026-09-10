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

import { getLanShareAddresses, LanShareServer } from '../electron/lan-share.ts';
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
  options: { method?: string; cookie?: string; body?: string } = {},
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
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...(body
            ? {
                'Content-Length': Buffer.byteLength(body),
                'Content-Type': 'application/json',
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
    const cookie = cookieFrom(login);
    const before = await snapshotFiles(fixture.layout.root);
    await request(started.port!, '/api/share/courses', { cookie });
    await request(
      started.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}`,
      { cookie },
    );
    await request(
      started.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/file`,
      { cookie },
    );
    await request(
      started.port!,
      `/api/share/courses/${encodeURIComponent(fixture.manifest.id)}/documents/${encodeURIComponent(fixture.document.id)}/artifacts/summary`,
      { cookie },
    );
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
