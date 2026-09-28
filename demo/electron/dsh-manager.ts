import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  DSH_REQUEST_TIMEOUT_MS,
  DSH_RUNTIME_VERSION,
  validateDshRequest,
} from './dsh-policy.ts';
import type { DshCompletionResult, DshProgress } from './dsh-types.ts';

/** Only trusted main-process code supplies executable paths. Renderer supplies text. */
export class DshManager {
  private jobs = new Map<string, { owner: number; cancel: () => void }>();
  private workerPath: string;
  private runtimeRoot: string;
  private nodeCommand: string;
  private timeoutMs: number;
  constructor(
    workerPath: string,
    runtimeRoot = path.join(
      homedir(),
      '.local',
      'opt',
      `yeyu-dsh-runtime-${DSH_RUNTIME_VERSION}`,
    ),
    nodeCommand = path.join(
      runtimeRoot,
      process.platform === 'win32' ? 'node.exe' : 'node',
    ),
    timeoutMs = DSH_REQUEST_TIMEOUT_MS,
  ) {
    this.workerPath = workerPath;
    this.runtimeRoot = runtimeRoot;
    this.nodeCommand = nodeCommand;
    this.timeoutMs = timeoutMs;
  }

  cancel(owner: number, requestId: string) {
    const job = this.jobs.get(requestId);
    if (job?.owner === owner) job.cancel();
  }
  cancelOwner(owner: number) {
    for (const job of this.jobs.values()) if (job.owner === owner) job.cancel();
  }
  cancelAll() {
    for (const job of this.jobs.values()) job.cancel();
  }
  async close() {
    this.cancelAll();
    // Keep Electron alive until worker exit and request-directory cleanup settle.
    while (this.jobs.size)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async run(
    owner: number,
    value: unknown,
    progress: (value: DshProgress) => void,
  ): Promise<DshCompletionResult> {
    const request = validateDshRequest(value);
    if (this.jobs.has(request.requestId)) throw new Error('DSH 请求重复。');
    if (this.jobs.size >= 4)
      throw new Error('DSH 正在处理其他任务，请稍后重试。');
    let cancelled = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child?.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* already reaped */
      }
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    };
    this.jobs.set(request.requestId, { owner, cancel });
    let root: string | undefined;
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      root = await mkdtemp(path.join(tmpdir(), 'yeyu-dsh-'));
      const worker = path.join(root, 'worker.mjs');
      await copyFile(this.workerPath, worker);
      if (cancelled) throw new Error('DSH 任务已取消或超时。');
      child = spawn(this.nodeCommand, [worker, this.runtimeRoot, root], {
        cwd: root,
        detached: process.platform !== 'win32',
        stdio: 'pipe',
        env: {
          NODE_ENV: 'production',
          PATH: process.env.PATH ?? '',
          LANG: process.env.LANG ?? 'C.UTF-8',
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
      });
      const result = await new Promise<DshCompletionResult>(
        (resolve, reject) => {
          let buffer = '';
          let final: DshCompletionResult | undefined;
          let invalid = false;
          child!.stderr.resume(); // Runtime diagnostics may contain supplied text or credentials.
          child!.stdout.setEncoding('utf8');
          child!.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            if (buffer.length > 2_000_000) {
              invalid = true;
              cancel();
              return;
            }
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              try {
                const frame = JSON.parse(line);
                if (
                  frame.type === 'progress' &&
                  typeof frame.content === 'string' &&
                  !cancelled
                )
                  progress({
                    requestId: request.requestId,
                    content: frame.content,
                  });
                else if (
                  frame.type === 'result' &&
                  !final &&
                  typeof frame.content === 'string' &&
                  ['stop', 'length'].includes(frame.finishReason)
                )
                  final = {
                    content: frame.content,
                    finishReason: frame.finishReason,
                  };
                else {
                  invalid = true;
                  cancel();
                }
              } catch {
                invalid = true;
                cancel();
              }
            }
          });
          child!.on('error', () =>
            reject(new Error('DSH 运行时未安装或无法启动，请运行安装脚本。')),
          );
          child!.on('close', (code) => {
            if (cancelled || invalid || code !== 0 || !final || buffer.trim())
              reject(
                new Error('DSH 未完整完成、已取消或超时；未保存残缺结果。'),
              );
            else resolve(final);
          });
          child!.stdin.on('error', () => {});
          child!.stdin.end(JSON.stringify(request));
        },
      );
      return result;
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      kill('SIGKILL');
      // root is created here, never derived from a renderer-supplied path.
      try {
        if (root) await rm(root, { recursive: true, force: true });
      } finally {
        this.jobs.delete(request.requestId);
      }
    }
  }
}
