import type {
  CourseKnowledge,
  CourseManifest,
  DocumentDigest,
} from './course-storage/types.ts';
import type { Glossary } from './glossary.ts';
import type { ChatScope, PageConversation } from './chat-cache.ts';
import type { SharedTranslationRecord } from './shared-translation.ts';

export interface SharedReadingState {
  page: number;
  zoom: number;
  version: number;
  updatedAt: string;
}

export interface SharedSessionCapabilities {
  readingState: boolean;
  courseContent: 'read' | 'write';
  importPdf: boolean;
  ai: boolean;
  manage: boolean;
}

export interface SharedSession {
  expiresAt: number;
  csrfToken: string;
  capabilities: SharedSessionCapabilities;
}

export interface SaveSharedReadingStateInput {
  page: number;
  zoom: number;
  expectedVersion: number;
}

export interface ImportSharedPdfOptions {
  generateSummary: boolean;
  generateMindmap: boolean;
  mergeIntoCourse: boolean;
}

export interface SharedPdfImportResult {
  import: {
    courseId: string;
    courseName: string;
    fileName: string;
    documentId?: string;
    processing?: unknown;
    message?: string;
  };
}

export interface SharedGeneratedTranslation {
  pageNumber: number;
  targetLanguage: string;
  paragraphs: string[];
  provider: string;
  model: string;
  updatedAt: string;
}

export type SharedActionName =
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
  | 'save_glossary';

export interface SharedCourseListItem {
  id: string;
  name: string;
  updatedAt: string;
  documentCount: number;
}

export interface SharedCourseDetail {
  manifest: CourseManifest;
  knowledge: CourseKnowledge;
  digests: Record<string, DocumentDigest>;
}

export class SharedApiError extends Error {
  readonly status: number;
  readonly state?: SharedReadingState | null;

  constructor(
    status: number,
    message: string,
    state?: SharedReadingState | null,
  ) {
    super(message);
    this.name = 'SharedApiError';
    this.status = status;
    this.state = state;
  }
}

let sharedCsrfToken: string | null = null;

function isSharedReadingState(value: unknown): value is SharedReadingState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return (
    Number.isInteger(state.page) &&
    Number(state.page) >= 1 &&
    Number.isFinite(state.zoom) &&
    Number(state.zoom) >= 50 &&
    Number(state.zoom) <= 200 &&
    Number.isInteger(state.version) &&
    Number(state.version) >= 1 &&
    typeof state.updatedAt === 'string'
  );
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers,
    });
  } catch {
    throw new SharedApiError(
      0,
      '无法连接主电脑的共享服务，请确认页语仍在运行。',
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    state?: unknown;
  };
  if (!response.ok) {
    throw new SharedApiError(
      response.status,
      body.error ?? '共享服务返回了无法理解的错误。',
      response.status === 409
        ? body.state === null
          ? null
          : isSharedReadingState(body.state)
            ? body.state
            : undefined
        : undefined,
    );
  }
  return body as T;
}

export async function getSharedSession(): Promise<SharedSession> {
  const session = await requestJson<SharedSession>('/api/share/session');
  sharedCsrfToken =
    typeof session.csrfToken === 'string' && session.csrfToken.length > 0
      ? session.csrfToken
      : null;
  return session;
}

export async function loginToSharedService(
  password: string,
): Promise<SharedSession> {
  const session = await requestJson<SharedSession>('/api/share/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  sharedCsrfToken =
    typeof session.csrfToken === 'string' && session.csrfToken.length > 0
      ? session.csrfToken
      : null;
  return session;
}

export async function logoutFromSharedService(): Promise<void> {
  try {
    await requestJson('/api/share/logout', { method: 'POST' });
  } finally {
    sharedCsrfToken = null;
  }
}

export async function listSharedCourses(): Promise<{
  courses: SharedCourseListItem[];
}> {
  return requestJson('/api/share/courses');
}

export async function loadSharedCourse(
  courseId: string,
): Promise<SharedCourseDetail> {
  return requestJson(`/api/share/courses/${encodeURIComponent(courseId)}`);
}

export async function loadSharedPdf(
  courseId: string,
  documentId: string,
  fileName: string,
): Promise<File> {
  let response: Response;
  try {
    response = await fetch(
      `/api/share/courses/${encodeURIComponent(courseId)}/documents/${encodeURIComponent(documentId)}/file`,
      { credentials: 'same-origin' },
    );
  } catch {
    throw new SharedApiError(
      0,
      '无法连接主电脑的共享服务，请确认页语仍在运行。',
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new SharedApiError(
      response.status,
      body.error ?? 'PDF 文件暂时无法读取。',
    );
  }
  return new File([await response.blob()], fileName, {
    type: 'application/pdf',
  });
}

export async function loadSharedTranslations(
  courseId: string,
  documentId: string,
): Promise<{ translations: SharedTranslationRecord[] }> {
  return requestJson(
    `/api/share/courses/${encodeURIComponent(courseId)}/documents/${encodeURIComponent(documentId)}/translations`,
  );
}

function sharedReadingStatePath(courseId: string, documentId: string): string {
  return `/api/share/courses/${encodeURIComponent(courseId)}/documents/${encodeURIComponent(documentId)}/reading-state`;
}

export async function loadSharedReadingState(
  courseId: string,
  documentId: string,
): Promise<{ state: SharedReadingState | null }> {
  return requestJson(sharedReadingStatePath(courseId, documentId));
}

async function getSharedCsrfToken(): Promise<string | null> {
  if (sharedCsrfToken) return sharedCsrfToken;
  const session = await getSharedSession();
  return sharedCsrfToken ?? session.csrfToken ?? null;
}

export async function saveSharedReadingState(
  courseId: string,
  documentId: string,
  input: SaveSharedReadingStateInput,
): Promise<{ state: SharedReadingState }> {
  const csrfToken = await getSharedCsrfToken();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (csrfToken) headers.set('X-Yeyu-CSRF', csrfToken);
  return requestJson(sharedReadingStatePath(courseId, documentId), {
    method: 'PUT',
    headers,
    body: JSON.stringify(input),
  });
}

export async function importSharedPdf(
  courseId: string,
  file: File | Blob,
  options: ImportSharedPdfOptions = {
    generateSummary: true,
    generateMindmap: true,
    mergeIntoCourse: true,
  },
): Promise<SharedPdfImportResult> {
  const fileWithMetadata = file as File & {
    name?: string;
    lastModified?: number;
  };
  const fileName =
    typeof fileWithMetadata.name === 'string' && fileWithMetadata.name.length > 0
      ? fileWithMetadata.name
      : 'document.pdf';
  const fileLastModified =
    typeof fileWithMetadata.lastModified === 'number' &&
    Number.isFinite(fileWithMetadata.lastModified) &&
    fileWithMetadata.lastModified >= 0
      ? Math.floor(fileWithMetadata.lastModified)
      : 0;
  const params = new URLSearchParams({
    fileName,
    fileLastModified: String(fileLastModified),
    generateSummary: options.generateSummary ? '1' : '0',
    generateMindmap: options.generateMindmap ? '1' : '0',
    mergeIntoCourse: options.mergeIntoCourse ? '1' : '0',
  });
  const csrfToken = await getSharedCsrfToken();
  const headers = new Headers({ 'Content-Type': 'application/pdf' });
  if (csrfToken) headers.set('X-Yeyu-CSRF', csrfToken);
  return requestJson(
    `/api/share/courses/${encodeURIComponent(courseId)}/documents/import?${params.toString()}`,
    {
      method: 'POST',
      headers,
      body: file,
    },
  );
}

export async function runSharedAction<T>(
  name: SharedActionName,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const csrfToken = await getSharedCsrfToken();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (csrfToken) headers.set('X-Yeyu-CSRF', csrfToken);
  const payload = await requestJson<{ result: T }>(
    `/api/share/actions/${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ args }),
      signal,
    },
  );
  return payload.result;
}

function documentArgs(
  courseId: string,
  documentId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { courseId, documentId, ...extra };
}

export function translateSharedPage(
  courseId: string,
  documentId: string,
  page: number,
  targetLanguage: string,
  bypassCache = false,
  signal?: AbortSignal,
) {
  return runSharedAction<{
    translation: SharedGeneratedTranslation;
  }>(
    'translate_page',
    documentArgs(courseId, documentId, {
      page,
      targetLanguage,
      bypassCache,
    }),
    signal,
  );
}

export function loadSharedConversation(
  courseId: string,
  documentId: string,
  page: number,
  scope: ChatScope,
) {
  return runSharedAction<{ conversation: PageConversation | null }>(
    'get_conversation',
    documentArgs(courseId, documentId, { page, scope }),
  );
}

export function askSharedDocument(
  courseId: string,
  documentId: string,
  page: number,
  scope: ChatScope,
  question: string,
  signal?: AbortSignal,
) {
  return runSharedAction<{ conversation: PageConversation }>(
    'ask_document',
    documentArgs(courseId, documentId, {
      page,
      scope,
      question,
    }),
    signal,
  );
}

export function clearSharedConversation(
  courseId: string,
  documentId: string,
  page: number,
  scope: ChatScope,
) {
  return runSharedAction<{ cleared: true }>(
    'clear_conversation',
    documentArgs(courseId, documentId, { page, scope }),
  );
}

export function createSharedCourse(name: string) {
  return runSharedAction<{ id: string; name: string }>('create_course', {
    name,
  });
}

export function regenerateSharedDocument(
  courseId: string,
  documentId: string,
  signal?: AbortSignal,
) {
  return runSharedAction(
    'regenerate_document',
    documentArgs(courseId, documentId),
    signal,
  );
}

export function regenerateSharedCourse(
  courseId: string,
  signal?: AbortSignal,
) {
  return runSharedAction('regenerate_course', { courseId }, signal);
}

export function removeSharedDocument(
  courseId: string,
  documentId: string,
) {
  return runSharedAction('remove_document',
    documentArgs(courseId, documentId));
}

export function removeSharedCourse(courseId: string) {
  return runSharedAction('remove_course', { courseId });
}

export function loadSharedGlossary(courseId: string) {
  return runSharedAction<{ glossary: Glossary }>('get_glossary', { courseId });
}

export function saveSharedGlossary(courseId: string, glossary: Glossary) {
  return runSharedAction<{ glossary: Glossary }>('save_glossary', {
    courseId,
    glossary,
  });
}

export function isSharedView(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('yeyu-share') === '1'
  );
}
