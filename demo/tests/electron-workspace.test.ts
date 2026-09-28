import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

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
import { handleSquirrelStartup } from '../electron/squirrel.ts';
import {
  ReadingStateConflictError,
  ReadingStateStore,
} from '../electron/reading-state-store.ts';

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
  assert.equal(
    sanitizeCourseDirectoryName('课程/一:第二章?'),
    '课程_一_第二章_',
  );
  assert.equal(sanitizeCourseDirectoryName('MAT 3007...'), 'MAT 3007');
  assert.equal(sanitizeCourseDirectoryName('a\nb'), 'a_b');
  assert.equal(sanitizeCourseDirectoryName('..'), '未命名课程');
  assert.equal(sanitizeCourseDirectoryName('.'), '未命名课程');
  assert.equal(sanitizeCourseDirectoryName('   '), '未命名课程');
  assert.equal(sanitizeCourseDirectoryName(''), '未命名课程');
});

void test('duplicate course directories get numbered suffixes', () => {
  assert.equal(uniqueCourseDirectoryName([], 'MAT3007'), 'MAT3007');
  assert.equal(uniqueCourseDirectoryName(['MAT3007'], 'MAT3007'), 'MAT3007-2');
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

void test('shared reading state serializes concurrent writes and survives restart', async () => {
  const root = await temporaryDirectory();
  try {
    const layout = resolveWorkspaceLayout(root);
    await ensureWorkspace(layout);
    const store = new ReadingStateStore(layout.settingsRoot, () =>
      Date.parse('2026-09-28T02:00:00.000Z'),
    );
    const results = await Promise.allSettled([
      store.put('course-1', 'document-1', {
        page: 2,
        zoom: 100,
        expectedVersion: 0,
      }),
      store.put('course-1', 'document-1', {
        page: 3,
        zoom: 110,
        expectedVersion: 0,
      }),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(rejected.reason instanceof ReadingStateConflictError);

    const restored = await new ReadingStateStore(layout.settingsRoot).get(
      'course-1',
      'document-1',
    );
    assert.equal(restored?.version, 1);
    assert.ok(restored?.page === 2 || restored?.page === 3);
    assert.ok(restored?.zoom === 100 || restored?.zoom === 110);
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
    await writeCourseFile(
      layout.coursesRoot,
      directoryName,
      ['Documents', 'doc-1', 'document.json'],
      payload,
    );
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
        writeCourseFile(
          layout.coursesRoot,
          directoryName,
          ['..', 'evil.txt'],
          payload,
        ),
      WorkspacePathError,
    );
    await assert.rejects(
      () =>
        writeCourseFile(
          layout.coursesRoot,
          directoryName,
          ['PDFs', '..', 'evil.txt'],
          payload,
        ),
      WorkspacePathError,
    );
    await assert.rejects(
      () =>
        writeCourseFile(
          layout.coursesRoot,
          directoryName,
          ['C:', 'evil.txt'],
          payload,
        ),
      WorkspacePathError,
    );
    await assert.rejects(
      () =>
        writeCourseFile(
          layout.coursesRoot,
          'not-a-course-directory',
          ['a.txt'],
          payload,
        ),
      WorkspacePathError,
    );
    assert.equal(
      await readdir(layout.coursesRoot).then((names) => names.length),
      1,
    );
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
    await symlink(
      path.join(outside, 'secret.txt'),
      path.join(courseRoot, 'link-file.pdf'),
    );

    await assert.rejects(
      () =>
        writeCourseFile(
          layout.coursesRoot,
          directoryName,
          ['link-dir', 'escape.txt'],
          new TextEncoder().encode('data'),
        ),
      WorkspacePathError,
    );
    await assert.rejects(
      () =>
        readCourseFile(layout.coursesRoot, directoryName, ['link-file.pdf']),
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
    "server.listen(PACKAGED_APP_PORT, '127.0.0.1'",
    'app.requestSingleInstanceLock()',
    'window.webContents.session.flushStorageData()',
    'applyNavigationGuards(window)',
    'setWindowOpenHandler',
    'will-navigate',
    'resolveDevTargetUrl',
  ]) {
    assert.match(
      main,
      new RegExp(requirement.replaceAll('(', '\\(').replaceAll(')', '\\)')),
    );
  }
  assert.doesNotMatch(main, /https:\/\//);
  assert.match(
    preload,
    /contextBridge\.exposeInMainWorld\('yeyuDesktop', api\)/,
  );
  assert.doesNotMatch(preload, /ipcRenderer\.send|nodeIntegration/);
});

void test('squirrel startup is a no-op off Windows and wired early in main', async () => {
  assert.equal(handleSquirrelStartup('linux'), false);
  assert.equal(handleSquirrelStartup('darwin'), false);
  // win32 分支会 require('electron-squirrel-startup')（其内部 require('electron')），
  // 单元测试不触发真实加载；主进程接线用结构断言覆盖。
  const main = await readFile(
    new URL('../electron/main.ts', import.meta.url),
    'utf8',
  );
  const wiringIndex = main.indexOf('handleSquirrelStartup()');
  const firstWindowUse = main.indexOf('app.disableHardwareAcceleration()');
  assert.ok(wiringIndex >= 0, 'main.ts 应在最早期处理 Squirrel 事件。');
  assert.ok(
    wiringIndex < firstWindowUse,
    'Squirrel 处理必须先于窗口/加速设置。',
  );
});

void test('windows squirrel metadata is complete', async () => {
  const [packageJson, forgeConfig] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../forge.config.cjs', import.meta.url), 'utf8'),
  ]);
  const pkg = JSON.parse(packageJson) as {
    productName?: string;
    description?: string;
    author?: string;
  };

  assert.equal(pkg.productName, '页语');
  assert.ok(pkg.description, 'package.json 需要真实 description。');
  assert.ok(pkg.author, 'package.json 需要真实 author。');

  // electron-winstaller 的 NuGet manifest 必需项（HANDOFF 13.2）。
  assert.match(forgeConfig, /title: '页语'/);
  assert.match(forgeConfig, /authors: '余思诚'/);
  assert.match(
    forgeConfig,
    /description: '本地课程知识库、PDF 随页翻译与 AI 答疑阅读器'/,
  );
  assert.match(forgeConfig, /name: 'yeyu'/);
});

void test('debian maker is configured for the Ubuntu install', async () => {
  const require = createRequire(import.meta.url);
  const forgeConfig = require('../forge.config.cjs') as {
    packagerConfig: { ignore: RegExp[] };
    makers: Array<{
      name: string;
      config: { options?: Record<string, unknown> };
    }>;
  };

  const deb = forgeConfig.makers.find(
    (maker) => maker.name === '@electron-forge/maker-deb',
  );
  assert.ok(deb, '必须配置 @electron-forge/maker-deb。');
  const options = deb.config.options ?? {};

  // 包名、可执行名与图标名一致（yeyu），菜单显示名是「页语」。
  assert.equal(options.name, 'yeyu');
  assert.equal(options.bin, 'yeyu');
  assert.equal(options.productName, '页语');
  assert.equal(options.maintainer, '余思诚 <2952522041@qq.com>');
  assert.ok(options.homepage);
  assert.deepEqual(options.categories, ['Education']);
  assert.equal(options.section, 'education');
  assert.ok(options.description, 'deb 包需要 description。');

  // 图标与 .desktop 模板都必须真实存在，否则 make 阶段才报错。
  const icons = options.icon as Record<string, string>;
  for (const [resolution, iconPath] of Object.entries(icons)) {
    const info = await stat(iconPath).catch(() => null);
    assert.ok(info?.isFile(), `图标 ${resolution} 不存在：${iconPath}`);
    assert.equal(
      path.basename(iconPath),
      `yeyu-${resolution.split('x')[0]}.png`,
    );
  }
  const template = await stat(options.desktopTemplate as string).catch(
    () => null,
  );
  assert.ok(template?.isFile(), '自定义 .desktop 模板不存在。');
  const templateText = await readFile(
    options.desktopTemplate as string,
    'utf8',
  );
  assert.match(templateText, /Name=<%=? productName %>/);
  assert.match(templateText, /Exec=<%=? name %> %U/);

  // 图标是构建期资产，不需要打进应用包。
  assert.ok(
    forgeConfig.packagerConfig.ignore.some((pattern) =>
      pattern.test('/assets/'),
    ),
    'packagerConfig.ignore 应排除 /assets。',
  );
});

void test('packaging wires main, preload and the static client bundle', async () => {
  const [packageJson, forgeConfig, buildScript] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../forge.config.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build-electron.mjs', import.meta.url), 'utf8'),
  ]);
  const pkg = JSON.parse(packageJson) as {
    main: string;
    scripts: Record<string, string>;
  };

  assert.equal(pkg.main, 'electron/dist/main.js');
  assert.match(pkg.scripts['desktop:web'], /VINEXT_EXPORT=1/);
  assert.match(pkg.scripts['desktop:compile'], /build-electron\.mjs/);
  assert.match(pkg.scripts['desktop:build'], /electron-forge package/);
  assert.match(pkg.scripts['desktop:make'], /electron-forge make/);
  assert.match(
    pkg.scripts['desktop:test'],
    /desktop:compile[\s\S]*electron-smoke\.smoke\.ts/,
  );

  // sandbox preload 只能加载内置模块：preload.ts 及其依赖必须被 esbuild
  // 打包成单个自包含 CommonJS 文件（HANDOFF 13.1）。
  assert.match(
    buildScript,
    /entryPoints: \[path\.join\(electronDir, 'preload\.ts'\)\]/,
  );
  assert.match(buildScript, /bundle: true/);
  assert.match(buildScript, /format: 'cjs'/);
  assert.match(buildScript, /outfile: path\.join\(distDir, 'preload\.js'\)/);

  assert.match(forgeConfig, /extraResource: \['dist\/client'\]/);
  assert.match(forgeConfig, /maker-squirrel/);
  assert.match(forgeConfig, /win32/);
});
