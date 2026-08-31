import { contextBridge, ipcRenderer } from 'electron';

import { DESKTOP_CHANNELS, type YeyuDesktopApi } from './api.ts';

const api: YeyuDesktopApi = {
  getWorkspaceInfo: () => ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceInfo),
  listCourses: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listCourses),
  createCourseDirectory: (name) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.createCourse, name),
  deleteCourseDirectory: (name) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.deleteCourse, name),
  exists: (courseDirectory, relativePath) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.exists, courseDirectory, relativePath),
  ensureDirectory: (courseDirectory, relativePath) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.ensureDirectory,
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
  revealWorkspace: () => ipcRenderer.invoke(DESKTOP_CHANNELS.revealWorkspace),
};

// 只暴露白名单方法；ipcRenderer、fs 和路径解析都不会出现在 window 上。
contextBridge.exposeInMainWorld('yeyuDesktop', api);
