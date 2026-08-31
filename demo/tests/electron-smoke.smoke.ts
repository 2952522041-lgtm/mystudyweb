import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { DESKTOP_METHOD_NAMES } from '../electron/api.ts';
import { SMOKE_RESULT_MARKER } from '../electron/smoke.ts';

/**
 * 真实 Electron 启动冒烟测试（HANDOFF 13.1：不要再用"源码包含字符串"代替
 * 运行时验证）。直接启动编译产物或 Linux 打包产物，断言：
 *   1. sandbox preload 加载成功，window.yeyuDesktop 存在且方法面完整；
 *   2. getWorkspaceInfo() 能完成一次真实 IPC 往返；
 *   3. 固定工作区 Courses/Cache/Settings 被幂等创建。
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
  return { ...process.env, YEYU_SMOKE: '1', YEYU_WORKSPACE_ROOT: workspaceRoot };
}

function launchElectron(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return JSON.parse(markerLine.slice(SMOKE_RESULT_MARKER.length + 1)) as SmokeProbePayload;
}

async function assertDesktopBridgeLaunch(
  command: string,
  args: string[],
): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'yeyu-smoke-'));
  try {
    const { code, stdout, stderr } = await launchElectron(
      command,
      args,
      launchEnvironment(workspaceRoot),
    );
    const result = parseSmokeResult(stdout);
    assert.equal(
      result.api,
      true,
      `preload 桥接不可用：${result.error ?? '未知原因'}\nstderr:\n${stderr}`,
    );
    assert.deepEqual(result.methods, EXPECTED_METHODS);
    assert.ok(result.workspace, 'getWorkspaceInfo() 没有返回工作区信息。');
    assert.equal(result.workspace.root, workspaceRoot);
    assert.equal(
      result.workspace.coursesRoot,
      path.join(workspaceRoot, 'Courses'),
    );
    assert.equal(code, 0, `Electron 进程异常退出（${code}）。\nstderr:\n${stderr}`);
    assert.deepEqual(
      (await readdir(workspaceRoot)).sort(),
      ['Cache', 'Courses', 'Settings'],
      '首次启动应幂等创建 Courses/Cache/Settings。',
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
    await assertDesktopBridgeLaunch(electronBinary(), [COMPILED_MAIN_ENTRY]);
  },
);

const missingPackagedBinary = existsSync(PACKAGED_LINUX_BINARY)
  ? false
  : '尚未执行 pnpm desktop:build，没有 Linux 打包产物可验证。';

void test(
  'packaged linux app exposes the yeyuDesktop bridge',
  { skip: noDisplay || missingPackagedBinary },
  async () => {
    await assertDesktopBridgeLaunch(PACKAGED_LINUX_BINARY, []);
  },
);
