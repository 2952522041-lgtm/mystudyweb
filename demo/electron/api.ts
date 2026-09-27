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
  mcpCommand: 'yeyu:mcp-command',
  mcpResponse: 'yeyu:mcp-response',
} as const;

export type YeyuMcpCommandName =
  | 'get_state'
  | 'show_courses'
  | 'open_course'
  | 'open_document'
  | 'import_pdf'
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
  'revealWorkspace',
  'startLanShare',
  'stopLanShare',
  'writeFile',
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

/** 主进程暴露给 renderer 的唯一文件入口；绝不暴露 ipcRenderer 或 fs 本身。 */
export interface YeyuDesktopApi {
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
  startLanShare?(password: string, port: number): Promise<LanShareStatus>;
  stopLanShare?(): Promise<void>;
  /**
   * 接收 Electron 主进程转发的本机 MCP 命令。preload 只把结构化命令交给
   * renderer，并把处理结果回传；不会向页面暴露端口、令牌或 ipcRenderer。
  */
  onMcpCommand?(
    handler: (command: YeyuMcpCommand) => unknown,
  ): () => void;
}
