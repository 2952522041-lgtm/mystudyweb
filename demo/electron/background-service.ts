import { randomUUID } from 'node:crypto';
import { sanitizeBackgroundSnapshot, validateBackgroundAction, type BackgroundCommand, type BackgroundSnapshot } from './background-types.ts';

export interface BackgroundHost {
  owner: number;
  load(): Promise<void>;
  send(command: BackgroundCommand): void;
  destroy(): void;
}
interface Pending { owner: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** Main-process supervisor. Owns no PDFs, text or provider settings. */
export class BackgroundService {
  private host: BackgroundHost | undefined;
  private snapshot: BackgroundSnapshot = { tasks: [], executor: 'desktop', available: false, error: '后台服务正在启动。' };
  private pending = new Map<string, Pending>();
  private restarts = 0;
  private stopped = false;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly options: {
    create(onFailure: (owner: number) => void): BackgroundHost;
    broadcast(snapshot: BackgroundSnapshot): void;
    releaseOwner(owner: number): void;
    startupTimeoutMs?: number;
    commandTimeoutMs?: number;
    restartDelayMs?: number;
    maxRestarts?: number;
  };
  constructor(options: BackgroundService['options']) { this.options = options; }
  get owner() { return this.host?.owner; }
  getSnapshot(): BackgroundSnapshot { return structuredClone(this.snapshot); }

  start() {
    if (this.stopped || this.host) return;
    try {
      const host = this.options.create(owner => this.failed(owner));
      this.host = host;
      this.startupTimer = setTimeout(() => this.failed(host.owner), this.options.startupTimeoutMs ?? 30_000);
      void host.load().catch(() => this.failed(host.owner));
    } catch { this.unavailable('后台服务无法启动。'); this.scheduleRestart(); }
  }
  publish(owner: number, value: unknown) {
    this.assertWorker(owner);
    const snapshot = sanitizeBackgroundSnapshot(value);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.snapshot = snapshot;
    try { this.options.broadcast(this.getSnapshot()); } catch { /* display observers never own host lifecycle */ }
  }
  control(owner: number, value: unknown): Promise<void> {
    const action = validateBackgroundAction(value);
    if (!this.host || !this.snapshot.available || this.stopped) return Promise.reject(new Error('后台服务尚未就绪，请稍后重试。'));
    if (this.pending.size >= 32) return Promise.reject(new Error('后台操作过多，请稍后重试。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('后台操作未及时响应，请查看最新任务状态后重试。'));
      }, this.options.commandTimeoutMs ?? 30_000);
      this.pending.set(id, { owner, resolve, reject, timer });
      try { this.host!.send({ ...action, id }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('后台服务暂时无法接收操作。')); }
    });
  }
  respond(owner: number, value: unknown) {
    this.assertWorker(owner);
    if (!value || typeof value !== 'object') throw new Error('后台响应无效。');
    const input = value as { id?: unknown; error?: unknown };
    if (typeof input.id !== 'string') throw new Error('后台响应无效。');
    const pending = this.pending.get(input.id);
    if (!pending) return;
    this.pending.delete(input.id); clearTimeout(pending.timer);
    if (input.error !== undefined) pending.reject(new Error('后台操作未完成，请刷新任务状态后重试。'));
    else pending.resolve();
  }
  cancelOwner(owner: number) {
    for (const [id, pending] of this.pending) if (pending.owner === owner) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error('操作窗口已关闭或重新加载。'));
    }
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const host = this.host;
    this.host = undefined;
    this.unavailable('后台服务已停止；已保存的任务将在下次启动后继续。');
    if (host) { this.options.releaseOwner(host.owner); host.destroy(); }
  }
  private assertWorker(owner: number) {
    if (this.stopped || this.host?.owner !== owner) throw new Error('只有后台执行窗口可以更新后台状态。');
  }
  private failed(owner: number) {
    const host = this.host;
    if (!host || host.owner !== owner || this.stopped) return;
    this.host = undefined;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.options.releaseOwner(owner);
    this.unavailable('后台服务已中断，正在尝试恢复；已保存的任务保留。');
    host.destroy();
    this.scheduleRestart();
  }
  private unavailable(error: string) {
    this.snapshot = { ...this.snapshot, available: false, error };
    try { this.options.broadcast(this.getSnapshot()); } catch { /* display observers never own host lifecycle */ }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(error)); }
    this.pending.clear();
  }
  private scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    if (this.restarts >= (this.options.maxRestarts ?? 3)) { this.unavailable('后台服务多次中断，自动恢复已停止。请重新启动页语；已保存的任务保留。'); return; }
    this.restarts++;
    this.restartTimer = setTimeout(() => { this.restartTimer = undefined; this.start(); }, this.options.restartDelayMs ?? 1000);
  }
}

/** Same-origin alone does not grant authority: reject subframes and unknown windows. */
export function assertDesktopRole(sender: { owner: number; mainFrame: boolean; sameOrigin: boolean }, windows: { main?: number; worker?: number }, role: 'main' | 'worker' | 'either' = 'either') {
  if (!sender.mainFrame || !sender.sameOrigin || (role === 'main' ? sender.owner !== windows.main : role === 'worker' ? sender.owner !== windows.worker : sender.owner !== windows.main && sender.owner !== windows.worker))
    throw new Error('当前窗口无权调用该桌面操作。');
}
