import type { ReaderRightModeName } from './reader-shortcuts.ts';

export interface EntityLocator {
  id?: string;
  name?: string;
}

export interface CourseControlDocument {
  id: string;
  fileName: string;
  pageCount: number;
}

export interface CourseControlItem {
  id: string;
  name: string;
  documents: CourseControlDocument[];
}

export interface CourseLibraryControlState {
  loading: boolean;
  activeCourseId: string | null;
  courses: CourseControlItem[];
}

export interface CourseLibraryControl {
  getState(): CourseLibraryControlState;
  openCourse(args: Record<string, unknown>): CourseControlItem;
  openDocument(args: Record<string, unknown>): Promise<{
    courseId: string;
    courseName: string;
    documentId: string;
    fileName: string;
    page: number;
  }>;
  importPdf(args: Record<string, unknown>): Promise<{
    courseId: string;
    courseName: string;
    fileName: string;
    message: string;
  }>;
}

export interface ReaderControlState {
  hasDocument: boolean;
  courseName: string | null;
  documentId: string | null;
  fileName: string | null;
  page: number;
  pageCount: number;
  panel: ReaderRightModeName;
}

export interface ReaderControl {
  getState(): ReaderControlState;
  goToPage(args: Record<string, unknown>): { page: number; pageCount: number };
  setPanel(args: Record<string, unknown>): { panel: ReaderRightModeName };
}

function optionalText(
  args: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}必须是非空字符串。`);
  }
  return value.trim();
}

export function readCourseLocator(
  args: Record<string, unknown>,
  required: boolean,
): EntityLocator | null {
  const locator = {
    id: optionalText(args, 'courseId', 'courseId'),
    name: optionalText(args, 'courseName', 'courseName'),
  };
  if (!locator.id && !locator.name) {
    if (required) throw new Error('请提供 courseId 或 courseName。');
    return null;
  }
  return locator;
}

export function readDocumentLocator(
  args: Record<string, unknown>,
): EntityLocator {
  const locator = {
    id: optionalText(args, 'documentId', 'documentId'),
    name: optionalText(args, 'fileName', 'fileName'),
  };
  if (!locator.id && !locator.name) {
    throw new Error('请提供 documentId 或 fileName。');
  }
  return locator;
}

export function locateEntity<T>(
  items: T[],
  locator: EntityLocator,
  fields: { id: (item: T) => string; name: (item: T) => string },
  label: string,
): T {
  const matches = items.filter(
    (item) =>
      (!locator.id || fields.id(item) === locator.id) &&
      (!locator.name || fields.name(item) === locator.name),
  );
  if (matches.length === 0) {
    throw new Error(`找不到匹配的${label}。`);
  }
  if (matches.length > 1) {
    throw new Error(`有多个同名${label}，请改用 ID 定位。`);
  }
  return matches[0];
}

export function readPage(
  args: Record<string, unknown>,
  fallback?: number,
): number {
  const value = args.page ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('page 必须是正整数。');
  }
  return value;
}

const READER_PANELS = new Set<ReaderRightModeName>([
  'translation',
  'chat',
  'summary',
  'mindmap',
]);

export function readReaderPanel(
  args: Record<string, unknown>,
): ReaderRightModeName {
  const value = args.panel;
  if (
    typeof value !== 'string' ||
    !READER_PANELS.has(value as ReaderRightModeName)
  ) {
    throw new Error('panel 必须是 translation、chat、summary 或 mindmap。');
  }
  return value as ReaderRightModeName;
}
