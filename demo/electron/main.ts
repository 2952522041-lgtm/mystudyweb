import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  DESKTOP_CHANNELS,
  type WorkspaceInfo,
  type YeyuMcpCommand,
  type YeyuMcpCommandName,
  type YeyuMcpResponse,
} from './api.ts';
import {
  createCourseDirectory,
  courseFileExists,
  deleteCourseEntry,
  ensureCourseDirectory,
  ensureWorkspace,
  listCourseFiles,
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
import { probeBackgroundHost, BACKGROUND_SMOKE_MARKER } from './background-smoke.ts';
import { handleSquirrelStartup } from './squirrel.ts';
import { LanShareServer } from './lan-share.ts';
import {
  ReadingStateConflictError,
  ReadingStateStore,
} from './reading-state-store.ts';
import { McpControlServer, type McpControlRequest } from './mcp-control.ts';
import { prepareMcpRendererArgs } from './mcp-import.ts';
import { DshDispatcher } from './dsh-dispatcher.ts';
import { inspectDshRuntime } from './dsh-runtime.ts';
import { BackgroundService, assertDesktopRole } from './background-service.ts';
import { CourseLocks } from './course-locks.ts';
import { validReaderView, readerViewFields } from './reader-view-state.ts';

const dshManager = new DshDispatcher(path.join(__dirname, 'dsh-worker.mjs'));

// Windows Squirrel 安装/更新/卸载事件必须在最早期处理（HANDOFF 13.2）。
if (handleSquirrelStartup()) {
  app.quit();
}

// 冒烟测试在无 GPU/显示器的环境下也要能启动，禁用硬件加速只影响该模式。
if (isSmokeRun()) {
  app.disableHardwareAcceleration();
  if (process.env.YEYU_SMOKE_PROFILE) app.setPath('userData', process.env.YEYU_SMOKE_PROFILE);
}

/**
 * 本地静态服务器（或开发服务器）启动后得到的唯一应用 origin；
 * 主窗口的所有导航检查都以它为准。
 */
let appOrigin = '';
let appTarget: string | undefined;
let mainWindow: BrowserWindow | undefined;
let backgroundWindow: BrowserWindow | undefined;
let quitting = false;
const courseLocks = new CourseLocks();
let backgroundService: BackgroundService;

function releaseRendererOwner(owner: number) {
  dshManager.cancelOwner(owner);
  courseLocks.releaseOwner(owner);
  backgroundService?.cancelOwner(owner);
}
function broadcastCoursesChanged(directoryName: string) {
  for (const window of [mainWindow, backgroundWindow])
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      try { window.webContents.send(DESKTOP_CHANNELS.coursesChanged, { directoryName }); } catch { /* renderer disappeared during notification */ }
    }
}
function trustedSender(event: Electron.IpcMainInvokeEvent, role: 'main' | 'worker' | 'either' = 'either') {
  assertDesktopRole({ owner: event.sender.id, mainFrame: event.senderFrame === event.sender.mainFrame, sameOrigin: Boolean(event.senderFrame && isAppOrigin(event.senderFrame.url, appOrigin)) },
    { main: mainWindow?.webContents.id, worker: backgroundService?.owner }, role);
}

const MCP_RENDERER_TIMEOUT_MS = 15_000;
const MCP_AI_TIMEOUT_MS = 30 * 60_000;
const MCP_COMMAND_NAMES = new Set<YeyuMcpCommandName>([
  'get_state',
  'show_courses',
  'open_course',
  'open_document',
  'import_pdf',
  'translate_page',
  'ask_document',
  'get_conversation',
  'clear_conversation',
  'create_course',
  'regenerate_document',
  'regenerate_course',
  'remove_document',
  'remove_course',
  'get_glossary',
  'save_glossary',
  'cancel_shared_action',
  'go_to_page',
  'set_reader_panel',
]);

interface PendingMcpCommand {
  window: BrowserWindow;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Connect the authenticated loopback endpoint to the isolated renderer. */
function createMcpRendererBridge(): {
  dispatch: (request: McpControlRequest) => Promise<unknown>;
  dispatchPrepared: (request: McpControlRequest) => Promise<unknown>;
  dispose: () => void;
} {
  const pending = new Map<string, PendingMcpCommand>();
  const onResponse = (
    event: Electron.IpcMainInvokeEvent,
    response: YeyuMcpResponse,
  ) => {
    if (!response || typeof response.id !== 'string') return;
    const entry = pending.get(response.id);
    if (!entry || event.sender !== entry.window.webContents) return;
    trustedSender(event, 'main');
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new Error(response.error));
  };
  ipcMain.handle(DESKTOP_CHANNELS.mcpResponse, onResponse);

  const sendToRenderer = async (
    request: McpControlRequest,
    args: Record<string, unknown>,
    focusWindow: boolean,
  ): Promise<unknown> => {
    if (!MCP_COMMAND_NAMES.has(request.name)) {
      return Promise.reject(new Error(`不支持的页语命令：${request.name}`));
    }
    const window = mainWindow;
    if (!window || window.isDestroyed()) {
      return Promise.reject(new Error('页语窗口尚未就绪。'));
    }
    if (focusWindow && request.name !== 'get_state') {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    const id = randomUUID();
    const command: YeyuMcpCommand = {
      id,
      name: request.name,
      args,
    };
    return new Promise((resolve, reject) => {
      const timeout =
        request.name === 'import_pdf' ||
        request.name === 'translate_page' ||
        request.name === 'ask_document' ||
        request.name === 'regenerate_document' ||
        request.name === 'regenerate_course'
          ? MCP_AI_TIMEOUT_MS
          : MCP_RENDERER_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            request.name === 'import_pdf'
              ? '页语未在 30 分钟内完成 PDF 导入。'
              : timeout === MCP_AI_TIMEOUT_MS
                ? '页语未在 30 分钟内完成 AI 任务。'
                : '页语界面未在 15 秒内响应 MCP 命令。',
          ),
        );
      }, timeout);
      pending.set(id, { window, resolve, reject, timer });
      window.webContents.send(DESKTOP_CHANNELS.mcpCommand, command);
    });
  };

  return {
    dispatch: async (request) => {
      const args = await prepareMcpRendererArgs(request.name, request.args);
      return sendToRenderer(request, args, true);
    },
    dispatchPrepared: (request) => sendToRenderer(request, request.args, false),
    dispose: () => {
      ipcMain.removeHandler(DESKTOP_CHANNELS.mcpResponse);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('页语正在退出。'));
      }
      pending.clear();
    },
  };
}

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
  readingStateStore: ReadingStateStore,
): void {
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1], role: 'main' | 'worker' | 'either' = 'either') => {
    ipcMain.handle(channel, (event, ...args) => { trustedSender(event, role); return listener(event, ...args); });
  };
  handle(DESKTOP_CHANNELS.dshInspect, () => inspectDshRuntime());
  handle(DESKTOP_CHANNELS.courseLockAcquire, async (event, directory) => {
    const name = assertString(directory, '课程目录名不合法。');
    await resolveCourseDirectoryPath(layout.coursesRoot, name);
    trustedSender(event);
    return courseLocks.acquire(event.sender.id, name);
  });
  handle(DESKTOP_CHANNELS.courseLockRelease, (event, token) => courseLocks.release(event.sender.id, assertString(token, '课程锁无效。')));
  handle(DESKTOP_CHANNELS.backgroundGet, () => backgroundService.getSnapshot(), 'main');
  handle(DESKTOP_CHANNELS.backgroundPublish, (event, value) => backgroundService.publish(event.sender.id, value), 'worker');
  handle(DESKTOP_CHANNELS.backgroundControl, (event, value) => backgroundService.control(event.sender.id, value), 'main');
  handle(DESKTOP_CHANNELS.backgroundResponse, (event, value) => backgroundService.respond(event.sender.id, value), 'worker');
  handle(DESKTOP_CHANNELS.backgroundWake, () => broadcastCoursesChanged(''), 'main');
  handle(DESKTOP_CHANNELS.dshRun, (event, request) => {
    return dshManager.run(event.sender.id, request, progress => {
      if (!event.sender.isDestroyed()) event.sender.send(DESKTOP_CHANNELS.dshProgress, progress);
    });
  });
  handle(DESKTOP_CHANNELS.dshCancel, (event, requestId) => {
    if(typeof requestId === 'string') dshManager.cancel(event.sender.id, requestId);
  });
  handle(
    DESKTOP_CHANNELS.workspaceInfo,
    async (): Promise<WorkspaceInfo> => {
      await ensureWorkspace(layout);
      return { root: layout.root, coursesRoot: layout.coursesRoot };
    },
  );
  handle(DESKTOP_CHANNELS.listCourses, async () => {
    await ensureWorkspace(layout);
    return scanCourses(layout.coursesRoot);
  });
  handle(DESKTOP_CHANNELS.createCourse, async (_event, name) => {
    assertString(name, '课程名称不合法。');
    await ensureWorkspace(layout);
    try {
      const created = await createCourseDirectory(layout.coursesRoot, name);
      broadcastCoursesChanged(created.directoryName);
      return created;
    } catch (error) {
      throw toIpcError(error);
    }
  });
  handle(
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
  handle(
    DESKTOP_CHANNELS.ensureDirectory,
    async (_event, courseDirectory, relativePath) => {
      try {
        await courseLocks.run(_event.sender.id, assertString(courseDirectory, '课程目录名不合法。'), () => ensureCourseDirectory(
          layout.coursesRoot,
          assertString(courseDirectory, '课程目录名不合法。'),
          Array.isArray(relativePath) ? relativePath : [],
        ));
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  handle(
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
  handle(
    DESKTOP_CHANNELS.listFiles,
    async (_event, courseDirectory, relativePath) => {
      try {
        return await listCourseFiles(
          layout.coursesRoot,
          assertString(courseDirectory, '课程目录名不合法。'),
          Array.isArray(relativePath) ? relativePath : [],
        );
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  handle(
    DESKTOP_CHANNELS.writeFile,
    async (_event, courseDirectory, relativePath, data) => {
      if (!(data instanceof Uint8Array)) {
        throw toIpcError(
          new WorkspacePathError('INVALID_NAME', '写入内容必须是二进制数据。'),
        );
      }
      try {
        await courseLocks.run(_event.sender.id, assertString(courseDirectory, '课程目录名不合法。'), () => writeCourseFile(
          layout.coursesRoot,
          assertString(courseDirectory, '课程目录名不合法。'),
          Array.isArray(relativePath) ? relativePath : [],
          data,
        ));
        if (Array.isArray(relativePath) && relativePath.length === 1 && relativePath[0] === 'course.json') broadcastCoursesChanged(courseDirectory);
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  handle(
    DESKTOP_CHANNELS.deleteFile,
    async (_event, courseDirectory, relativePath) => {
      try {
        await courseLocks.run(_event.sender.id, assertString(courseDirectory, '课程目录名不合法。'), () => deleteCourseEntry(
          layout.coursesRoot,
          assertString(courseDirectory, '课程目录名不合法。'),
          Array.isArray(relativePath) ? relativePath : [],
        ));
        if (Array.isArray(relativePath) && relativePath.length === 1 && relativePath[0] === 'course.json') broadcastCoursesChanged(courseDirectory);
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  handle(
    DESKTOP_CHANNELS.deleteCourse,
    async (_event, courseDirectory) => {
      const name = assertString(courseDirectory, '课程目录名不合法。');
      try {
        await courseLocks.run(_event.sender.id, name, async () => {
          const target = await resolveCourseDirectoryPath(layout.coursesRoot, name);
          try {
          // 先移入系统回收站，误删可以从回收站恢复；无回收站环境退回直接删除。
          await shell.trashItem(target);
        } catch {
          await removeCourseDirectory(layout.coursesRoot, name);
          }
        });
        broadcastCoursesChanged(name);
      } catch (error) {
        throw toIpcError(error);
      }
    },
  );
  handle(DESKTOP_CHANNELS.revealWorkspace, async () => {
    await ensureWorkspace(layout);
    const failure = await shell.openPath(layout.root);
    if (failure) throw new Error(failure);
  }, 'main');
  handle(DESKTOP_CHANNELS.lanShareStatus, () =>
    lanShareServer.getStatus(),
    'main',
  );
  handle(
    DESKTOP_CHANNELS.lanShareStart,
    async (_event, password, port, permissions) => {
      if (typeof password !== 'string' || typeof port !== 'number') {
        throw new Error('局域网共享参数不合法。');
      }
      return lanShareServer.start(password, port, permissions);
    },
    'main',
  );
  handle(DESKTOP_CHANNELS.lanShareStop, () => lanShareServer.stop(), 'main');
  const findReadingDocument = async (
    courseIdValue: unknown,
    documentIdValue: unknown,
  ): Promise<{ courseId: string; documentId: string; pageCount: number }> => {
    const courseId = assertString(courseIdValue, '课程 ID 不合法。');
    const documentId = assertString(documentIdValue, 'PDF ID 不合法。');
    const course = (await scanCourses(layout.coursesRoot)).find(
      (item) => item.manifest.id === courseId,
    );
    const document = course?.manifest.documents.find(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>).id === documentId,
    );
    const pageCount = document?.pageCount;
    if (
      !course ||
      !document ||
      !Number.isInteger(pageCount) ||
      (pageCount as number) < 1
    ) {
      throw new Error('课程或 PDF 不存在，可能已被删除。');
    }
    return { courseId, documentId, pageCount: pageCount as number };
  };
  handle(
    DESKTOP_CHANNELS.readingStateGet,
    async (_event, courseIdValue, documentIdValue) => {
      const target = await findReadingDocument(courseIdValue, documentIdValue);
      return readingStateStore.get(target.courseId, target.documentId);
    },
  );
  handle(
    DESKTOP_CHANNELS.readingStatePut,
    async (_event, courseIdValue, documentIdValue, value) => {
      const target = await findReadingDocument(courseIdValue, documentIdValue);
      if (
        typeof value !== 'object' ||
        value === null ||
        !validReaderView(value as unknown) ||
        !Number.isInteger(value.page) ||
        value.page < 1 ||
        value.page > target.pageCount ||
        !Number.isInteger(value.zoom) ||
        value.zoom < 50 ||
        value.zoom > 200 ||
        !Number.isInteger(value.expectedVersion) ||
        value.expectedVersion < 0
      ) {
        throw new Error('页码、缩放比例或阅读进度版本不合法。');
      }
      try {
        return await readingStateStore.put(target.courseId, target.documentId, {
          page: value.page,
          zoom: value.zoom,
          expectedVersion: value.expectedVersion,
          ...readerViewFields(value),
        });
      } catch (error) {
        if (error instanceof ReadingStateConflictError) {
          throw new Error(`[YEYU-READING-STATE-CONFLICT] ${error.message}`);
        }
        throw error;
      }
    },
  );
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
  const target = appTarget ??= devDecision.url ?? (await startStaticServer(staticClientDirectory()));
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
  mainWindow = window;
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined; if (!quitting) app.quit(); });
  applyNavigationGuards(window);
  const dshOwner = window.webContents.id;
  window.webContents.on('destroyed', () => releaseRendererOwner(dshOwner));
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) releaseRendererOwner(dshOwner);
  });
  if (!isSmokeRun()) {
    window.once('ready-to-show', () => window.show());
  }
  await window.loadURL(target);
  return window;
}

function createBackgroundService() {
  return new BackgroundService({
    create: onFailure => {
      if (!appTarget) throw new Error('应用地址尚未就绪。');
      const target = new URL(appTarget);
      target.searchParams.set('background-worker', '1');
      const window = new BrowserWindow({ show: false, title: '页语后台任务',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      });
      backgroundWindow = window;
      applyNavigationGuards(window);
      const owner = window.webContents.id;
      let loaded = false;
      window.webContents.on('did-finish-load', () => { loaded = true; });
      window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) { releaseRendererOwner(owner); if (loaded) onFailure(owner); }
      });
      window.webContents.on('render-process-gone', () => onFailure(owner));
      window.webContents.on('destroyed', () => { releaseRendererOwner(owner); onFailure(owner); });
      window.on('closed', () => { if (backgroundWindow === window) backgroundWindow = undefined; onFailure(owner); });
      return { owner, load: () => window.loadURL(target.href),
        send: command => { if (window.isDestroyed()) throw new Error('后台窗口已关闭。'); window.webContents.send(DESKTOP_CHANNELS.backgroundCommand, command); },
        destroy: () => { if (!window.isDestroyed()) window.destroy(); },
      };
    },
    broadcast: snapshot => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      try { mainWindow.webContents.send(DESKTOP_CHANNELS.backgroundSnapshot, snapshot); } catch { /* disappearing UI cannot stop executor cleanup */ }
    } },
    releaseOwner: releaseRendererOwner,
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = mainWindow;
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
      const readingStateStore = new ReadingStateStore(layout.settingsRoot);
      const mcpBridge = createMcpRendererBridge();
      const lanShareServer = new LanShareServer(
        layout,
        staticClientDirectory(),
        {
          readingStateStore,
          importPdf: (request) =>
            mcpBridge.dispatchPrepared({
              name: 'import_pdf',
              args: {
                courseId: request.courseId,
                fileName: request.fileName,
                fileData: request.fileData,
                fileLastModified: request.fileLastModified,
                generateSummary: request.generateSummary,
                generateMindmap: request.generateMindmap,
                mergeIntoCourse: request.mergeIntoCourse,
              },
            }),
          action: async (request) => {
            const sharedTaskId = randomUUID();
            const cancel = () => {
              void mcpBridge
                .dispatchPrepared({
                  name: 'cancel_shared_action',
                  args: { sharedTaskId },
                })
                .catch(() => undefined);
            };
            request.signal?.addEventListener('abort', cancel, { once: true });
            try {
              return await mcpBridge.dispatchPrepared({
                name: request.name,
                args: { ...request.args, sharedTaskId },
              });
            } finally {
              request.signal?.removeEventListener('abort', cancel);
            }
          },
        },
      );
      const mcpControlServer = new McpControlServer({
        settingsRoot: layout.settingsRoot,
        dispatch: mcpBridge.dispatch,
      });
      await ensureWorkspace(layout);
      backgroundService = createBackgroundService();
      registerDesktopIpc(layout, lanShareServer, readingStateStore);
      let dshClosed = false;
      app.on('before-quit', event => {
        if (dshClosed) return;
        event.preventDefault();
        if (quitting) return;
        quitting = true;
        backgroundService.close();
        const closingLocks = courseLocks.close();
        mcpBridge.dispose();
        void Promise.allSettled([closingLocks, dshManager.close(), lanShareServer.stop(), mcpControlServer.stop()]).finally(() => { dshClosed = true; app.quit(); });
      });
      const window = await createWindow();
      if (isSmokeRun() && process.env.YEYU_SMOKE_BACKGROUND === '1') {
        try {
          const result = await probeBackgroundHost(window, backgroundService, () => backgroundWindow, layout);
          process.stdout.write(`${BACKGROUND_SMOKE_MARKER} ${JSON.stringify(result)}\n`);
        } catch (error) {
          process.stdout.write(`${BACKGROUND_SMOKE_MARKER} ${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '后台冒烟失败。' })}\n`);
          process.exitCode = 1;
        }
        app.quit();
        return;
      }
      if (!quitting) backgroundService.start();
      if (isSmokeRun()) {
        // YEYU_SMOKE=1：探测完 preload 桥接后立即退出，供自动化冒烟测试断言。
        const result = await probePreloadBridge(window);
        window.webContents.session.flushStorageData();
        process.exitCode = result.api ? 0 : 1;
        app.quit();
        return;
      }
      await mcpControlServer.start();
      app.on('activate', () => {
        if (quitting) return;
        if (!mainWindow || mainWindow.isDestroyed()) void createWindow();
        else { mainWindow.show(); mainWindow.focus(); }
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
