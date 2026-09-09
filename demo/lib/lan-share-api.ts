import type {
  CourseKnowledge,
  CourseManifest,
  DocumentDigest,
} from './course-storage/types.ts';

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

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SharedApiError';
    this.status = status;
  }
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
  };
  if (!response.ok) {
    throw new SharedApiError(
      response.status,
      body.error ?? '共享服务返回了无法理解的错误。',
    );
  }
  return body as T;
}

export async function getSharedSession(): Promise<{ expiresAt: number }> {
  return requestJson('/api/share/session');
}

export async function loginToSharedService(
  password: string,
): Promise<{ expiresAt: number }> {
  return requestJson('/api/share/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

export async function logoutFromSharedService(): Promise<void> {
  await requestJson('/api/share/logout', { method: 'POST' });
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

export function isSharedView(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('yeyu-share') === '1'
  );
}
