import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DesktopCourseSummary } from './api.ts';
import {
  assertSafeRelativeSegments,
  sanitizeCourseDirectoryName,
  uniqueCourseDirectoryName,
  WorkspacePathError,
  type WorkspaceLayout,
} from './workspace-paths.ts';

/**
 * 与 lib/course-storage/types.ts 的 CourseManifest 保持结构一致；
 * 桌面端只校验必要字段，字段兼容性由 demo 全量 tsc 在使用处保证。
 */
function assertManifest(value: unknown): DesktopCourseSummary['manifest'] {
  if (typeof value !== 'object' || value === null) {
    throw new WorkspacePathError(
      'COURSE_DATA',
      '课程目录中的 course.json 格式不受支持或已损坏。',
    );
  }
  const manifest = value as DesktopCourseSummary['manifest'];
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.id !== 'string' ||
    typeof manifest.name !== 'string' ||
    typeof manifest.revision !== 'number' ||
    !Array.isArray(manifest.documents)
  ) {
    throw new WorkspacePathError(
      'COURSE_DATA',
      '课程目录中的 course.json 格式不受支持或已损坏。',
    );
  }
  return manifest;
}

/** 首次启动幂等创建 Courses/Cache/Settings；重复调用是安全的。 */
export async function ensureWorkspace(layout: WorkspaceLayout): Promise<void> {
  await Promise.all(
    [layout.coursesRoot, layout.cacheRoot, layout.settingsRoot].map(
      (directory) => fs.mkdir(directory, { recursive: true }),
    ),
  );
}

/** 扫描 Courses 下每个课程目录里的 course.json；没有合法清单的目录不算课程，直接跳过。 */
export async function scanCourses(
  coursesRoot: string,
): Promise<DesktopCourseSummary[]> {
  let entries;
  try {
    entries = await fs.readdir(coursesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const courses: DesktopCourseSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(
        path.join(coursesRoot, entry.name, 'course.json'),
        'utf8',
      );
      courses.push({
        directoryName: entry.name,
        manifest: assertManifest(JSON.parse(raw)),
      });
    } catch {
      // 没有 course.json 或清单损坏的目录保持沉默，课程列表宁可少列不可报错。
    }
  }
  courses.sort((a, b) =>
    a.directoryName.localeCompare(b.directoryName, 'zh-Hans-CN'),
  );
  return courses;
}

export async function createCourseDirectory(
  coursesRoot: string,
  name: string,
): Promise<{ directoryName: string }> {
  const existing = await fs
    .readdir(coursesRoot)
    .catch(() => [] as string[]);
  const directoryName = uniqueCourseDirectoryName(
    existing,
    sanitizeCourseDirectoryName(name),
  );
  await fs.mkdir(path.join(coursesRoot, directoryName));
  return { directoryName };
}

/**
 * 校验“待删除课程目录”并返回其绝对路径。
 * 只允许 Courses 根的直接子目录，且必须真实存在、是目录、不是符号链接；
 * 真正的删除（回收站）由主进程用返回路径执行。
 */
export async function resolveDeletableCourseDirectory(
  coursesRoot: string,
  directoryName: string,
): Promise<string> {
  const clean = assertKnownCourseDirectory(directoryName);
  const coursesRootResolved = path.resolve(coursesRoot);
  const target = path.resolve(coursesRootResolved, clean);
  if (
    target !== coursesRootResolved &&
    !target.startsWith(coursesRootResolved + path.sep)
  ) {
    throw new WorkspacePathError('PATH_ESCAPE', '课程目录越出了工作区边界。');
  }
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new WorkspacePathError(
      'COURSE_NOT_FOUND',
      '课程目录不存在或不是目录。',
    );
  }
  return target;
}

function assertKnownCourseDirectory(directoryName: string): string {
  const clean = sanitizeCourseDirectoryName(directoryName);
  if (clean !== directoryName) {
    throw new WorkspacePathError('INVALID_NAME', '课程目录名不合法。');
  }
  return clean;
}

/**
 * 把课程内相对路径解析为绝对路径。课程目录本身和沿途每一段都做 lstat，
 * 只要出现符号链接就按路径逃逸拒绝，保证永远无法通过链接写出工作区。
 */
async function resolveCourseEntryPath(
  coursesRoot: string,
  directoryName: string,
  relativePath: readonly unknown[],
): Promise<string> {
  const segments = assertSafeRelativeSegments(relativePath);
  const clean = assertKnownCourseDirectory(directoryName);
  const courseRoot = path.join(coursesRoot, clean);
  const rootStat = await fs.lstat(courseRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new WorkspacePathError('COURSE_NOT_FOUND', '课程目录不存在。');
  }
  let current = courseRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new WorkspacePathError(
        'PATH_ESCAPE',
        '文件路径包含符号链接，已拒绝访问。',
      );
    }
  }
  const target = path.join(current, segments.at(-1)!);
  const targetStat = await fs.lstat(target).catch(() => null);
  if (targetStat?.isSymbolicLink()) {
    throw new WorkspacePathError(
      'PATH_ESCAPE',
      '文件路径包含符号链接，已拒绝访问。',
    );
  }
  return target;
}

export async function courseFileExists(
  coursesRoot: string,
  directoryName: string,
  relativePath: string[],
): Promise<boolean> {
  const target = await resolveCourseEntryPath(
    coursesRoot,
    directoryName,
    relativePath,
  );
  try {
    const stat = await fs.lstat(target);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

export async function ensureCourseDirectory(
  coursesRoot: string,
  directoryName: string,
  relativePath: string[],
): Promise<void> {
  const target = await resolveCourseEntryPath(
    coursesRoot,
    directoryName,
    relativePath,
  );
  await fs.mkdir(target, { recursive: true });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) {
    throw new WorkspacePathError('PATH_ESCAPE', '目标路径不是目录。');
  }
}

export async function readCourseFile(
  coursesRoot: string,
  directoryName: string,
  relativePath: string[],
): Promise<Uint8Array> {
  const target = await resolveCourseEntryPath(
    coursesRoot,
    directoryName,
    relativePath,
  );
  return new Uint8Array(await fs.readFile(target));
}

/** 写入采用"临时文件 → rename"，断电不会留下半个 course.json。 */
export async function writeCourseFile(
  coursesRoot: string,
  directoryName: string,
  relativePath: string[],
  data: Uint8Array,
): Promise<void> {
  const target = await resolveCourseEntryPath(
    coursesRoot,
    directoryName,
    relativePath,
  );
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.yeyu-tmp-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await fs.writeFile(temporary, data);
  try {
    await fs.rename(temporary, target);
  } catch (renameError) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw renameError;
  }
}
