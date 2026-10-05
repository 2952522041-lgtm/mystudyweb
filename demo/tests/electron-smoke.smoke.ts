import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { DESKTOP_METHOD_NAMES } from '../electron/api.ts';
import {
  SMOKE_CREATE_COURSE_ENV_VAR,
  SMOKE_COURSE_NAME,
  SMOKE_RESULT_MARKER,
  SMOKE_STORAGE_VALUE_ENV_VAR,
} from '../electron/smoke.ts';
import { PACKAGED_APP_ORIGIN } from '../electron/navigation.ts';

/**
 * 真实 Electron 启动冒烟测试（HANDOFF 13.1：不要再用"源码包含字符串"代替
 * 运行时验证）。直接启动编译产物或 Linux 打包产物，断言：
 *   1. sandbox preload 加载成功，window.yeyuDesktop 存在且方法面完整；
 *   2. getWorkspaceInfo() 能完成一次真实 IPC 往返；
 *   3. 固定工作区 Courses/Cache/Settings 被幂等创建；
 *   4. 通过真实桥接创建课程并写入 course.json 后，关闭应用重新启动，
 *      listCourses() 仍能扫出该课程（关闭重启恢复）。
 * 需要 DISPLAY（或 win32/darwin 桌面会话）；缺少显示环境时跳过并说明原因。
 * 本文件刻意不匹配 tests/*.test.ts：冒烟只由 `pnpm desktop:test` 运行。
 */

const require = createRequire(import.meta.url);

const LAUNCH_TIMEOUT_MS = 120000;

const EXPECTED_METHODS = [...DESKTOP_METHOD_NAMES].sort();

const COMPILED_MAIN_ENTRY = path.resolve('electron/dist/main.js');
const PACKAGED_LINUX_BINARY = path.resolve('out/Yeyu-linux-x64/yeyu');

interface LaunchResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function displaySessionAvailable(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return true;
  }
  return Boolean(process.env.DISPLAY);
}

function electronBinary(): string {
  return require('electron') as string;
}

const STATIC_RESULT_MARKER = 'YEYU_STATIC_SMOKE_RESULT';

interface StaticSmokeResult {
  cachePrimed: boolean;
  staleDocument: boolean;
  html: { status: number; cache: string | null };
  script: { status: number; cache: string | null; type: string | null };
  worker: { status: number; cache: string | null };
  missing: Array<{ status: number; cache: string | null; html: boolean }>;
  route: { status: number; cache: string | null };
  indexedBefore: string | null;
  indexedAfter: string | null;
  cookieBefore: string | null;
  cookieAfter: string | null;
}

/** Run the actual compiled main on a private, stable origin beside an open app. */
async function isolatedCompiledLaunch(root: string): Promise<{ entry: string; origin: string }> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const entry = path.join(root, 'launch.cjs');
  await writeFile(entry, String.raw`
const { app, BrowserWindow, session } = require('electron');
const { createServer } = require('node:http');
app.setPath('userData', process.env.YEYU_SMOKE_PROFILE);
const navigation = require(${JSON.stringify(path.join(path.dirname(COMPILED_MAIN_ENTRY), 'navigation.js'))});
navigation.PACKAGED_APP_ORIGIN = ${JSON.stringify(origin)};
navigation.PACKAGED_APP_PORT = ${address.port};
const primedReady = app.whenReady().then(async () => {
  let primingWindow;
  let cachePrimed = false;
  if (process.env.YEYU_SMOKE_HTTP_PROBE === '1') {
    const legacy = createServer((_request, response) => {
      response.setHeader('Cache-Control', 'public, max-age=31536000');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><body>obsolete-build-cache-marker</body>');
    });
    await new Promise(resolve => legacy.listen(navigation.PACKAGED_APP_PORT, '127.0.0.1', resolve));
    primingWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await primingWindow.loadURL(navigation.PACKAGED_APP_ORIGIN + '/');
    cachePrimed = (await session.defaultSession.getCacheSize()) > 0;
    await new Promise((resolve, reject) => legacy.close(error => error ? reject(error) : resolve()));
  }
  const originalLoad = BrowserWindow.prototype.loadURL;
  let inspected = false;
  BrowserWindow.prototype.loadURL = async function (...args) {
    const result = await originalLoad.apply(this, args);
    if (!inspected && process.env.YEYU_SMOKE_HTTP_PROBE === '1') {
      inspected = true;
      const probe = await this.webContents.executeJavaScript('(' + (async (value) => {
        const staleDocument = document.body.textContent.includes('obsolete-build-cache-marker');
        const get = async path => {
          const response = await fetch(path);
          return { status: response.status, cache: response.headers.get('cache-control'),
            type: response.headers.get('content-type'), text: await response.text() };
        };
        const html = await get('/');
        const scriptPath = /src="([^"]+\.js)"/.exec(html.text)?.[1];
        if (!scriptPath) throw new Error('current HTML must expose a real script asset');
        const script = await get(scriptPath);
        const worker = await get('/pdf.worker.min.mjs');
        const missing = [];
        for (const file of ['/_next/static/chunks/missing-old-build.js', '/missing.pdf', '/assets/missing-asset']) {
          const response = await get(file);
          missing.push({ status: response.status, cache: response.cache, html: /<!doctype|<html/i.test(response.text) });
        }
        const route = await get('/smoke-client-route');
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('yeyu-smoke-storage-preservation', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('settings');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const read = () => new Promise((resolve, reject) => {
          const request = db.transaction('settings').objectStore('settings').get('marker');
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => reject(request.error);
        });
        const cookie = () => document.cookie.split('; ').find(item => item.startsWith('yeyu-smoke-auth='))?.slice('yeyu-smoke-auth='.length) ?? null;
        const indexedBefore = await read();
        const cookieBefore = cookie();
        if (typeof value === 'string') {
          await new Promise((resolve, reject) => {
            const transaction = db.transaction('settings', 'readwrite');
            transaction.objectStore('settings').put(value, 'marker');
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
          });
          document.cookie = 'yeyu-smoke-auth=' + value + '; Path=/; Max-Age=3600; SameSite=Lax';
        }
        const indexedAfter = await read();
        db.close();
        return { staleDocument, html: {status:html.status,cache:html.cache},
          script: {status:script.status,cache:script.cache,type:script.type},
          worker: {status:worker.status,cache:worker.cache}, missing,
          route: {status:route.status,cache:route.cache}, indexedBefore, indexedAfter,
          cookieBefore, cookieAfter: cookie() };
      }).toString() + ')(' + JSON.stringify(process.env.YEYU_SMOKE_STORAGE_VALUE) + ')');
      await session.defaultSession.cookies.flushStore();
      process.stdout.write(${JSON.stringify(STATIC_RESULT_MARKER + ' ')} + JSON.stringify({ cachePrimed, ...probe }) + '\n');
      primingWindow?.destroy();
    }
    return result;
  };
}).catch(error => { console.error(error); app.exit(1); });
// Keep main's early Electron setup before ready, but populate the legacy cache
// before its real startup callback opens either renderer.
app.whenReady = () => primedReady;
require(${JSON.stringify(COMPILED_MAIN_ENTRY)});
`);
  return { entry, origin };
}

function launchEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    YEYU_SMOKE: '1',
    YEYU_WORKSPACE_ROOT: workspaceRoot,
  };
}

function launchElectron(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<LaunchResult> {
  // Electron 44 may hang during shutdown when a session exposes both Wayland
  // and X11 under the managed desktop runner. Prefer the available X11
  // backend for this real-process test; production startup remains unchanged.
  const launchArgs =
    process.platform === 'linux' && env.DISPLAY && env.WAYLAND_DISPLAY
      ? ['--ozone-platform=x11', ...args]
      : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, launchArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.removeAllListeners('close');
      child.kill('SIGKILL');
      reject(
        new Error(
          `Electron ${LAUNCH_TIMEOUT_MS}ms 内未退出。\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, LAUNCH_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

interface SmokeProbePayload {
  api: boolean;
  methods?: string[];
  workspace?: { root: string; coursesRoot: string };
  popupDenied?: boolean;
  createdCourse?: string;
  courses?: string[];
  origin?: string;
  storedBefore?: string | null;
  storedAfter?: string | null;
  backgroundRoleBlocked?: boolean;
  backgroundSnapshotValid?: boolean;
  courseLockRoundtrip?: boolean;
  buildMetadataValid?: boolean;
  dshHistoryValid?: boolean;
  restoreTokenRejected?: boolean;
  staticRuntime?: StaticSmokeResult;
  error?: string;
}

function parseSmokeResult(stdout: string): SmokeProbePayload {
  const markerLine = stdout
    .split('\n')
    .find((line) => line.startsWith(SMOKE_RESULT_MARKER));
  assert.ok(
    markerLine,
    `stdout 中没有 ${SMOKE_RESULT_MARKER} 标记行，应用可能没有启动成功。`,
  );
  return JSON.parse(
    markerLine.slice(SMOKE_RESULT_MARKER.length + 1),
  ) as SmokeProbePayload;
}

async function launchAndProbe(
  command: string,
  args: string[],
  workspaceRoot: string,
  createCourse: boolean,
  storageValue?: string,
  environment: Partial<NodeJS.ProcessEnv> = {},
  expectedOrigin = PACKAGED_APP_ORIGIN,
): Promise<SmokeProbePayload> {
  const env = { ...launchEnvironment(workspaceRoot), ...environment };
  if (createCourse) {
    env[SMOKE_CREATE_COURSE_ENV_VAR] = '1';
  }
  if (storageValue !== undefined) {
    env[SMOKE_STORAGE_VALUE_ENV_VAR] = storageValue;
  }
  let { code, stdout, stderr } = await launchElectron(command, args, env);
  if (
    !stdout.includes(SMOKE_RESULT_MARKER) &&
    /SUID sandbox|chrome-sandbox/i.test(stderr)
  ) {
    // 容器环境限制：无 root 的 SUID helper 且 user namespace 被禁用时，
    // Chromium 的 OS 级沙箱无法创建。此时仅对测试进程追加 --no-sandbox 重试；
    // 应用内 sandbox: true、contextIsolation 与导航隔离配置不变，全部断言照常执行。
    process.stderr.write(
      '[electron-smoke] OS 沙箱不可用（容器限制），改用 --no-sandbox 重试桥接冒烟。\n',
    );
    ({ code, stdout, stderr } = await launchElectron(
      command,
      [...args, '--no-sandbox'],
      env,
    ));
  }
  const result = parseSmokeResult(stdout);
  if (environment.YEYU_SMOKE_HTTP_PROBE === '1') {
    const marker = stdout.split('\n').find((line) => line.startsWith(STATIC_RESULT_MARKER + ' '));
    assert.ok(marker, `missing static runtime result: ${stderr}`);
    const probe = JSON.parse(marker.slice(STATIC_RESULT_MARKER.length + 1)) as StaticSmokeResult;
    assert.equal(probe.cachePrimed, true, 'legacy HTTP cache fixture must be populated');
    assert.equal(probe.staleDocument, false, 'startup must clear cached HTML from the previous build');
    for (const resource of [probe.html, probe.script, probe.worker, probe.route]) {
      assert.equal(resource.status, 200);
      assert.equal(resource.cache, 'no-store');
    }
    assert.match(probe.script.type ?? '', /javascript/);
    for (const missing of probe.missing) {
      assert.equal(missing.status, 404, 'missing assets must not receive the SPA shell');
      assert.equal(missing.cache, 'no-store');
      assert.equal(missing.html, false);
    }
    result.staticRuntime = probe;
  }
  assert.equal(
    result.api,
    true,
    `preload 桥接不可用：${result.error ?? '未知原因'}\nstderr:\n${stderr}`,
  );
  assert.deepEqual(result.methods, EXPECTED_METHODS);
  assert.equal(result.backgroundRoleBlocked, true, 'visible renderer cannot forge worker snapshots');
  assert.equal(result.backgroundSnapshotValid, true, 'background snapshot IPC returns explicit availability');
  assert.equal(result.courseLockRoundtrip, true, 'course transaction lock completes over actual preload IPC');
  assert.equal(result.buildMetadataValid, true, 'build metadata completes a real IPC roundtrip');
  assert.equal(result.dshHistoryValid, true, 'DSH history is available over the main window bridge');
  assert.equal(result.restoreTokenRejected, true, 'restore rejects a token without a native picker preview');
  assert.equal(
    result.popupDenied,
    true,
    'window.open 应被 setWindowOpenHandler 拒绝（返回 null）。',
  );
  assert.ok(result.workspace, 'getWorkspaceInfo() 没有返回工作区信息。');
  assert.equal(result.workspace.root, workspaceRoot);
  assert.equal(
    result.workspace.coursesRoot,
    path.join(workspaceRoot, 'Courses'),
  );
  assert.equal(
    code,
    0,
    `Electron 进程异常退出（${code}）。\nstderr:\n${stderr}`,
  );
  assert.deepEqual(
    (await readdir(workspaceRoot)).sort(),
    ['Cache', 'Courses', 'Settings'],
    '首次启动应幂等创建 Courses/Cache/Settings。',
  );
  assert.equal(result.origin, expectedOrigin);
  return result;
}

async function assertCourseLifecycle(
  command: string,
  args: string[],
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-smoke-'));
  const workspaceRoot = path.join(root, 'workspace');
  const profile = path.join(root, 'profile');
  await mkdir(profile);
  const isolated = args.includes(COMPILED_MAIN_ENTRY) ? await isolatedCompiledLaunch(root) : undefined;
  const launchArgs = isolated ? [isolated.entry] : args;
  const environment = { YEYU_SMOKE_PROFILE: profile, YEYU_DEV_URL: '',
    ...(isolated ? { YEYU_SMOKE_HTTP_PROBE: '1' } : {}) };
  const storageMarker = `saved-${path.basename(root)}`;
  try {
    // 第一次启动：通过真实桥接创建课程并写入 course.json。
    const created = await launchAndProbe(
      command,
      launchArgs,
      workspaceRoot,
      true,
      storageMarker,
      environment,
      isolated?.origin,
    );
    assert.equal(created.createdCourse, SMOKE_COURSE_NAME);
    assert.ok(created.courses?.includes(SMOKE_COURSE_NAME));
    assert.equal(created.storedAfter, storageMarker);
    if (isolated) {
      assert.equal(created.staticRuntime?.indexedBefore, null);
      assert.equal(created.staticRuntime?.indexedAfter, storageMarker);
      assert.equal(created.staticRuntime?.cookieAfter, storageMarker);
    }

    // 关闭应用后重新启动：课程必须从磁盘自动恢复。
    const restarted = await launchAndProbe(command, launchArgs, workspaceRoot, false, undefined, environment, isolated?.origin);
    assert.ok(
      restarted.courses?.includes(SMOKE_COURSE_NAME),
      `重启后应恢复课程，实际：${JSON.stringify(restarted.courses)}`,
    );
    assert.equal(restarted.createdCourse, undefined);
    assert.equal(
      restarted.storedBefore,
      storageMarker,
      '重启后应从同一 origin 恢复 localStorage 中的接口设置。',
    );
    if (isolated) {
      assert.equal(restarted.staticRuntime?.indexedBefore, storageMarker, 'HTTP cache clearing preserves IndexedDB');
      assert.equal(restarted.staticRuntime?.cookieBefore, storageMarker, 'HTTP cache clearing preserves authentication cookies');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const noDisplay = displaySessionAvailable()
  ? false
  : '当前环境没有 DISPLAY，无法启动真实 Electron；请在图形会话或配置 Xvfb 后运行 desktop:test。';
const missingCompiledEntry = existsSync(COMPILED_MAIN_ENTRY)
  ? false
  : '缺少 electron/dist/main.js；desktop:test 会先执行 desktop:compile，请通过 pnpm desktop:test 运行。';

void test(
  'compiled electron app exposes the yeyuDesktop bridge',
  { skip: noDisplay || missingCompiledEntry },
  async () => {
    await assertCourseLifecycle(electronBinary(), [COMPILED_MAIN_ENTRY]);
  },
);

const missingPackagedBinary = existsSync(PACKAGED_LINUX_BINARY)
  ? false
  : '尚未执行 pnpm desktop:build，没有 Linux 打包产物可验证。';

void test(
  'packaged linux app exposes the yeyuDesktop bridge',
  { skip: noDisplay || missingPackagedBinary },
  async () => {
    await assertCourseLifecycle(PACKAGED_LINUX_BINARY, []);
  },
);

void test('real hidden background host survives UI reload, persists controls, and bounds crash recovery',
  { skip: noDisplay || missingCompiledEntry, timeout: LAUNCH_TIMEOUT_MS }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-background-smoke-'));
    const profile = path.join(root, 'profile');
    await mkdir(profile);
    try {
      const isolated = await isolatedCompiledLaunch(root);
      const env = {...launchEnvironment(path.join(root, 'workspace')), YEYU_DEV_URL:'', YEYU_SMOKE_BACKGROUND:'1', YEYU_SMOKE_PROFILE:profile};
      let result = await launchElectron(electronBinary(), [isolated.entry], env);
      if (!result.stdout.includes('YEYU_BACKGROUND_SMOKE_RESULT') && /SUID sandbox|chrome-sandbox/i.test(result.stderr))
        result = await launchElectron(electronBinary(), [isolated.entry, '--no-sandbox'], env);
      const line = result.stdout.split('\n').find(value => value.startsWith('YEYU_BACKGROUND_SMOKE_RESULT '));
      assert.ok(line, `missing background smoke result: ${result.stderr}`);
      const probe = JSON.parse(line.slice('YEYU_BACKGROUND_SMOKE_RESULT '.length));
      assert.equal(probe.ok, true, probe.error);
      assert.equal(result.code, 0, result.stderr);
      for (const key of ['registered','hidden','roleBlocked','pausePersisted','survivesUiReload','cancellationPersisted','boundedRestart','closed']) assert.equal(probe[key], true, key);
      assert.equal(probe.recovered, 3);
    } finally { await rm(root, {recursive:true,force:true}); }
  },
);
