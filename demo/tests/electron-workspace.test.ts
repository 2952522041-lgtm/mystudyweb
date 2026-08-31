import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSafeRelativeSegments,
  resolveWorkspaceLayout,
  sanitizeCourseDirectoryName,
  uniqueCourseDirectoryName,
  WorkspacePathError,
} from '../electron/workspace-paths.ts';
import {
  createCourseDirectory,
  courseFileExists,
  ensureCourseDirectory,
  ensureWorkspace,
  readCourseFile,
  scanCourses,
  writeCourseFile,
} from '../electron/workspace.ts';

function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'yeyu-workspace-'));
}

const courseManifest = (name: string) => ({
  schemaVersion: 1,
  id: 'course-test',
  name,
  revision: 0,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
  activeKnowledgeVersion: 0,
  documents: [],
});

void test('workspace defaults to Documents/页语工作区', () => {
  const layout = resolveWorkspaceLayout(
    path.join('/home', 'someone', 'Documents'),
  );
  assert.equal(
    layout.root,
    path.join('/home', 'someone', 'Documents', '页语工作区'),
  );
  assert.equal(layout.coursesRoot, path.join(layout.root, 'Courses'));
  assert.equal(layout.cacheRoot, path.join(layout.root, 'Cache'));
  assert.equal(layout.settingsRoot, path.join(layout.root, 'Settings'));
});

void test('YEYU_WORKSPACE_ROOT override replaces the default root', () => {
  const layout = resolveWorkspaceLayout(
    '/home/someone/Documents',
    ' /tmp/yeyu-override ',
  );
  assert.equal(layout.root, path.resolve('/tmp/yeyu-override'));
  assert.equal(layout.coursesRoot, path.join(layout.root, 'Courses'));
});

void test('course directory names are sanitized like stored PDF names', () => {
  assert.equal(sanitizeCourseDirectoryName('课程/一:第二章?'), '课程_一_第二章_');
  assert.equal(sanitizeCourseDirectoryName('MAT 3007...'), 'MAT 3007');
  assert.equal(sanitizeCourseDirectoryName('a\nb'), 'a_b');
  assert.equal(sanitizeCourseDirectoryName('..'), '未命名课程');
  assert.equal(sanitizeCourseDirectoryName('.'), '未命名课程');
  assert.equal(sanitizeCourseDirectoryName('   '), '未命名课程');
  assert.equal(sanitizeCourseDirectoryName(''), '未命名课程');
});

void test('duplicate course directories get numbered suffixes', () => {
  assert.equal(uniqueCourseDirectoryName([], 'MAT3007'), 'MAT3007');
  assert.equal(
    uniqueCourseDirectoryName(['MAT3007'], 'MAT3007'),
    'MAT3007-2',
  );
  assert.equal(
    uniqueCourseDirectoryName(['MAT3007', 'MAT3007-2'], 'MAT3007'),
    'MAT3007-3',
  );
});

void test('relative path segments reject every escape pattern', () => {
  assert.deepEqual(assertSafeRelativeSegments(['PDFs', 'a.pdf']), [
    'PDFs',
    'a.pdf',
  ]);

  const escapes: unknown[] = [
    [],
    [''],
    ['a', ''],
    ['..'],
    ['a', '..'],
    ['.'],
    ['a/b'],
    ['a\\b'],
    ['C:'],
    ['C:\\evil'],
    ['a\0b'],
    [42],
    ['a'.repeat(256)],
  ];
  for (const escape of escapes) {
    assert.throws(
      () => assertSafeRelativeSegments(escape as string[]),
      WorkspacePathError,
      `expected rejection for ${JSON.stringify(escape)}`,
    );
  }
});

void test('workspace creation is idempotent', async () => {
  const root = await temporaryDirectory();
  try {
    const layout = resolveWorkspaceLayout(root);
    await ensureWorkspace(layout);
    await ensureWorkspace(layout);
    const entries = await readdir(layout.root);
    assert.deepEqual([...entries].sort(), ['Cache', 'Courses', 'Settings']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('course directories are created sanitized and deduplicated', async () => {
  const root = await temporaryDirectory();
  try {
    const layout = resolveWorkspaceLayout(root);
    await ensureWorkspace(layout);
    assert.equal(
      (await createCourseDirectory(layout.coursesRoot, 'MAT 3007'))
        .directoryName,
      'MAT 3007',
    );
    assert.equal(
      (await createCourseDirectory(layout.coursesRoot, 'MAT 3007'))
        .directoryName,
      'MAT 3007-2',
    );
    assert.equal(
      (await createCourseDirectory(layout.coursesRoot, 'bad/name?'))
        .directoryName,
      'bad_name_',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('course file IO round-trips and blocks path escapes', async () => {
  const root = await temporaryDirectory();
  try {
    const layout = resolveWorkspaceLayout(root);
    await ensureWorkspace(layout);
    const { directoryName } = await createCourseDirectory(
      layout.coursesRoot,
      '课程',
    );

    const payload = new TextEncoder().encode('{"hello":"页语"}');
    await writeCourseFile(layout.coursesRoot, directoryName, [
      'Documents',
      'doc-1',
      'document.json',
    ], payload);
    assert.deepEqual(
      await readCourseFile(layout.coursesRoot, directoryName, [
        'Documents',
        'doc-1',
        'document.json',
      ]),
      payload,
    );
    assert.equal(
      await courseFileExists(layout.coursesRoot, directoryName, [
        'Documents',
        'doc-1',
        'document.json',
      ]),
      true,
    );
    assert.equal(
      await courseFileExists(layout.coursesRoot, directoryName, [
        'Documents',
        'missing.json',
      ]),
      false,
    );

    await assert.rejects(
      () =>
        writeCourseFile(layout.coursesRoot, directoryName, [
          '..',
          'evil.txt',
        ], payload),
      WorkspacePathError,
    );
    await assert.rejects(
      () =>
        writeCourseFile(layout.coursesRoot, directoryName, [
          'PDFs',
          '..',
          'evil.txt',
        ], payload),
      WorkspacePathError,
    );
    await assert.rejects(
      () =>
        writeCourseFile(layout.coursesRoot, directoryName, [
          'C:',
          'evil.txt',
        ], payload),
      WorkspacePathError,
    );
    await assert.rejects(
      () =>
        writeCourseFile(layout.coursesRoot, 'not-a-course-directory', [
          'a.txt',
        ], payload),
      WorkspacePathError,
    );
    assert.equal(await readdir(layout.coursesRoot).then((names) => names.length), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('symlinked entries inside a course directory are rejected', async () => {
  const root = await temporaryDirectory();
  try {
    const layout = resolveWorkspaceLayout(root);
    await ensureWorkspace(layout);
    const { directoryName } = await createCourseDirectory(
      layout.coursesRoot,
      '课程',
    );
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');

    const courseRoot = path.join(layout.coursesRoot, directoryName);
    await symlink(outside, path.join(courseRoot, 'link-dir'));
    await symlink(path.join(outside, 'secret.txt'), path.join(courseRoot, 'link-file.pdf'));

    await assert.rejects(
      () =>
        writeCourseFile(layout.coursesRoot, directoryName, [
          'link-dir',
          'escape.txt',
        ], new TextEncoder().encode('data')),
      WorkspacePathError,
    );
    await assert.rejects(
      () =>
        readCourseFile(layout.coursesRoot, directoryName, [
          'link-file.pdf',
        ]),
      WorkspacePathError,
    );
    await assert.rejects(
      () =>
        ensureCourseDirectory(layout.coursesRoot, directoryName, [
          'link-dir',
          'sub',
        ]),
      WorkspacePathError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('scanCourses only lists directories with a valid manifest', async () => {
  const root = await temporaryDirectory();
  try {
    const layout = resolveWorkspaceLayout(root);
    await ensureWorkspace(layout);
    await mkdir(path.join(layout.coursesRoot, 'B-课程'));
    await mkdir(path.join(layout.coursesRoot, 'A-课程'));
    await mkdir(path.join(layout.coursesRoot, 'A-课程-2'));
    await mkdir(path.join(layout.coursesRoot, '损坏目录'));
    await mkdir(path.join(layout.coursesRoot, '笔记.md'));
    await writeFile(
      path.join(layout.coursesRoot, 'B-课程', 'course.json'),
      JSON.stringify(courseManifest('B')),
    );
    await writeFile(
      path.join(layout.coursesRoot, 'A-课程', 'course.json'),
      JSON.stringify(courseManifest('A')),
    );
    await writeFile(
      path.join(layout.coursesRoot, 'A-课程-2', 'course.json'),
      '{"schemaVersion": 99}',
    );

    const courses = await scanCourses(layout.coursesRoot);
    assert.deepEqual(
      courses.map((course) => course.directoryName),
      ['A-课程', 'B-课程'],
    );
    assert.equal(courses[0]?.manifest.name, 'A');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('electron main and preload keep the secure process boundary', async () => {
  const [main, preload] = await Promise.all([
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  ]);

  for (const requirement of [
    'contextIsolation: true',
    'nodeIntegration: false',
    'sandbox: true',
    "server.listen(0, '127.0.0.1'",
  ]) {
    assert.match(main, new RegExp(requirement.replaceAll('(', '\\(').replaceAll(')', '\\)')));
  }
  assert.doesNotMatch(main, /https:\/\//);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('yeyuDesktop', api\)/);
  assert.doesNotMatch(preload, /ipcRenderer\.send|nodeIntegration/);
});

void test('packaging wires main, preload and the static client bundle', async () => {
  const [packageJson, forgeConfig] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../forge.config.cjs', import.meta.url), 'utf8'),
  ]);
  const pkg = JSON.parse(packageJson) as {
    main: string;
    scripts: Record<string, string>;
  };

  assert.equal(pkg.main, 'electron/dist/main.js');
  assert.match(pkg.scripts['desktop:web'], /VINEXT_EXPORT=1/);
  assert.match(pkg.scripts['desktop:compile'], /electron\/tsconfig\.json/);
  assert.match(pkg.scripts['desktop:build'], /electron-forge package/);
  assert.match(pkg.scripts['desktop:make'], /electron-forge make/);

  assert.match(forgeConfig, /extraResource: \['dist\/client'\]/);
  assert.match(forgeConfig, /maker-squirrel/);
  assert.match(forgeConfig, /win32/);
});
