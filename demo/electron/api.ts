/**
 * 课程清单的最小结构，必须与 lib/course-storage/types.ts 的 CourseManifest
 * 保持一致（demo 全量 tsc 会在桌面存储的使用处校验两者兼容）。
 * 不直接跨目录 import，是为了让 Electron 编译产物完全自包含。
 */
export interface DesktopCourseManifest {
  schemaVersion: number;
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  activeKnowledgeVersion: number;
  documents: unknown[];
}

/** preload 挂到 window 上的白名单 API 名称。 */
export const DESKTOP_API_NAME = 'yeyuDesktop';

export const DESKTOP_CHANNELS = {
  workspaceInfo: 'yeyu:workspace-info',
  listCourses: 'yeyu:list-courses',
  createCourse: 'yeyu:create-course',
  deleteCourse: 'yeyu:delete-course',
  exists: 'yeyu:exists',
  ensureDirectory: 'yeyu:ensure-directory',
  readFile: 'yeyu:read-file',
  writeFile: 'yeyu:write-file',
  revealWorkspace: 'yeyu:reveal-workspace',
} as const;

export interface WorkspaceInfo {
  root: string;
  coursesRoot: string;
}

export interface DesktopCourseSummary {
  directoryName: string;
  manifest: DesktopCourseManifest;
}

/** 主进程暴露给 renderer 的唯一文件入口；绝不暴露 ipcRenderer 或 fs 本身。 */
export interface YeyuDesktopApi {
  getWorkspaceInfo(): Promise<WorkspaceInfo>;
  listCourses(): Promise<DesktopCourseSummary[]>;
  createCourseDirectory(name: string): Promise<{ directoryName: string }>;
  /** 把整个课程目录移入系统回收站；删除的是 Courses 下经过校验的课程子目录。 */
  deleteCourseDirectory(name: string): Promise<void>;
  exists(
    courseDirectory: string,
    relativePath: string[],
  ): Promise<boolean>;
  ensureDirectory(
    courseDirectory: string,
    relativePath: string[],
  ): Promise<void>;
  readFile(
    courseDirectory: string,
    relativePath: string[],
  ): Promise<Uint8Array>;
  writeFile(
    courseDirectory: string,
    relativePath: string[],
    data: Uint8Array,
  ): Promise<void>;
  revealWorkspace(): Promise<void>;
}
