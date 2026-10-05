import { contextBridge, ipcRenderer } from 'electron';

import {
  DESKTOP_CHANNELS,
  type YeyuDesktopApi,
  type YeyuMcpCommand,
  type YeyuMcpResponse,
} from './api.ts';

const api: YeyuDesktopApi = {
  getBuildInfo: () => ipcRenderer.invoke(DESKTOP_CHANNELS.buildInfo),
  getDshHistory: () => ipcRenderer.invoke(DESKTOP_CHANNELS.dshHistory),
  exportCourseBackup: directory => ipcRenderer.invoke(DESKTOP_CHANNELS.courseBackupExport,directory),
  prepareCourseRestore: () => ipcRenderer.invoke(DESKTOP_CHANNELS.courseRestorePrepare),
  restoreCourseBackup: token => ipcRenderer.invoke(DESKTOP_CHANNELS.courseRestore,token),
  inspectDshRuntime: () => ipcRenderer.invoke(DESKTOP_CHANNELS.dshInspect),
  acquireCourseLock: directory => ipcRenderer.invoke(DESKTOP_CHANNELS.courseLockAcquire, directory),
  releaseCourseLock: token => ipcRenderer.invoke(DESKTOP_CHANNELS.courseLockRelease, token),
  getBackgroundSnapshot: () => ipcRenderer.invoke(DESKTOP_CHANNELS.backgroundGet),
  publishBackgroundSnapshot: snapshot => ipcRenderer.invoke(DESKTOP_CHANNELS.backgroundPublish, snapshot),
  controlBackgroundTask: action => ipcRenderer.invoke(DESKTOP_CHANNELS.backgroundControl, action),
  wakeBackgroundTasks: () => ipcRenderer.invoke(DESKTOP_CHANNELS.backgroundWake),
  onCoursesChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: { directoryName: string }) => listener(value);
    ipcRenderer.on(DESKTOP_CHANNELS.coursesChanged, handler);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.coursesChanged, handler);
  },
  onBackgroundSnapshot: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('./background-types.ts').BackgroundSnapshot) => listener(value);
    ipcRenderer.on(DESKTOP_CHANNELS.backgroundSnapshot, handler);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.backgroundSnapshot, handler);
  },
  onBackgroundCommand: handler => {
    const listener = (_event: Electron.IpcRendererEvent, command: import('./background-types.ts').BackgroundCommand) => {
      void Promise.resolve().then(() => handler(command)).then(
        () => ipcRenderer.invoke(DESKTOP_CHANNELS.backgroundResponse, { id: command.id }),
        () => ipcRenderer.invoke(DESKTOP_CHANNELS.backgroundResponse, { id: command.id, error: '后台操作未完成。' }),
      ).catch(() => undefined);
    };
    ipcRenderer.on(DESKTOP_CHANNELS.backgroundCommand, listener);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.backgroundCommand, listener);
  },
  runDsh: request => ipcRenderer.invoke(DESKTOP_CHANNELS.dshRun, request),
  cancelDsh: requestId => ipcRenderer.invoke(DESKTOP_CHANNELS.dshCancel, requestId),
  onDshProgress: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('./dsh-types.ts').DshProgress) => listener(value);
    ipcRenderer.on(DESKTOP_CHANNELS.dshProgress, handler);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.dshProgress, handler);
  },
  getWorkspaceInfo: () => ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceInfo),
  listCourses: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listCourses),
  createCourseDirectory: (name) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.createCourse, name),
  exists: (courseDirectory, relativePath) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.exists, courseDirectory, relativePath),
  ensureDirectory: (courseDirectory, relativePath) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.ensureDirectory,
      courseDirectory,
      relativePath,
    ),
  listFiles: (courseDirectory, relativePath) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.listFiles,
      courseDirectory,
      relativePath,
    ),
  readFile: (courseDirectory, relativePath) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.readFile,
      courseDirectory,
      relativePath,
    ),
  writeFile: (courseDirectory, relativePath, data) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.writeFile,
      courseDirectory,
      relativePath,
      data,
    ),
  deleteFile: (courseDirectory, relativePath) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.deleteFile,
      courseDirectory,
      relativePath,
    ),
  deleteCourseDirectory: (courseDirectory) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.deleteCourse, courseDirectory),
  revealWorkspace: () => ipcRenderer.invoke(DESKTOP_CHANNELS.revealWorkspace),
  getLanShareStatus: () => ipcRenderer.invoke(DESKTOP_CHANNELS.lanShareStatus),
  startLanShare: (password, port, permissions) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.lanShareStart,
      password,
      port,
      permissions,
    ),
  stopLanShare: () => ipcRenderer.invoke(DESKTOP_CHANNELS.lanShareStop),
  getReadingState: (courseId, documentId) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.readingStateGet, courseId, documentId),
  saveReadingState: (courseId, documentId, value) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.readingStatePut,
      courseId,
      documentId,
      value,
    ),
  onMcpCommand: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const command = value as YeyuMcpCommand;
      void Promise.resolve()
        .then(() => handler(command))
        .then(
          (result) => {
            const response: YeyuMcpResponse = {
              id: command.id,
              ok: true,
              result,
            };
            void ipcRenderer
              .invoke(DESKTOP_CHANNELS.mcpResponse, response)
              .catch(() => undefined);
          },
          (error: unknown) => {
            const response: YeyuMcpResponse = {
              id: command.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
            void ipcRenderer
              .invoke(DESKTOP_CHANNELS.mcpResponse, response)
              .catch(() => undefined);
          },
        );
    };
    ipcRenderer.on(DESKTOP_CHANNELS.mcpCommand, listener);
    return () =>
      ipcRenderer.removeListener(DESKTOP_CHANNELS.mcpCommand, listener);
  },
};

// 只暴露白名单方法；ipcRenderer、fs 和路径解析都不会出现在 window 上。
contextBridge.exposeInMainWorld('yeyuDesktop', api);
