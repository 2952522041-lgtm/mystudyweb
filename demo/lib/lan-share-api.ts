import type {
  CourseKnowledge,
  CourseManifest,
  DocumentDigest,
} from './course-storage/types.ts';
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

export function isSharedView(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('yeyu-share') === '1'
  );
}
