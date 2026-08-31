/**
 * 真实 Electron 启动冒烟测试。
 *
 * 不再用“源码包含字符串”代替运行时验证：本测试直接启动 electron 主进程，
 * 通过 YEYU_DEV_URL 指向本测试的本地 harness 页面，在真实 renderer 里
 * 验证 preload 暴露的 window.yeyuDesktop 可用、getWorkspaceInfo() 能完成
 * IPC 往返、工作区（Courses/Cache/Settings）真实落盘，并额外验证课程创建。
 *
 * Linux CI 无显示服务器时自动跳过（设 YEYU_ELECTRON_SMOKE=1 可强制执行）。
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import http from 'node:http';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const demoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const electronDist = path.join(demoRoot, 'electron', 'dist');
const smokeSkipReason =
  process.platform === 'linux' && process.env.YEYU_ELECTRON_SMOKE !== '1'
    ? 'Linux 无显示服务器，跳过真实 Electron 启动（设 YEYU_ELECTRON_SMOKE=1 强制执行）'
    : false;

function terminateElectron(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
  } else {
    child.kill('SIGTERM');
  }
}

/** 编译主进程/preload 并把 preload 打包成单文件 CommonJS；产物缺失或源码更新时执行。 */
async function compileElectronIfNeeded(): Promise<void> {
  const sources = [
    'main.ts',
    'preload.ts',
    'api.ts',
    'workspace.ts',
    'workspace-paths.ts',
  ].map((name) => path.join(demoRoot, 'electron', name));
  const newestSource = Math.max(
    ...await Promise.all(sources.map(async (file) => (await stat(file)).mtimeMs)),
  );
  const compiled = await stat(path.join(electronDist, 'preload.js')).catch(() => null);
  if (compiled && compiled.mtimeMs > newestSource) return;

  await execFileAsync(
    process.execPath,
    [path.join(demoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'electron/tsconfig.json'],
    { cwd: demoRoot },
  );
  await execFileAsync(process.execPath, ['scripts/write-electron-commonjs.mjs'], { cwd: demoRoot });
  await execFileAsync(process.execPath, ['scripts/bundle-preload.mjs'], { cwd: demoRoot });
}

/**
 * 启动一次真实 Electron：harness 页面调用桌面 API 后把结果 POST 回来。
 * 返回 renderer 报告；Electron 进程在报告到达后由本函数负责结束。
 */
function launchElectron(options: {
  workspaceRoot?: string;
  timeoutMs?: number;
}): Promise<{ report: Record<string, unknown>; stderr: string }> {
  const { workspaceRoot, timeoutMs = 60_000 } = options;
  const electronBinary = require('electron') as string;
  assert.equal(typeof electronBinary, 'string', 'electron 包应导出二进制路径');

  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (request.url?.startsWith('/page')) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><meta charset="utf-8"><title>yeyu smoke</title><script>
(async () => {
  const result = {};
  try {
    if (!window.yeyuDesktop) throw new Error('window.yeyuDesktop 不存在');
    result.hasDesktopApi = true;
    result.apiNames = Object.keys(window.yeyuDesktop).sort();
    const info = await window.yeyuDesktop.getWorkspaceInfo();
    result.workspaceRoot = info.root;
    result.coursesRoot = info.coursesRoot;
    const created = await window.yeyuDesktop.createCourseDirectory('冒烟课程');
    result.createdCourse = created.directoryName;
    const courses = await window.yeyuDesktop.listCourses();
    result.courses = courses.map((course) => course.directoryName);
    result.error = null;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  await fetch('/report', { method: 'POST', body: JSON.stringify(result) });
})();
</script>`);
        return;
      }
      if (request.url?.startsWith('/report')) {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          response.end('ok');
          resolve({ report: JSON.parse(body), stderr: stderrOutput });
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    let stderrOutput = '';
    let child: ReturnType<typeof spawn> | null = null;
    let timer: NodeJS.Timeout | null = null;
    const stop = () => {
      if (timer) clearTimeout(timer);
      server.closeAllConnections?.();
      server.close(() => undefined);
      if (child) terminateElectron(child);
    };

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        YEYU_DEV_URL: `http://127.0.0.1:${port}/page`,
      };
      if (workspaceRoot) {
        env.YEYU_WORKSPACE_ROOT = workspaceRoot;
      } else {
        delete env.YEYU_WORKSPACE_ROOT;
      }
      child = spawn(electronBinary, ['.'], {
        cwd: demoRoot,
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });
      timer = setTimeout(() => {
        stop();
        reject(new Error(`Electron 冒烟测试超时（${timeoutMs}ms）。\nstderr:\n${stderrOutput}`));
      }, timeoutMs);
      child.once('exit', (code) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
          reject(new Error(`Electron 提前退出，退出码 ${code}。\nstderr:\n${stderrOutput}`));
        }
      });
    });
  });
}

void test('compiled preload is a single self-contained CommonJS bundle', async () => {
  await compileElectronIfNeeded();
  const compiled = await readFile(path.join(electronDist, 'preload.js'), 'utf8');
  // 沙箱 preload 禁止加载本地模块；打包后唯一允许的 require 是 electron。
  assert.doesNotMatch(compiled, /require\(["']\.\.?\//);
  assert.match(compiled, /exposeInMainWorld/);
});

void test(
  'real electron start exposes yeyuDesktop and creates the fixed workspace',
  { skip: smokeSkipReason },
  async () => {
    const tempRoot = path.join(os.tmpdir(), `yeyu-smoke-${Date.now()}`);
    try {
      const { report } = await launchElectron({ workspaceRoot: tempRoot });
      assert.equal(report.error, null, `renderer 报错：${JSON.stringify(report)}`);
      assert.equal(report.hasDesktopApi, true);
      const workspaceRoot = String(report.workspaceRoot);
      assert.equal(workspaceRoot, path.resolve(tempRoot));
      const entries = (await readdir(workspaceRoot)).sort();
      assert.deepEqual(entries, ['Cache', 'Courses', 'Settings']);
      const createdCourse = path.join(
        workspaceRoot,
        'Courses',
        String(report.createdCourse),
      );
      assert.ok(
        await stat(createdCourse).then(
          () => true,
          () => false,
        ),
        `通过 IPC 创建的课程目录应真实存在：${createdCourse}`,
      );
    } finally {
      await rmQuiet(tempRoot);
    }
  },
);

void test(
  'real electron start without override creates Documents/页语工作区',
  { skip: smokeSkipReason },
  async () => {
    const { report } = await launchElectron({});
    assert.equal(report.error, null, `renderer 报错：${JSON.stringify(report)}`);
    const workspaceRoot = String(report.workspaceRoot);
    // 主进程用 app.getPath('documents') 计算默认根；harness 页面回报真实路径，
    // 这里只断言它是“文档”目录下固定名称的工作区。
    assert.equal(path.basename(workspaceRoot), '页语工作区');
    const entries = (await readdir(workspaceRoot)).sort();
    assert.deepEqual(entries, ['Cache', 'Courses', 'Settings']);
  },
);

async function rmQuiet(target: string): Promise<void> {
  await import('node:fs/promises').then((fs) =>
    fs.rm(target, { recursive: true, force: true }),
  );
}
