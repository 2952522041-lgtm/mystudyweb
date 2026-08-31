import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * Windows 上创建符号链接需要管理员权限或开发者模式；无权限时跳过
 * symlink 专项测试，其余路径逃逸用例仍会全量执行。
 */
function probeSymlinkSupport(): boolean {
  try {
    const probeDirectory = mkdtempSync(path.join(os.tmpdir(), 'yeyu-symlink-'));
    try {
      symlinkSync(probeDirectory, path.join(probeDirectory, 'probe'));
      return true;
    } finally {
      rmSync(probeDirectory, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
}

const symlinkSupported = probeSymlinkSupport();

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
  resolveDeletableCourseDirectory,
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

void test('workspace defaults to Documents/页语工作区', async () => {
  const documentsDir = await temporaryDirectory();
  const layout = resolveWorkspaceLayout(documentsDir);
  assert.equal(layout.root, path.join(documentsDir, '页语工作区'));
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

void test(
  'symlinked entries inside a course directory are rejected',
  { skip: symlinkSupported ? false : '当前环境无法创建符号链接（需要管理员或开发者模式）' },
  async () => {
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

void test('deletable course directory resolves real courses and rejects everything else', async () => {
  const root = await temporaryDirectory();
  try {
    const layout = resolveWorkspaceLayout(root);
    await ensureWorkspace(layout);
    const { directoryName } = await createCourseDirectory(
      layout.coursesRoot,
      'MAT 3007',
    );

    const target = await resolveDeletableCourseDirectory(
      layout.coursesRoot,
      directoryName,
    );
    assert.equal(
      target,
      path.join(layout.coursesRoot, 'MAT 3007'),
      '合法课程目录应解析为 Courses 根下的绝对路径',
    );

    const rejects: string[] = [
      // 不存在的课程目录。
      '不存在的课程',
      // sanitize 后不再等于原值的名字（含非法字符或结尾空白）。
      'MAT 3007...',
      'bad/name?',
      '..',
      'a\\b',
      'C:',
      '',
    ];
    for (const name of rejects) {
      await assert.rejects(
        () => resolveDeletableCourseDirectory(layout.coursesRoot, name),
        WorkspacePathError,
        `expected rejection for ${JSON.stringify(name)}`,
      );
    }

    // 目标是文件而不是目录时也必须拒绝。
    await writeFile(path.join(layout.coursesRoot, 'notes.md'), '笔记');
    await assert.rejects(
      () => resolveDeletableCourseDirectory(layout.coursesRoot, 'notes.md'),
      WorkspacePathError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test(
  'a symlinked course directory is never deletable',
  { skip: symlinkSupported ? false : '当前环境无法创建符号链接（需要管理员或开发者模式）' },
  async () => {
    const root = await temporaryDirectory();
    try {
      const layout = resolveWorkspaceLayout(root);
      await ensureWorkspace(layout);
      const outside = path.join(root, 'outside');
      await mkdir(outside);
      // 目录名本身合法（sanitize 原样保留），但它是一个指向外部的符号链接。
      await symlink(outside, path.join(layout.coursesRoot, '链接课程'));

      await assert.rejects(
        () =>
          resolveDeletableCourseDirectory(layout.coursesRoot, '链接课程'),
        WorkspacePathError,
        '符号链接目录不允许通过删除接口移入回收站',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
    productName?: string;
    author?: string;
    description?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts: Record<string, string>;
  };

  assert.equal(pkg.main, 'electron/dist/main.js');
  assert.match(pkg.scripts['desktop:web'], /VINEXT_EXPORT=1/);
  assert.match(pkg.scripts['desktop:compile'], /electron\/tsconfig\.json/);
  assert.match(pkg.scripts['desktop:build'], /electron-forge package/);
  assert.match(pkg.scripts['desktop:make'], /electron-forge make/);
  // Squirrel.Windows 的 NuGet manifest 必需元数据。
  assert.ok(pkg.productName, 'package.json 需要 productName');
  assert.ok(pkg.author, 'package.json 需要 author');
  assert.ok(pkg.description, 'package.json 需要 description');

  assert.match(forgeConfig, /extraResource: \['dist\/client'\]/);
  assert.match(forgeConfig, /maker-squirrel/);
  assert.match(forgeConfig, /win32/);
  assert.match(forgeConfig, /authors/);
  assert.match(forgeConfig, /description/);
});

void test('main process handles Squirrel install lifecycle before startup', async () => {
  const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(packageJson) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const main = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  // Squirrel 事件必须在注册任何启动逻辑之前检查，处理到事件时直接退出。
  assert.match(main, /import squirrelStartup from 'electron-squirrel-startup';/);
  const squirrelIndex = main.indexOf('if (squirrelStartup)');
  const whenReadyIndex = main.indexOf('app.whenReady()');
  assert.ok(squirrelIndex >= 0, 'main.ts 必须处理 Squirrel 启动事件');
  assert.ok(whenReadyIndex > squirrelIndex, 'Squirrel 检查必须在 whenReady 之前');
  assert.match(main, /if \(squirrelStartup\) \{\s*app\.quit\(\);\s*\} else \{/);
  // electron-packager 只打包 dependencies；主进程运行时模块放 devDependencies
  // 会在打包后的应用里报 Cannot find module。
  assert.ok(
    pkg.dependencies?.['electron-squirrel-startup'],
    'electron-squirrel-startup 必须是生产依赖',
  );
  assert.equal(
    pkg.devDependencies?.['electron-squirrel-startup'],
    undefined,
    'electron-squirrel-startup 不能留在 devDependencies',
  );
});
