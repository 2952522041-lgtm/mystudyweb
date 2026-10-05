import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { isDshErrorCode, type DshErrorCode } from './dsh-errors.ts';
import type { DshTaskPriority } from './dsh-types.ts';

export interface DshRunRecord {
  id: string;
  model: string;
  task: DshTaskPriority;
  status: 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  queueMs: number;
  startupMs: number;
  executionMs: number;
  totalMs: number;
  retries: number;
  reused?: boolean;
  errorCode?: DshErrorCode;
}

/** Whitelist metadata only. Prompt, response, credential, endpoint and raw errors never enter this file. */
export function sanitizeDshRecord(input: unknown): DshRunRecord | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as DshRunRecord;
  if (
    typeof value.id !== 'string' ||
    !/^[\w-]{1,128}$/.test(value.id) ||
    typeof value.model !== 'string' ||
    !/^[\w.-]{1,80}$/.test(value.model) ||
    !['interactive', 'background', 'prefetch'].includes(value.task) ||
    !['completed', 'failed', 'cancelled'].includes(value.status) ||
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt))
  )
    return null;
  const ms = (n: number) =>
    Number.isFinite(n) && n >= 0 ? Math.round(Math.min(n, 86400000)) : 0;
  return {
    id: value.id,
    model: value.model,
    task: value.task,
    status: value.status,
    startedAt: value.startedAt,
    queueMs: ms(value.queueMs),
    startupMs: ms(value.startupMs),
    executionMs: ms(value.executionMs),
    totalMs: ms(value.totalMs),
    retries:
      Number.isSafeInteger(value.retries) && value.retries >= 0
        ? Math.min(value.retries, 2)
        : 0,
    ...(value.reused === true ? { reused: true } : {}),
    ...(isDshErrorCode(value.errorCode) ? { errorCode: value.errorCode } : {}),
  };
}

export class DshHistory {
  private records: DshRunRecord[] | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private file: string;
  private limit: number;
  constructor(file: string, limit = 200) {
    this.file = file;
    this.limit = limit;
  }
  private async load() {
    if (this.records) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      raw = [];
    }
    this.records = (Array.isArray(raw) ? raw : [])
      .map(sanitizeDshRecord)
      .filter((r): r is DshRunRecord => Boolean(r))
      .slice(-this.limit);
  }
  async list(): Promise<DshRunRecord[]> {
    await this.tail.catch(() => undefined);
    await this.load();
    return this.records!.map((record) => ({ ...record })).reverse();
  }
  append(value: DshRunRecord): Promise<void> {
    const record = sanitizeDshRecord(value);
    if (!record) return Promise.resolve();
    const next = this.tail
      .catch(() => undefined)
      .then(async () => {
        await this.load();
        this.records = [
          ...this.records!.filter((old) => old.id !== record.id),
          record,
        ].slice(-this.limit);
        await mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        await writeFile(temporary, JSON.stringify(this.records), {
          mode: 0o600,
        });
        await rename(temporary, this.file);
      });
    this.tail = next;
    return next;
  }
}
