import path from 'node:path';

/** 固定工作区默认挂在系统"文档"目录下；不要把任何具体用户路径写进产品。 */
export const WORKSPACE_FOLDER_NAME = '页语工作区';

export type WorkspaceErrorCode =
  | 'INVALID_NAME'
  | 'PATH_ESCAPE'
  | 'COURSE_NOT_FOUND'
  | 'COURSE_DATA';

export class WorkspacePathError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkspacePathError';
    this.code = code;
  }
}

export interface WorkspaceLayout {
  root: string;
  coursesRoot: string;
  cacheRoot: string;
  settingsRoot: string;
}

/**
 * 计算固定工作区布局。默认位置是 `Documents/页语工作区`；
 * `YEYU_WORKSPACE_ROOT` 只供开发/测试覆盖，由主进程读取，renderer 永远传不进来。
 */
export function resolveWorkspaceLayout(
  documentsDir: string,
  workspaceRootOverride?: string,
): WorkspaceLayout {
  const override = workspaceRootOverride?.trim();
  const root = override
    ? path.resolve(override)
    : path.join(path.resolve(documentsDir), WORKSPACE_FOLDER_NAME);
  return {
    root,
    coursesRoot: path.join(root, 'Courses'),
    cacheRoot: path.join(root, 'Cache'),
    settingsRoot: path.join(root, 'Settings'),
  };
}

const INVALID_DIRECTORY_CHARACTERS = /[<>:"/\\|?*]/g;
const MAX_DIRECTORY_NAME_LENGTH = 100;

/** 与 lib/course-storage/file-utils.ts 的 sanitizeFileName 同等强度，外加目录名规则。 */
export function sanitizeCourseDirectoryName(name: string): string {
  const withoutControlCharacters = Array.from(name)
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('');
  const clean = withoutControlCharacters
    .replace(INVALID_DIRECTORY_CHARACTERS, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!clean || clean === '.' || clean === '..') {
    return '未命名课程';
  }
  return clean.slice(0, MAX_DIRECTORY_NAME_LENGTH);
}

/** 重名课程目录追加 `-2`、`-3` 后缀，保证每次创建都落到新目录。 */
export function uniqueCourseDirectoryName(
  existingNames: Iterable<string>,
  baseName: string,
): string {
  const taken = new Set(existingNames);
  if (!taken.has(baseName)) return baseName;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseName}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * 校验 renderer 传来的相对路径段。拒绝空段、`.`/`..`、路径分隔符、
 * 盘符号、NUL 和过长段；任何逃逸尝试都必须在进入文件系统前被拦下。
 */
export function assertSafeRelativeSegments(
  segments: readonly unknown[],
): string[] {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new WorkspacePathError('PATH_ESCAPE', '文件路径不能为空。');
  }
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.length === 0) {
      throw new WorkspacePathError('PATH_ESCAPE', '文件路径包含空段。');
    }
    if (segment === '.' || segment === '..') {
      throw new WorkspacePathError('PATH_ESCAPE', '文件路径不允许相对跳转。');
    }
    if (
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes(':') ||
      segment.includes('\0')
    ) {
      throw new WorkspacePathError('PATH_ESCAPE', '文件路径包含非法字符。');
    }
    if (segment.length > 255) {
      throw new WorkspacePathError('PATH_ESCAPE', '文件路径单段过长。');
    }
  }
  return [...segments] as string[];
}
