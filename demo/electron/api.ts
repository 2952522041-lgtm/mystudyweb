/**
 * 课程清单的最小结构，必须与 lib/course-storage/types.ts 的 CourseManifest
 * 保持一致（demo 全量 tsc 会在桌面存储的使用处校验两者兼容）。
 * 不直接跨目录 import，是为了让 Electron 编译产物完全自包含。
 */
import type { DshCompletionRequest, DshCompletionResult, DshProgress, DshRuntimeStatus } from './dsh-types.ts';

import type { BackgroundAction, BackgroundCommand, BackgroundSnapshot } from './background-types.ts';
import type { ReaderViewState } from './reader-view-state.ts';
export type { ReaderViewState } from './reader-view-state.ts';

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
  exists: 'yeyu:exists',
  ensureDirectory: 'yeyu:ensure-directory',
  listFiles: 'yeyu:list-files',
  readFile: 'yeyu:read-file',
  writeFile: 'yeyu:write-file',
  deleteFile: 'yeyu:delete-file',
  deleteCourse: 'yeyu:delete-course',
  revealWorkspace: 'yeyu:reveal-workspace',
  lanShareStatus: 'yeyu:lan-share-status',
  lanShareStart: 'yeyu:lan-share-start',
  lanShareStop: 'yeyu:lan-share-stop',
  readingStateGet: 'yeyu:reading-state-get',
  readingStatePut: 'yeyu:reading-state-put',
  mcpCommand: 'yeyu:mcp-command',
  mcpResponse: 'yeyu:mcp-response',
  dshRun: 'yeyu:dsh-run',
  dshCancel: 'yeyu:dsh-cancel',
  dshProgress: 'yeyu:dsh-progress',
  dshInspect: 'yeyu:dsh-inspect',
  courseLockAcquire: 'yeyu:course-lock-acquire',
  courseLockRelease: 'yeyu:course-lock-release',
  coursesChanged: 'yeyu:courses-changed',
  backgroundGet: 'yeyu:background-get',
  backgroundPublish: 'yeyu:background-publish',
  backgroundSnapshot: 'yeyu:background-snapshot',
  backgroundControl: 'yeyu:background-control',
  backgroundCommand: 'yeyu:background-command',
  backgroundResponse: 'yeyu:background-response',
  backgroundWake: 'yeyu:background-wake',
} as const;

export type YeyuMcpCommandName =
  | 'get_state'
  | 'show_courses'
  | 'open_course'
  | 'open_document'
  | 'import_pdf'
  | 'translate_page'
  | 'ask_document'
  | 'get_conversation'
  | 'clear_conversation'
  | 'create_course'
  | 'regenerate_document'
  | 'regenerate_course'
  | 'remove_document'
  | 'remove_course'
  | 'get_glossary'
  | 'save_glossary'
  | 'cancel_shared_action'
  | 'go_to_page'
  | 'set_reader_panel';

export interface YeyuMcpCommand {
  id: string;
  name: YeyuMcpCommandName;
  args: Record<string, unknown>;
}

export type YeyuMcpResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

/** 桌面 API 的全部方法名；冒烟测试用它校验 preload 的暴露面。 */
export const DESKTOP_METHOD_NAMES = [
  'createCourseDirectory',
  'deleteCourseDirectory',
  'deleteFile',
  'ensureDirectory',
  'exists',
  'getWorkspaceInfo',
  'getLanShareStatus',
  'listFiles',
  'listCourses',
  'onMcpCommand',
  'readFile',
  'getReadingState',
  'saveReadingState',
  'revealWorkspace',
  'startLanShare',
  'stopLanShare',
  'writeFile',
  'runDsh',
  'cancelDsh',
  'onDshProgress',
  'inspectDshRuntime',
  'acquireCourseLock',
  'releaseCourseLock',
  'onCoursesChanged',
  'getBackgroundSnapshot',
  'publishBackgroundSnapshot',
  'onBackgroundSnapshot',
  'controlBackgroundTask',
  'onBackgroundCommand',
  'wakeBackgroundTasks',
] as const;

export interface WorkspaceInfo {
  root: string;
  coursesRoot: string;
}

export interface DesktopCourseSummary {
  directoryName: string;
  manifest: DesktopCourseManifest;
}

export interface LanShareStatus {
  running: boolean;
  port: number | null;
  addresses: string[];
}

export interface LanSharePermissions {
  importPdf: boolean;
  ai: boolean;
  manage: boolean;
}

export interface SharedReadingState extends ReaderViewState {
  page: number;
  zoom: number;
  version: number;
  updatedAt: string;
}

/** 主进程暴露给 renderer 的唯一文件入口；绝不暴露 ipcRenderer 或 fs 本身。 */
export interface YeyuDesktopApi {
  inspectDshRuntime?(): Promise<DshRuntimeStatus>;
  acquireCourseLock?(directory: string): Promise<string>;
  releaseCourseLock?(token: string): Promise<void>;
  onCoursesChanged?(listener: (value: { directoryName: string }) => void): () => void;
  getBackgroundSnapshot?(): Promise<BackgroundSnapshot>;
  publishBackgroundSnapshot?(snapshot: BackgroundSnapshot): Promise<void>;
  onBackgroundSnapshot?(listener: (snapshot: BackgroundSnapshot) => void): () => void;
  controlBackgroundTask?(action: BackgroundAction): Promise<void>;
  onBackgroundCommand?(handler: (command: BackgroundCommand) => Promise<void>): () => void;
  wakeBackgroundTasks?(): Promise<void>;
  runDsh?(request: DshCompletionRequest): Promise<DshCompletionResult>;
  cancelDsh?(requestId: string): Promise<void>;
  onDshProgress?(listener: (value: DshProgress) => void): () => void;
  getWorkspaceInfo(): Promise<WorkspaceInfo>;
  listCourses(): Promise<DesktopCourseSummary[]>;
  createCourseDirectory(name: string): Promise<{ directoryName: string }>;
  exists(courseDirectory: string, relativePath: string[]): Promise<boolean>;
  ensureDirectory(
    courseDirectory: string,
    relativePath: string[],
  ): Promise<void>;
  /** 列出课程内固定目录的普通文件名，不跟随符号链接。 */
  listFiles?(
    courseDirectory: string,
    relativePath: string[],
  ): Promise<string[]>;
  readFile(
    courseDirectory: string,
    relativePath: string[],
  ): Promise<Uint8Array>;
  writeFile(
    courseDirectory: string,
    relativePath: string[],
    data: Uint8Array,
  ): Promise<void>;
  /** 删除课程内的单个文件或成果目录（目录递归）；路径为空时拒绝。 */
  deleteFile(courseDirectory: string, relativePath: string[]): Promise<void>;
  /** 删除整门课程目录：主进程优先移入系统回收站，失败时退回直接删除。 */
  deleteCourseDirectory(directoryName: string): Promise<void>;
  revealWorkspace(): Promise<void>;
  getLanShareStatus?(): Promise<LanShareStatus>;
  startLanShare?(
    password: string,
    port: number,
    permissions?: LanSharePermissions,
  ): Promise<LanShareStatus>;
  stopLanShare?(): Promise<void>;
  getReadingState?(
    courseId: string,
    documentId: string,
  ): Promise<SharedReadingState | null>;
  saveReadingState?(
    courseId: string,
    documentId: string,
    value: { page: number; zoom: number; expectedVersion: number } & ReaderViewState,
  ): Promise<SharedReadingState>;
  /**
   * 接收 Electron 主进程转发的本机 MCP 命令。preload 只把结构化命令交给
   * renderer，并把处理结果回传；不会向页面暴露端口、令牌或 ipcRenderer。
  */
  onMcpCommand?(
    handler: (command: YeyuMcpCommand) => unknown,
  ): () => void;
}
