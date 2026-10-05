import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * 课程备份使用可移植的目录快照：备份根目录下是 `.yeyu-backup.json`
 * 描述文件，所有原始课程文件原样位于 `payload/` 下。全程流式复制/哈希，
 * 不把 PDF 读进内存，也不接受符号链接或特殊文件。
 */
export class CourseBackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CourseBackupError';
    this.code = code;
  }
}

const BACKUP_FORMAT = 'yeyu-course-backup';
const BACKUP_VERSION = 1;
const METADATA_FILE = '.yeyu-backup.json';
const PAYLOAD_DIR = 'payload';
const CURRENT_MANIFEST = 'course.json';
const KNOWLEDGE_DIR = 'Knowledge';
const DOCUMENTS_DIR = 'Documents';
const PDFS_DIR = 'PDFs';
const ROOT_KNOWLEDGE_FILES = ['课程脑图.json'];
const RESTORE_SUFFIX = '（恢复）';

const MAX_FILES = 10_000;
const MAX_DEPTH = 20;
const MAX_TOTAL_BYTES = 10 * 1024 ** 3;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
/** Active AI processing that must not survive a restore as a live job. */
const ACTIVE_PROCESSING_STATUSES = new Set(['queued', 'running']);
const REVIEW_PROCESSING_STATUS = 'review';
const HISTORY_DIR = 'History';
const PENDING_REVIEW_ARCHIVE_PREFIX = 'restored-pending-review-';

interface SourceFileEntry {
  relPath: string;
  absolutePath: string;
  size: number;
}

interface BackupFileRecord {
  path: string;
  size: number;
  sha256: string;
}

interface NormalizedDocument {
  id: string;
  storedFileName: string;
  sha256: string;
  pageCount: number;
  hasSummary: boolean;
  hasMindmap: boolean;
  includedInCourse: boolean;
}

interface CourseValidation {
  manifest: Record<string, unknown>;
  manifestRaw: string;
  id: string;
  name: string;
  revision: number;
  activeKnowledgeVersion: number;
  documents: NormalizedDocument[];
}

interface BackupMetadata {
  createdAt: string;
  courseId: string;
  courseName: string;
  records: BackupFileRecord[];
}

interface BackupInspection {
  name: string;
  courseId: string;
  createdAt: string;
  files: number;
  bytes: number;
  documents: number;
  payloadRoot: string;
  manifest: Record<string, unknown>;
  fileRecords: BackupFileRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManifestShape(value: Record<string, unknown>): boolean {
  return (
    typeof value.schemaVersion === 'number' &&
    Array.isArray(value.documents) &&
    typeof value.id === 'string'
  );
}

function isKnowledgeShape(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.nodes) &&
    Array.isArray(value.relations) &&
    Array.isArray(value.conflicts)
  );
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CourseBackupError('INVALID_JSON', `${label}不是合法 JSON。`);
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CourseBackupError('INVALID_FIELD', `${label}必须是非空字符串。`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new CourseBackupError('INVALID_FIELD', `${label}必须是整数。`);
  }
  return value;
}

function readFingerprint(value: Record<string, unknown>): string | undefined {
  const candidate =
    typeof value.sha256 === 'string'
      ? value.sha256
      : typeof value.fingerprint === 'string'
        ? value.fingerprint
        : undefined;
  return typeof candidate === 'string' ? candidate.toLowerCase() : undefined;
}

function assertSafeId(value: string, label: string): void {
  if (value === '.' || value === '..' || value.length > 256) {
    throw new CourseBackupError('INVALID_ID', `${label}非法。`);
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\u0000')) {
    throw new CourseBackupError('INVALID_ID', `${label}非法。`);
  }
}

/**
 * Rejects a single path segment that would not be portable across platforms:
 * drive prefixes, control characters, Windows-illegal characters and trailing
 * dots/spaces. Applied to source directory traversal as well as metadata reads.
 */
function assertPortablePathSegment(segment: string, label: string): void {
  if (segment.length === 0 || segment === '.' || segment === '..') {
    throw new CourseBackupError('INVALID_PATH', `${label}包含非法路径段。`);
  }
  if (/^[A-Za-z]:/.test(segment)) {
    throw new CourseBackupError('INVALID_PATH', `${label}不允许盘符路径段。`);
  }
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      throw new CourseBackupError('INVALID_PATH', `${label}包含控制字符。`);
    }
  }
  if (/[<>:"|?*\\]/.test(segment)) {
    throw new CourseBackupError(
      'INVALID_PATH',
      `${label}包含 Windows 非法字符。`,
    );
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    throw new CourseBackupError('INVALID_PATH', `${label}不能以点或空格结尾。`);
  }
}

function normalizeRelPath(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CourseBackupError('INVALID_PATH', `${label}必须是非空字符串。`);
  }
  if (raw.includes('\0') || raw.includes('\\')) {
    throw new CourseBackupError('INVALID_PATH', `${label}包含非法字符。`);
  }
  if (raw.startsWith('/') || path.posix.isAbsolute(raw)) {
    throw new CourseBackupError('INVALID_PATH', `${label}不允许绝对路径。`);
  }
  const segments = raw.split('/');
  if (segments.length > MAX_DEPTH) {
    throw new CourseBackupError('TOO_DEEP', `${label}层级过深。`);
  }
  for (const segment of segments) {
    assertPortablePathSegment(segment, label);
  }
  return raw;
}

function sanitizeName(name: string): string {
  const withoutControls = Array.from(name)
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('');
  const cleaned = withoutControls
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return '未命名课程';
  }
  return cleaned.slice(0, 100);
}

function randomSuffix(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function timestampForName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function assertNoSymlinkComponents(
  resolved: string,
  label: string,
): Promise<void> {
  const parsed = path.parse(resolved);
  const rest = resolved.slice(parsed.root.length);
  if (rest.length === 0) return;
  let current = parsed.root;
  for (const segment of rest.split(path.sep)) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      throw new CourseBackupError('MISSING', `${label}路径不存在：${current}`);
    }
    if (stat.isSymbolicLink()) {
      throw new CourseBackupError(
        'SYMLINK',
        `${label}路径包含符号链接：${current}`,
      );
    }
  }
}

async function assertRealDirectory(
  target: string,
  label: string,
): Promise<string> {
  const resolved = path.resolve(target);
  await assertNoSymlinkComponents(resolved, label);
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch {
    throw new CourseBackupError('MISSING', `${label}不存在：${resolved}`);
  }
  if (stat.isSymbolicLink()) {
    throw new CourseBackupError(
      'SYMLINK',
      `${label}不允许符号链接：${resolved}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new CourseBackupError(
      'NOT_DIRECTORY',
      `${label}不是目录：${resolved}`,
    );
  }
  return resolved;
}

async function readTextFile(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    throw new CourseBackupError('MISSING', `文件不存在：${filePath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new CourseBackupError('SYMLINK', `不允许符号链接：${filePath}`);
  }
  if (!stat.isFile()) {
    throw new CourseBackupError('NOT_FILE', `不是普通文件：${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new CourseBackupError('TOO_LARGE', `文件过大：${filePath}`);
  }
  return stripBom(await fs.readFile(filePath, 'utf8'));
}

async function resolveWithinRoot(
  root: string,
  relRaw: string,
  label: string,
): Promise<string> {
  const rel = normalizeRelPath(relRaw, label);
  const absolute = path.join(root, ...rel.split('/'));
  const inside = path.relative(root, absolute);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new CourseBackupError('PATH_ESCAPE', `${label}越出课程目录。`);
  }
  let current = root;
  for (const segment of rel.split('/')) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      throw new CourseBackupError('MISSING', `${label}不存在：${rel}`);
    }
    if (stat.isSymbolicLink()) {
      throw new CourseBackupError('SYMLINK', `${label}包含符号链接：${rel}`);
    }
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isFile()) {
    throw new CourseBackupError('NOT_FILE', `${label}不是普通文件：${rel}`);
  }
  return absolute;
}

async function hashFileStream(
  filePath: string,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    hash.update(buffer);
    size += buffer.length;
  }
  return { size, sha256: hash.digest('hex') };
}

async function copyAndHashFile(
  sourcePath: string,
  destinationPath: string,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as string);
      hash.update(buffer);
      size += buffer.length;
      callback(null, buffer);
    },
  });
  await pipeline(
    createReadStream(sourcePath),
    meter,
    createWriteStream(destinationPath, { flags: 'wx' }),
  );
  return { size, sha256: hash.digest('hex') };
}

async function collectCourseFiles(root: string): Promise<SourceFileEntry[]> {
  const files: SourceFileEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const pending: Array<{ dir: string; rel: string; depth: number }> = [
    { dir: root, rel: '', depth: 0 },
  ];
  while (pending.length > 0) {
    const current = pending.pop() as {
      dir: string;
      rel: string;
      depth: number;
    };
    let dirents;
    try {
      dirents = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      throw new CourseBackupError(
        'READ_FAILED',
        `无法读取目录：${current.dir}`,
      );
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const name = dirent.name;
      assertPortablePathSegment(name, '课程路径');
      const rel = current.rel === '' ? name : `${current.rel}/${name}`;
      const absolute = path.join(current.dir, name);
      const depth = current.depth + 1;
      if (dirent.isSymbolicLink()) {
        throw new CourseBackupError('SYMLINK', `不允许符号链接：${rel}`);
      }
      if (dirent.isDirectory()) {
        if (depth > MAX_DEPTH) {
          throw new CourseBackupError('TOO_DEEP', `目录层级过深：${rel}`);
        }
        pending.push({ dir: absolute, rel, depth });
        continue;
      }
      if (!dirent.isFile()) {
        throw new CourseBackupError('SPECIAL_FILE', `不允许特殊文件：${rel}`);
      }
      if (depth > MAX_DEPTH) {
        throw new CourseBackupError('TOO_DEEP', `文件层级过深：${rel}`);
      }
      const key = rel.toLowerCase();
      if (seen.has(key)) {
        throw new CourseBackupError('DUPLICATE_PATH', `路径重复：${rel}`);
      }
      seen.add(key);
      let stat;
      try {
        stat = await fs.lstat(absolute);
      } catch {
        throw new CourseBackupError('MISSING', `文件不存在：${rel}`);
      }
      if (stat.isSymbolicLink()) {
        throw new CourseBackupError('SYMLINK', `不允许符号链接：${rel}`);
      }
      if (!stat.isFile()) {
        throw new CourseBackupError('SPECIAL_FILE', `不允许特殊文件：${rel}`);
      }
      files.push({ relPath: rel, absolutePath: absolute, size: stat.size });
      totalBytes += stat.size;
      if (files.length > MAX_FILES) {
        throw new CourseBackupError('TOO_MANY_FILES', '课程文件数量超过上限。');
      }
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new CourseBackupError('TOO_LARGE', '课程文件总大小超过上限。');
      }
    }
  }
  files.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  return files;
}

async function findKnowledgeFile(
  root: string,
  version: number,
): Promise<string> {
  const candidates = [
    `${KNOWLEDGE_DIR}/knowledge-v${version}.json`,
    ...ROOT_KNOWLEDGE_FILES,
  ];
  for (const rel of candidates) {
    try {
      return await resolveWithinRoot(root, rel, '知识图谱');
    } catch (error) {
      if (error instanceof CourseBackupError && error.code === 'MISSING')
        continue;
      throw error;
    }
  }
  throw new CourseBackupError(
    'MISSING_KNOWLEDGE',
    '缺少当前版本的知识图谱文件。',
  );
}

async function validateCourseDirectory(
  root: string,
): Promise<CourseValidation> {
  const manifestPath = path.join(root, CURRENT_MANIFEST);
  const manifestRaw = await readTextFile(manifestPath, MAX_JSON_BYTES);
  const parsedManifest = parseJson(manifestRaw, CURRENT_MANIFEST);
  if (!isRecord(parsedManifest)) {
    throw new CourseBackupError('INVALID_MANIFEST', 'course.json 必须是对象。');
  }
  const manifest = parsedManifest;
  if (manifest.schemaVersion !== 1) {
    throw new CourseBackupError(
      'INVALID_MANIFEST',
      'course.json schemaVersion 必须为 1。',
    );
  }
  const id = requireNonEmptyString(manifest.id, 'course.json id');
  assertSafeId(id, 'course.json id');
  const name = requireNonEmptyString(manifest.name, 'course.json name');
  const revision = requireInteger(manifest.revision, 'course.json revision');
  if (revision < 0) {
    throw new CourseBackupError(
      'INVALID_MANIFEST',
      'course.json revision 不能为负。',
    );
  }
  const activeKnowledgeVersion = requireInteger(
    manifest.activeKnowledgeVersion,
    'course.json activeKnowledgeVersion',
  );
  if (activeKnowledgeVersion < 0) {
    throw new CourseBackupError(
      'INVALID_MANIFEST',
      'activeKnowledgeVersion 不能为负。',
    );
  }
  if (!Array.isArray(manifest.documents)) {
    throw new CourseBackupError(
      'INVALID_MANIFEST',
      'course.json documents 必须是数组。',
    );
  }
  const documents: NormalizedDocument[] = [];
  const seenIds = new Set<string>();
  for (const rawDoc of manifest.documents) {
    if (!isRecord(rawDoc)) {
      throw new CourseBackupError(
        'INVALID_DOCUMENT',
        'documents 元素必须是对象。',
      );
    }
    const docId = requireNonEmptyString(rawDoc.id, 'document id');
    assertSafeId(docId, 'document id');
    const idKey = docId.toLowerCase();
    if (seenIds.has(idKey)) {
      throw new CourseBackupError('DUPLICATE_ID', `文档 ID 重复：${docId}`);
    }
    seenIds.add(idKey);
    const storedFileName = normalizeRelPath(
      requireNonEmptyString(rawDoc.storedFileName, 'document storedFileName'),
      'document storedFileName',
    );
    if (storedFileName.includes('/'))
      throw new CourseBackupError('INVALID_PATH', 'PDF 文件名不能包含目录。');
    const sha256 = readFingerprint(rawDoc);
    if (sha256 === undefined || !HEX64.test(sha256)) {
      throw new CourseBackupError(
        'INVALID_FINGERPRINT',
        `文档指纹非法：${docId}`,
      );
    }
    const pageCount = requireInteger(rawDoc.pageCount, 'document pageCount');
    if (pageCount <= 0) {
      throw new CourseBackupError(
        'INVALID_PAGE_COUNT',
        `文档页数必须为正：${docId}`,
      );
    }
    const hasSummary = rawDoc.hasSummary === true;
    const hasMindmap = rawDoc.hasMindmap === true;
    const includedInCourse = rawDoc.includedInCourse === true;

    const pdfPath = await resolveWithinRoot(
      root,
      `${PDFS_DIR}/${storedFileName}`,
      'PDF 文件',
    );
    const pdfHash = await hashFileStream(pdfPath);
    if (pdfHash.sha256 !== sha256) {
      throw new CourseBackupError(
        'FINGERPRINT_MISMATCH',
        `PDF 指纹不匹配：${storedFileName}`,
      );
    }

    if (hasSummary || hasMindmap || includedInCourse) {
      const digestPath = await resolveWithinRoot(
        root,
        `${DOCUMENTS_DIR}/${docId}/document.json`,
        '摘要文件',
      );
      const digest = parseJson(
        await readTextFile(digestPath, MAX_JSON_BYTES),
        'document.json',
      );
      if (!isRecord(digest)) {
        throw new CourseBackupError(
          'INVALID_DIGEST',
          `document.json 必须是对象：${docId}`,
        );
      }
      if (digest.documentId !== docId) {
        throw new CourseBackupError(
          'DIGEST_MISMATCH',
          `摘要 documentId 不匹配：${docId}`,
        );
      }
      if (readFingerprint(digest) !== sha256) {
        throw new CourseBackupError(
          'DIGEST_MISMATCH',
          `摘要指纹不匹配：${docId}`,
        );
      }
    }

    documents.push({
      id: docId,
      storedFileName,
      sha256,
      pageCount,
      hasSummary,
      hasMindmap,
      includedInCourse,
    });
  }

  const knowledgePath = await findKnowledgeFile(root, activeKnowledgeVersion);
  const knowledge = parseJson(
    await readTextFile(knowledgePath, MAX_JSON_BYTES),
    '知识图谱',
  );
  if (!isRecord(knowledge)) {
    throw new CourseBackupError('INVALID_KNOWLEDGE', '知识图谱必须是对象。');
  }
  if (knowledge.courseId !== id) {
    throw new CourseBackupError(
      'KNOWLEDGE_MISMATCH',
      '知识图谱 courseId 不匹配。',
    );
  }
  if (
    knowledge.version !== undefined &&
    knowledge.version !== activeKnowledgeVersion
  ) {
    throw new CourseBackupError('KNOWLEDGE_MISMATCH', '知识图谱版本不匹配。');
  }
  if (
    !Array.isArray(knowledge.nodes) ||
    !Array.isArray(knowledge.relations) ||
    !Array.isArray(knowledge.conflicts)
  ) {
    throw new CourseBackupError(
      'INVALID_KNOWLEDGE',
      '知识图谱缺少 nodes/relations/conflicts 数组。',
    );
  }

  return {
    manifest,
    manifestRaw,
    id,
    name,
    revision,
    activeKnowledgeVersion,
    documents,
  };
}

async function assertSourceUnchanged(
  sourceRoot: string,
  before: SourceFileEntry[],
  records: BackupFileRecord[],
  validation: CourseValidation,
): Promise<void> {
  const after = await collectCourseFiles(sourceRoot);
  if (after.length !== before.length || after.length !== records.length) {
    throw new CourseBackupError(
      'SOURCE_CHANGED',
      '课程文件在导出过程中发生了变化。',
    );
  }
  const byPath = new Map<string, SourceFileEntry>();
  for (const entry of after) byPath.set(entry.relPath.toLowerCase(), entry);
  for (const record of records) {
    const entry = byPath.get(record.path.toLowerCase());
    if (
      entry === undefined ||
      entry.relPath !== record.path ||
      entry.size !== record.size
    ) {
      throw new CourseBackupError(
        'SOURCE_CHANGED',
        '课程文件在导出过程中发生了变化。',
      );
    }
    const hashed = await hashFileStream(entry.absolutePath);
    if (hashed.size !== record.size || hashed.sha256 !== record.sha256) {
      throw new CourseBackupError(
        'SOURCE_CHANGED',
        '课程文件在导出过程中发生了变化。',
      );
    }
  }
  const afterManifest = await readTextFile(
    path.join(sourceRoot, CURRENT_MANIFEST),
    MAX_JSON_BYTES,
  );
  if (afterManifest !== validation.manifestRaw) {
    throw new CourseBackupError(
      'SOURCE_CHANGED',
      '课程清单在导出过程中发生了变化。',
    );
  }
  await validateCourseDirectory(sourceRoot);
}

function normalizePayloadRecordPath(raw: unknown): string {
  const rel = normalizeRelPath(raw, '备份清单路径');
  if (rel === PAYLOAD_DIR) {
    throw new CourseBackupError(
      'INVALID_PATH',
      '备份清单路径不能是 payload 目录。',
    );
  }
  if (rel.startsWith(`${PAYLOAD_DIR}/`)) {
    return normalizeRelPath(rel.slice(PAYLOAD_DIR.length + 1), '备份清单路径');
  }
  return rel;
}

async function readBackupMetadata(root: string): Promise<BackupMetadata> {
  const metadataPath = path.join(root, METADATA_FILE);
  const parsed = parseJson(
    await readTextFile(metadataPath, MAX_METADATA_BYTES),
    METADATA_FILE,
  );
  if (!isRecord(parsed)) {
    throw new CourseBackupError('INVALID_METADATA', '备份描述必须是对象。');
  }
  if (parsed.format !== BACKUP_FORMAT) {
    throw new CourseBackupError('INVALID_METADATA', '备份格式标识不匹配。');
  }
  if (parsed.version !== BACKUP_VERSION) {
    throw new CourseBackupError('INVALID_METADATA', '备份版本不受支持。');
  }
  const createdAt = requireNonEmptyString(parsed.createdAt, '备份 createdAt');
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new CourseBackupError('INVALID_METADATA', '备份 createdAt 非法。');
  }
  const courseId = requireNonEmptyString(parsed.courseId, '备份 courseId');
  assertSafeId(courseId, '备份 courseId');
  const courseName = requireNonEmptyString(
    parsed.courseName,
    '备份 courseName',
  );
  if (!Array.isArray(parsed.files)) {
    throw new CourseBackupError('INVALID_METADATA', '备份 files 必须是数组。');
  }
  if (parsed.files.length > MAX_FILES) {
    throw new CourseBackupError('TOO_MANY_FILES', '备份文件数量超过上限。');
  }
  const records: BackupFileRecord[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const rawRecord of parsed.files) {
    if (!isRecord(rawRecord)) {
      throw new CourseBackupError(
        'INVALID_METADATA',
        '备份文件条目必须是对象。',
      );
    }
    const recordPath = normalizePayloadRecordPath(rawRecord.path);
    const size = requireInteger(rawRecord.size, '备份文件 size');
    if (size < 0 || size > MAX_TOTAL_BYTES) {
      throw new CourseBackupError('INVALID_METADATA', '备份文件大小非法。');
    }
    const sha256 = requireNonEmptyString(
      rawRecord.sha256,
      '备份文件 sha256',
    ).toLowerCase();
    if (!HEX64.test(sha256)) {
      throw new CourseBackupError('INVALID_METADATA', '备份文件 sha256 非法。');
    }
    const key = recordPath.toLowerCase();
    if (seen.has(key)) {
      throw new CourseBackupError(
        'DUPLICATE_PATH',
        `备份清单路径重复：${recordPath}`,
      );
    }
    seen.add(key);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new CourseBackupError('TOO_LARGE', '备份文件总大小超过上限。');
    }
    records.push({ path: recordPath, size, sha256 });
  }
  return { createdAt, courseId, courseName, records };
}

async function inspectBackupFull(
  backupRoot: string,
): Promise<BackupInspection> {
  const root = await assertRealDirectory(backupRoot, '备份目录');
  const metadata = await readBackupMetadata(root);
  const payloadRoot = await assertRealDirectory(
    path.join(root, PAYLOAD_DIR),
    '备份 payload 目录',
  );
  const actualFiles = await collectCourseFiles(payloadRoot);
  const listed = new Map<string, BackupFileRecord>();
  for (const record of metadata.records)
    listed.set(record.path.toLowerCase(), record);
  if (actualFiles.length !== listed.size) {
    throw new CourseBackupError(
      'FILE_SET_MISMATCH',
      '备份文件清单与实际内容不一致。',
    );
  }
  for (const file of actualFiles) {
    const record = listed.get(file.relPath.toLowerCase());
    if (record === undefined || record.path !== file.relPath) {
      throw new CourseBackupError(
        'UNLISTED_FILE',
        `存在未列出的文件：${file.relPath}`,
      );
    }
    if (record.size !== file.size) {
      throw new CourseBackupError(
        'SIZE_MISMATCH',
        `文件大小不一致：${file.relPath}`,
      );
    }
    const hashed = await hashFileStream(file.absolutePath);
    if (hashed.size !== record.size || hashed.sha256 !== record.sha256) {
      throw new CourseBackupError(
        'HASH_MISMATCH',
        `文件哈希不一致：${file.relPath}`,
      );
    }
  }
  const validation = await validateCourseDirectory(payloadRoot);
  const bytes = actualFiles.reduce((sum, file) => sum + file.size, 0);
  return {
    name: validation.name,
    courseId: validation.id,
    createdAt: metadata.createdAt,
    files: actualFiles.length,
    bytes,
    documents: validation.documents.length,
    payloadRoot,
    manifest: validation.manifest,
    fileRecords: metadata.records,
  };
}

function rewriteJsonValue(
  value: unknown,
  oldId: string,
  newId: string,
): boolean {
  let changed = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if (isManifestShape(node) && node.id === oldId) {
      node.id = newId;
      changed = true;
    }
    if (isKnowledgeShape(node) && node.courseId === oldId) {
      node.courseId = newId;
      changed = true;
    }
    for (const key of Object.keys(node)) visit(node[key]);
  };
  visit(value);
  return changed;
}

/**
 * A JSON file may be rewritten only when it lives in a recognized course
 * metadata location. Arbitrary JSON under Documents/, translations/ or user
 * folders must be preserved byte-for-byte, even if it looks like a manifest.
 */
function classifyMetadataPath(
  relPath: string,
): 'manifest' | 'knowledge' | undefined {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1];
  const baseLower = base.toLowerCase();
  const inHistory =
    segments.length > 1 &&
    segments[0].toLowerCase() === HISTORY_DIR.toLowerCase();
  if (
    inHistory &&
    segments.length === 2 &&
    /^revision-\d+-\d+\.json$/.test(base)
  )
    return 'knowledge';
  if (segments.length === 1 || inHistory) {
    if (base === CURRENT_MANIFEST) return 'manifest';
    if (
      ROOT_KNOWLEDGE_FILES.some(
        (candidate) => candidate.toLowerCase() === baseLower,
      )
    ) {
      return 'knowledge';
    }
  }
  const parent =
    segments.length >= 2 ? segments[segments.length - 2] : undefined;
  if (
    parent !== undefined &&
    parent.toLowerCase() === KNOWLEDGE_DIR.toLowerCase() &&
    baseLower.endsWith('.json')
  ) {
    const knowledgeIndex = segments.length - 2;
    if (knowledgeIndex === 0 || (knowledgeIndex >= 1 && inHistory)) {
      return 'knowledge';
    }
  }
  return undefined;
}

/**
 * `document.status` is the import stage (`copied`, `document-artifacts-ready`,
 * `course-merged`) and must be preserved. Only the nested `document.processing`
 * state is normalized so no AI job keeps running for the restored course.
 */
function normalizeDocumentProcessing(document: Record<string, unknown>): void {
  const processing = document.processing;
  if (!isRecord(processing)) return;
  const status = processing.status;
  if (typeof status !== 'string') return;
  const normalized = status.toLowerCase();
  if (ACTIVE_PROCESSING_STATUSES.has(normalized)) {
    processing.status = 'paused';
    delete processing.runId;
    return;
  }
  if (normalized === REVIEW_PROCESSING_STATUS) {
    processing.status = 'paused';
  }
}

async function rewriteCourseIdentity(
  stagingRoot: string,
  oldId: string,
  newId: string,
  newName: string,
): Promise<void> {
  const manifestPath = path.join(stagingRoot, CURRENT_MANIFEST);
  const manifest = parseJson(
    await readTextFile(manifestPath, MAX_JSON_BYTES),
    CURRENT_MANIFEST,
  );
  if (!isRecord(manifest)) {
    throw new CourseBackupError('INVALID_MANIFEST', 'course.json 必须是对象。');
  }
  manifest.id = newId;
  manifest.name = newName;
  const revision =
    typeof manifest.revision === 'number' &&
    Number.isSafeInteger(manifest.revision)
      ? manifest.revision
      : 0;
  manifest.revision = revision + 1;
  manifest.updatedAt = new Date().toISOString();
  const pendingReview = manifest.pendingReview;
  delete manifest.pendingReview;
  if (Array.isArray(manifest.documents)) {
    for (const document of manifest.documents) {
      if (isRecord(document)) normalizeDocumentProcessing(document);
    }
  }
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const files = await collectCourseFiles(stagingRoot);
  for (const file of files) {
    if (classifyMetadataPath(file.relPath) === undefined) continue;
    if (file.size > MAX_JSON_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readTextFile(file.absolutePath, MAX_JSON_BYTES),
      );
    } catch {
      continue;
    }
    if (!isRecord(parsed) && !Array.isArray(parsed)) continue;
    if (rewriteJsonValue(parsed, oldId, newId)) {
      await fs.writeFile(
        file.absolutePath,
        `${JSON.stringify(parsed, null, 2)}\n`,
        'utf8',
      );
    }
  }

  if (pendingReview !== undefined) {
    const archiveRel = `${HISTORY_DIR}/${PENDING_REVIEW_ARCHIVE_PREFIX}${newId}.json`;
    const archivePath = path.join(stagingRoot, ...archiveRel.split('/'));
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(
      archivePath,
      `${JSON.stringify(pendingReview, null, 2)}\n`,
      'utf8',
    );
  }
}

async function uniqueBackupDirectoryName(
  destinationParent: string,
  courseName: string,
): Promise<string> {
  const base = `${sanitizeName(courseName)}-备份-${timestampForName(new Date())}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `${base}-${randomSuffix(4)}`;
    try {
      await fs.lstat(path.join(destinationParent, candidate));
    } catch {
      return candidate;
    }
  }
  throw new CourseBackupError('NAME_CONFLICT', '无法生成唯一的备份目录名。');
}

async function uniqueRestoreDirectoryName(
  coursesRoot: string,
  baseName: string,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `${baseName}-${randomSuffix(4)}`;
    try {
      await fs.lstat(path.join(coursesRoot, candidate));
    } catch {
      return candidate;
    }
  }
  throw new CourseBackupError('NAME_CONFLICT', '无法生成唯一的课程目录名。');
}

export async function exportCourseBackup(
  courseRoot: string,
  destinationParent: string,
): Promise<{ directory: string; name: string; files: number; bytes: number }> {
  const sourceRoot = await assertRealDirectory(courseRoot, '课程目录');
  const destinationRoot = await assertRealDirectory(
    destinationParent,
    '备份目标目录',
  );
  if (isSameOrInside(sourceRoot, destinationRoot)) {
    throw new CourseBackupError(
      'DESTINATION_INSIDE_SOURCE',
      '备份目标不能位于课程目录内部。',
    );
  }

  const sourceFiles = await collectCourseFiles(sourceRoot);
  const validation = await validateCourseDirectory(sourceRoot);

  const staging = path.join(
    destinationRoot,
    `.yeyu-backup-staging-${randomSuffix(6)}`,
  );
  let published = false;
  try {
    await fs.mkdir(staging);
    const payloadRoot = path.join(staging, PAYLOAD_DIR);
    await fs.mkdir(payloadRoot);

    const records: BackupFileRecord[] = [];
    let bytes = 0;
    for (const file of sourceFiles) {
      const destinationPath = path.join(
        payloadRoot,
        ...file.relPath.split('/'),
      );
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      const copied = await copyAndHashFile(file.absolutePath, destinationPath);
      if (copied.size !== file.size) {
        throw new CourseBackupError(
          'SIZE_MISMATCH',
          `复制后大小不一致：${file.relPath}`,
        );
      }
      records.push({
        path: file.relPath,
        size: copied.size,
        sha256: copied.sha256,
      });
      bytes += copied.size;
    }

    await assertSourceUnchanged(sourceRoot, sourceFiles, records, validation);

    const metadata = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      courseId: validation.id,
      courseName: validation.name,
      files: records,
    };
    await fs.writeFile(
      path.join(staging, METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    );

    const name = await uniqueBackupDirectoryName(
      destinationRoot,
      validation.name,
    );
    const finalPath = path.join(destinationRoot, name);
    await fs.rename(staging, finalPath);
    published = true;
    return { directory: finalPath, name, files: records.length, bytes };
  } finally {
    if (!published) {
      await fs
        .rm(staging, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }
}

export async function inspectCourseBackup(backupRoot: string): Promise<{
  name: string;
  courseId: string;
  createdAt: string;
  files: number;
  bytes: number;
  documents: number;
}> {
  const inspection = await inspectBackupFull(backupRoot);
  return {
    name: inspection.name,
    courseId: inspection.courseId,
    createdAt: inspection.createdAt,
    files: inspection.files,
    bytes: inspection.bytes,
    documents: inspection.documents,
  };
}

export async function restoreCourseBackup(
  backupRoot: string,
  coursesRoot: string,
): Promise<{ directoryName: string; courseId: string; name: string }> {
  const courses = await assertRealDirectory(coursesRoot, '课程根目录');
  const inspection = await inspectBackupFull(backupRoot);

  const staging = path.join(
    path.dirname(courses),
    `.yeyu-restore-staging-${randomSuffix(6)}`,
  );
  if (isSameOrInside(courses, staging)) {
    throw new CourseBackupError(
      'INVALID_STAGING',
      '恢复暂存目录不能位于课程根目录内部。',
    );
  }

  let published = false;
  try {
    await fs.mkdir(staging);
    for (const record of inspection.fileRecords) {
      const sourcePath = path.join(
        inspection.payloadRoot,
        ...record.path.split('/'),
      );
      const destinationPath = path.join(staging, ...record.path.split('/'));
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      const copied = await copyAndHashFile(sourcePath, destinationPath);
      if (copied.size !== record.size || copied.sha256 !== record.sha256) {
        throw new CourseBackupError(
          'BACKUP_CHANGED',
          `备份文件在恢复前发生变化：${record.path}`,
        );
      }
    }

    const newId = `course-${randomUUID()}`;
    const newName = `${inspection.name}${RESTORE_SUFFIX}`;
    await rewriteCourseIdentity(staging, inspection.courseId, newId, newName);
    await validateCourseDirectory(staging);

    const directoryName = await uniqueRestoreDirectoryName(
      courses,
      sanitizeName(newName),
    );
    const finalPath = path.join(courses, directoryName);
    await fs.rename(staging, finalPath);
    published = true;
    return { directoryName, courseId: newId, name: newName };
  } finally {
    if (!published) {
      await fs
        .rm(staging, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }
}
