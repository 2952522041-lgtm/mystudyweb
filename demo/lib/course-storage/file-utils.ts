const INVALID_FILE_CHARACTERS = /[<>:"/\\|?*]/g;

export function sanitizeFileName(fileName: string): string {
  const withoutControlCharacters = Array.from(fileName)
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('');
  const clean = withoutControlCharacters
    .replace(INVALID_FILE_CHARACTERS, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return clean || '未命名.pdf';
}

export function suffixFileName(fileName: string, suffix: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return `${fileName}-${suffix}`;
  return `${fileName.slice(0, dot)}-${suffix}${fileName.slice(dot)}`;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function stableDocumentId(fingerprint: string): string {
  return `doc-${fingerprint.slice(0, 16)}`;
}

export function createCourseId(now = Date.now()): string {
  return `course-${now.toString(36)}`;
}

export function assertSafeArtifactContent(content: string): void {
  if (/\b(?:sk-[a-z0-9_-]{16,}|bearer\s+[a-z0-9._-]{12,})\b/i.test(content)) {
    throw new Error('课程成果疑似包含服务密钥，已阻止写入。');
  }
}
