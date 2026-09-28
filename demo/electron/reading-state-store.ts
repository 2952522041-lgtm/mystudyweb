import { promises as fs } from 'node:fs';
import path from 'node:path';

const STORE_FILE_NAME = 'shared-reading-state.json';
const STORE_SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 20_000;

export interface SharedReadingState {
  page: number;
  zoom: number;
  version: number;
  updatedAt: string;
}

interface StoredReadingState extends SharedReadingState {
  courseId: string;
  documentId: string;
}

interface ReadingStateFile {
  schemaVersion: 1;
  states: StoredReadingState[];
}

export class ReadingStateConflictError extends Error {
  readonly current: SharedReadingState | null;

  constructor(current: SharedReadingState | null) {
    super('阅读进度已在另一台设备上更新，请继续操作后重试。');
    this.name = 'ReadingStateConflictError';
    this.current = current;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validState(value: unknown): value is StoredReadingState {
  if (!isRecord(value)) return false;
  return (
    typeof value.courseId === 'string' &&
    value.courseId.length > 0 &&
    value.courseId.length <= 255 &&
    typeof value.documentId === 'string' &&
    value.documentId.length > 0 &&
    value.documentId.length <= 255 &&
    Number.isInteger(value.page) &&
    (value.page as number) >= 1 &&
    Number.isInteger(value.zoom) &&
    (value.zoom as number) >= 50 &&
    (value.zoom as number) <= 200 &&
    Number.isInteger(value.version) &&
    (value.version as number) >= 1 &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

function publicState(state: StoredReadingState): SharedReadingState {
  return {
    page: state.page,
    zoom: state.zoom,
    version: state.version,
    updatedAt: state.updatedAt,
  };
}

/**
 * Host-owned reading progress shared by desktop/web clients. Mutations are
 * serialized so the expectedVersion check and atomic file replacement form a
 * single transaction inside the Electron process.
 */
export class ReadingStateStore {
  private readonly settingsRoot: string;
  private readonly filePath: string;
  private readonly now: () => number;
  private pending: Promise<void> = Promise.resolve();

  constructor(settingsRoot: string, now: () => number = Date.now) {
    this.settingsRoot = path.resolve(settingsRoot);
    this.filePath = path.join(this.settingsRoot, STORE_FILE_NAME);
    this.now = now;
  }

  async get(
    courseId: string,
    documentId: string,
  ): Promise<SharedReadingState | null> {
    return this.serialized(async () => {
      const data = await this.readFile();
      const state = data.states.find(
        (item) => item.courseId === courseId && item.documentId === documentId,
      );
      return state ? publicState(state) : null;
    });
  }

  async put(
    courseId: string,
    documentId: string,
    value: { page: number; zoom: number; expectedVersion: number },
  ): Promise<SharedReadingState> {
    return this.serialized(async () => {
      const data = await this.readFile();
      const index = data.states.findIndex(
        (item) => item.courseId === courseId && item.documentId === documentId,
      );
      const current = index >= 0 ? data.states[index]! : null;
      const currentVersion = current?.version ?? 0;
      if (value.expectedVersion !== currentVersion) {
        throw new ReadingStateConflictError(
          current ? publicState(current) : null,
        );
      }
      if (index < 0 && data.states.length >= MAX_RECORDS) {
        throw new Error('共享阅读进度数量已达到上限。');
      }
      const next: StoredReadingState = {
        courseId,
        documentId,
        page: value.page,
        zoom: value.zoom,
        version: currentVersion + 1,
        updatedAt: new Date(this.now()).toISOString(),
      };
      if (index >= 0) data.states[index] = next;
      else data.states.push(next);
      await this.writeFile(data);
      return publicState(next);
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pending.then(operation, operation);
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async assertSafeSettingsRoot(): Promise<void> {
    await fs.mkdir(this.settingsRoot, { recursive: true });
    const rootStat = await fs.lstat(this.settingsRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('工作区设置目录不安全，已拒绝保存阅读进度。');
    }
    const fileStat = await fs.lstat(this.filePath).catch(() => null);
    if (fileStat?.isSymbolicLink()) {
      throw new Error('阅读进度文件是符号链接，已拒绝访问。');
    }
    if (fileStat && !fileStat.isFile()) {
      throw new Error('阅读进度路径不是普通文件。');
    }
  }

  private async readFile(): Promise<ReadingStateFile> {
    await this.assertSafeSettingsRoot();
    const stat = await fs.lstat(this.filePath).catch(() => null);
    if (!stat) return { schemaVersion: STORE_SCHEMA_VERSION, states: [] };
    if (stat.size > MAX_STORE_BYTES) {
      throw new Error('共享阅读进度文件过大，已拒绝读取。');
    }
    const parsed = JSON.parse(
      await fs.readFile(this.filePath, 'utf8'),
    ) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== STORE_SCHEMA_VERSION ||
      !Array.isArray(parsed.states) ||
      parsed.states.length > MAX_RECORDS ||
      !parsed.states.every(validState)
    ) {
      throw new Error('共享阅读进度文件格式不受支持或已损坏。');
    }
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      states: parsed.states,
    };
  }

  private async writeFile(data: ReadingStateFile): Promise<void> {
    await this.assertSafeSettingsRoot();
    const encoded = `${JSON.stringify(data)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_STORE_BYTES) {
      throw new Error('共享阅读进度文件过大，无法保存。');
    }
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    try {
      await fs.writeFile(temporaryPath, encoded, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600).catch(() => undefined);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
