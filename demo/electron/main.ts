import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { DESKTOP_CHANNELS, type WorkspaceInfo } from './api.ts';
import {
  createCourseDirectory,
  courseFileExists,
  deleteCourseEntry,
  ensureCourseDirectory,
  ensureWorkspace,
  readCourseFile,
  removeCourseDirectory,
  resolveCourseDirectoryPath,
  scanCourses,
  writeCourseFile,
} from './workspace.ts';
import {
  resolveWorkspaceLayout,
  WorkspacePathError,
  type WorkspaceLayout,
} from './workspace-paths.ts';
import {
  externalHttpUrl,
  isAppOrigin,
  PACKAGED_APP_ORIGIN,
  PACKAGED_APP_PORT,
  resolveDevTargetUrl,
} from './navigation.ts';
import { isSmokeRun, probePreloadBridge } from './smoke.ts';
import { handleSquirrelStartup } from './squirrel.ts';
import { LanShareServer } from './lan-share.ts';

// Windows Squirrel 安装/更新/卸载事件必须在最早期处理（HANDOFF 13.2）。
if (handleSquirrelStartup()) {
  app.quit();
}

// 冒烟测试在无 GPU/显示器的环境下也要能启动，禁用硬件加速只影响该模式。
if (isSmokeRun()) {
  app.disableHardwareAcceleration();
}

/**
 * 本地静态服务器（或开发服务器）启动后得到的唯一应用 origin；
 * 主窗口的所有导航检查都以它为准。
 */
let appOrigin = '';

/** 外部 http/https 交给系统浏览器；其他协议保持拒绝。 */
function openExternalIfHttp(url: string): void {
  const external = externalHttpUrl(url);
  if (external) {
    shell.openExternal(external).catch(() => undefined);
  }
}

/**
 * 导航隔离（HANDOFF 13.3）：主窗口永远停在应用 origin 上，preload 暴露的
 * 文件桥接不会泄露给其他页面；外部链接在系统浏览器打开；弹窗默认拒绝。
 */
function applyNavigationGuards(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url, appOrigin)) return;
    event.preventDefault();
    openExternalIfHttp(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppOrigin(url, appOrigin)) {
      openExternalIfHttp(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.rsc': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/**
 * 只服务打包进应用的 dist/client 静态产物；
 * 桌面端永远不加载线上 URL，离线也能进入应用。
 */
function staticClientDirectory(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'client');
  }
  return path.join(__dirname, '..', '..', 'dist', 'client');
}

function startStaticServer(clientDirectory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const requested = decodeURIComponent(url.pathname);
        const resolved = path.resolve(clientDirectory, `.${requested}`);
        if (
          resolved !== clientDirectory &&
          !resolved.startsWith(clientDirectory + path.sep)
        ) {
          response.statusCode = 403;
          response.end();
          return;
        }
        let filePath = resolved;
        let stat = await fs.stat(filePath).catch(() => null);
        if (stat?.isDirectory()) {
          filePath = path.join(filePath, 'index.html');
          stat = await fs.stat(filePath).catch(() => null);
        }
        if (!stat) {
          filePath = path.join(clientDirectory, 'index.html');
          stat = await fs.stat(filePath).catch(() => null);
        }
        if (!stat) {
          response.statusCode = 404;
          response.end('Not found');
          return;
        }
        response.statusCode = 200;
        response.setHeader(
          'Content-Type',
          MIME_TYPES[path.extname(filePath).toLowerCase()] ??
            'application/octet-stream',
        );
        response.end(await fs.readFile(filePath));
      } catch {
        response.statusCode = 500;
        response.end();
      }
    });
    server.once('error', reject);
    // 固定回环 origin 让 localStorage / IndexedDB 跨启动保留。单实例锁避免
    // 第二个页语进程与此端口竞争；端口被其他程序占用时直接启动失败。
    server.listen(PACKAGED_APP_PORT, '127.0.0.1', () => {
      resolve(`${PACKAGED_APP_ORIGIN}/`);
    });
  });
}

function toIpcError(error: unknown): Error {
  if (error instanceof WorkspacePathError) {
    return new Error(`[YEYU-${error.code}] ${error.message}`);
  }
  return error instanceof Error ? error : new Error('桌面文件操作失败。');
}

function assertString(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw toIpcError(new WorkspacePathError('INVALID_NAME', message));
  }
  return value;
}

function registerDesktopIpc(
  layout: WorkspaceLayout,
  lanShareServer: LanShareServer,
): void {
  ipcMain.handle(
    DESKTOP_CHANNELS.workspaceInfo,
    async (): Promise<WorkspaceInfo> => {
      await ensureWorkspace(layout);
      return { root: layout.root, coursesRoot: layout.coursesRoot };
    },
  );
  ipcMain.handle(DESKTOP_CHANNELS.listCourses, async () => {
    await ensureWorkspace(layout);
    return scanCourses(layout.coursesRoot);
  });
  ipcMain.handle(DESKTOP_CHANNELS.createCourse, async (_event, name) => {
    assertString(name, '课程名称不合法。');
    await ensureWorkspace(layout);
    try {
      return await createCourseDirectory(layout.coursesRoot, name);
    } catch (error) {
      throw toIpcError(error);
    }
  });
  ipcMain.handle(
    DESKTOP_CHANNELS.exists,
    async (_event, courseDirectory, relativePath) => {
      try {
        return await courseFileExists(
          layout.coursesRoot,
          assertString(courseDirectory, '课程目录名不合法。'),
          Array.isArray(relativePath) ? relativePath : [],
        );
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.ensureDirectory,
    async (_event, courseDirectory, relativePath) => {
      try {
        await ensureCourseDirectory(
          layout.coursesRoot,
          assertString(courseDirectory, '课程目录名不合法。'),
          Array.isArray(relativePath) ? relativePath : [],
        );
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.readFile,
    async (_event, courseDirectory, relativePath) => {
      try {
        return await readCourseFile(
          layout.coursesRoot,
          assertString(courseDirectory, '课程目录名不合法。'),
          Array.isArray(relativePath) ? relativePath : [],
        );
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.writeFile,
    async (_event, courseDirectory, relativePath, data) => {
      if (!(data instanceof Uint8Array)) {
        throw toIpcError(
          new WorkspacePathError('INVALID_NAME', '写入内容必须是二进制数据。'),
        );
      }
      try {
        await writeCourseFile(
          layout.coursesRoot,
          assertString(courseDirectory, '课程目录名不合法。'),
          Array.isArray(relativePath) ? relativePath : [],
          data,
        );
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.deleteFile,
    async (_event, courseDirectory, relativePath) => {
      try {
        await deleteCourseEntry(
          layout.coursesRoot,
          assertString(courseDirectory, '课程目录名不合法。'),
          Array.isArray(relativePath) ? relativePath : [],
        );
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.deleteCourse,
    async (_event, courseDirectory) => {
      const name = assertString(courseDirectory, '课程目录名不合法。');
      try {
        const target = await resolveCourseDirectoryPath(
          layout.coursesRoot,
          name,
        );
        try {
          // 先移入系统回收站，误删可以从回收站恢复；无回收站环境退回直接删除。
          await shell.trashItem(target);
        } catch {
          await removeCourseDirectory(layout.coursesRoot, name);
        }
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  ipcMain.handle(DESKTOP_CHANNELS.revealWorkspace, async () => {
    await ensureWorkspace(layout);
    const failure = await shell.openPath(layout.root);
    if (failure) throw new Error(failure);
  });
  ipcMain.handle(DESKTOP_CHANNELS.lanShareStatus, () =>
    lanShareServer.getStatus(),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.lanShareStart,
    async (_event, password, port) => {
      if (typeof password !== 'string' || typeof port !== 'number') {
        throw new Error('局域网共享参数不合法。');
      }
      return lanShareServer.start(password, port);
    },
  );
  ipcMain.handle(DESKTOP_CHANNELS.lanShareStop, () => lanShareServer.stop());
}

async function createWindow(): Promise<BrowserWindow> {
  // YEYU_DEV_URL 只指向本机开发服务器且仅在未打包时生效；产品代码没有任何线上地址。
  const devDecision = resolveDevTargetUrl(
    process.env.YEYU_DEV_URL,
    app.isPackaged,
  );
  if (devDecision.warning) {
    console.warn(`[页语] ${devDecision.warning}`);
  }
  const target =
    devDecision.url ?? (await startStaticServer(staticClientDirectory()));
  appOrigin = new URL(target).origin;
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    show: false,
    title: '页语',
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyNavigationGuards(window);
  if (!isSmokeRun()) {
    window.once('ready-to-show', () => window.show());
  }
  await window.loadURL(target);
  return window;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  void app
    .whenReady()
    .then(async () => {
      const layout = resolveWorkspaceLayout(
        app.getPath('documents'),
        process.env.YEYU_WORKSPACE_ROOT,
      );
      const lanShareServer = new LanShareServer(
        layout,
        staticClientDirectory(),
      );
      await ensureWorkspace(layout);
      registerDesktopIpc(layout, lanShareServer);
      app.on('before-quit', () => {
        void lanShareServer.stop();
      });
      const window = await createWindow();
      if (isSmokeRun()) {
        // YEYU_SMOKE=1：探测完 preload 桥接后立即退出，供自动化冒烟测试断言。
        const result = await probePreloadBridge(window);
        window.webContents.session.flushStorageData();
        process.exitCode = result.api ? 0 : 1;
        app.quit();
        return;
      }
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          void createWindow();
        }
      });
    })
    .catch((error: unknown) => {
      console.error('[页语] 启动失败：', error);
      app.exit(1);
    });
}

app.on('window-all-closed', () => {
  app.quit();
});
