import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  DESKTOP_CHANNELS,
  type WorkspaceInfo,
} from './api.ts';
import {
  createCourseDirectory,
  courseFileExists,
  ensureCourseDirectory,
  ensureWorkspace,
  readCourseFile,
  scanCourses,
  writeCourseFile,
} from './workspace.ts';
import {
  resolveWorkspaceLayout,
  WorkspacePathError,
  type WorkspaceLayout,
} from './workspace-paths.ts';

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
    // 只监听本机回环地址的随机端口，不暴露工作区，也不对外提供服务。
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address ? address.port : undefined;
      if (!port) {
        reject(new Error('本地静态服务器未能获得端口。'));
        return;
      }
      resolve(`http://127.0.0.1:${port}/`);
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

function registerDesktopIpc(layout: WorkspaceLayout): void {
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
  ipcMain.handle(DESKTOP_CHANNELS.exists, async (_event, courseDirectory, relativePath) => {
    try {
      return await courseFileExists(
        layout.coursesRoot,
        assertString(courseDirectory, '课程目录名不合法。'),
        Array.isArray(relativePath) ? relativePath : [],
      );
    } catch (error) {
      throw toIpcError(error);
    }
  });
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
  ipcMain.handle(DESKTOP_CHANNELS.readFile, async (_event, courseDirectory, relativePath) => {
    try {
      return await readCourseFile(
        layout.coursesRoot,
        assertString(courseDirectory, '课程目录名不合法。'),
        Array.isArray(relativePath) ? relativePath : [],
      );
    } catch (error) {
      throw toIpcError(error);
    }
  });
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
  ipcMain.handle(DESKTOP_CHANNELS.revealWorkspace, async () => {
    await ensureWorkspace(layout);
    const failure = await shell.openPath(layout.root);
    if (failure) throw new Error(failure);
  });
}

async function createWindow(): Promise<void> {
  // YEYU_DEV_URL 只指向本机开发服务器；产品代码没有任何线上地址。
  const devUrl = process.env.YEYU_DEV_URL?.trim();
  const target = devUrl || (await startStaticServer(staticClientDirectory()));
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
  window.once('ready-to-show', () => window.show());
  await window.loadURL(target);
}

void app.whenReady().then(async () => {
  const layout = resolveWorkspaceLayout(
    app.getPath('documents'),
    process.env.YEYU_WORKSPACE_ROOT,
  );
  await ensureWorkspace(layout);
  registerDesktopIpc(layout);
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
