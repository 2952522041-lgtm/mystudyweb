import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
): Promise<SmokeProbePayload> {
  const env = launchEnvironment(workspaceRoot);
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
  assert.equal(result.origin, PACKAGED_APP_ORIGIN);
  return result;
}

async function assertCourseLifecycle(
  command: string,
  args: string[],
): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'yeyu-smoke-'));
  const storageMarker = `saved-${path.basename(workspaceRoot)}`;
  try {
    // 第一次启动：通过真实桥接创建课程并写入 course.json。
    const created = await launchAndProbe(
      command,
      args,
      workspaceRoot,
      true,
      storageMarker,
    );
    assert.equal(created.createdCourse, SMOKE_COURSE_NAME);
    assert.ok(created.courses?.includes(SMOKE_COURSE_NAME));
    assert.equal(created.storedAfter, storageMarker);

    // 关闭应用后重新启动：课程必须从磁盘自动恢复。
    const restarted = await launchAndProbe(command, args, workspaceRoot, false);
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
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
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
      const env = {...launchEnvironment(path.join(root, 'workspace')), YEYU_DEV_URL:'', YEYU_SMOKE_BACKGROUND:'1', YEYU_SMOKE_PROFILE:profile};
      let result = await launchElectron(electronBinary(), [COMPILED_MAIN_ENTRY], env);
      if (!result.stdout.includes('YEYU_BACKGROUND_SMOKE_RESULT') && /SUID sandbox|chrome-sandbox/i.test(result.stderr))
        result = await launchElectron(electronBinary(), [COMPILED_MAIN_ENTRY, '--no-sandbox'], env);
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
