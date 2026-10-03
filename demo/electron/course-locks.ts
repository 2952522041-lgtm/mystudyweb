import { randomUUID } from 'node:crypto';
import { assertSafeRelativeSegments } from './workspace-paths.ts';

interface Lease { owner: number; directory: string; token: string; operations: number; released: boolean }
interface Waiter { owner: number; resolve(token: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** Short write transactions shared by renderer processes. No AI request holds a
 * lock. A dying renderer's in-flight filesystem operation finishes before the
 * next owner enters, even though its renderer lease has already been revoked. */
export class CourseLocks {
  private holders = new Map<string, Lease>();
  private tokens = new Map<string, Lease>();
  private queues = new Map<string, Waiter[]>();
  private closed = false;
  private drains = new Set<() => void>();
  private readonly waitMs: number;
  constructor(waitMs = 30_000) { this.waitMs = waitMs; }

  acquire(owner: number, directory: string): Promise<string> {
    assertSafeRelativeSegments([directory]);
    if (this.closed) return Promise.reject(new Error('课程写入服务正在关闭。'));
    const count = [...this.queues.values()].reduce((total, queue) => total + queue.length, 0);
    if (count >= 256) return Promise.reject(new Error('等待写入的任务过多，请稍后重试。'));
    if (!this.holders.has(directory)) return Promise.resolve(this.grant(owner, directory));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { owner, resolve, reject, timer: setTimeout(() => {
        const queue = this.queues.get(directory);
        if (queue) this.queues.set(directory, queue.filter(item => item !== waiter));
        reject(new Error('等待课程写入超时，请稍后重试。'));
      }, this.waitMs) };
      const queue = this.queues.get(directory) ?? [];
      queue.push(waiter);
      this.queues.set(directory, queue);
    });
  }

  release(owner: number, token: string) {
    const lease = this.tokens.get(token);
    if (!lease || lease.owner !== owner) throw new Error('课程锁无效或不属于当前窗口。');
    lease.released = true;
    this.tokens.delete(token);
    this.finishRelease(lease);
  }

  releaseOwner(owner: number) {
    // Reject queued leases first so releasing a holder never grants to a dead owner.
    for (const [directory, queue] of this.queues) {
      for (const waiter of queue.filter(item => item.owner === owner)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('课程操作所在窗口已关闭或重新加载。'));
      }
      this.queues.set(directory, queue.filter(item => item.owner !== owner));
    }
    for (const lease of this.holders.values()) if (lease.owner === owner) {
      lease.released = true;
      this.tokens.delete(lease.token);
      this.finishRelease(lease);
    }
  }

  /** File IPC borrows an explicit transaction lease or obtains a one-write lease. */
  async run<T>(owner: number, directory: string, operation: () => Promise<T>): Promise<T> {
    let lease = this.holders.get(directory);
    const borrowed = lease?.owner === owner && !lease.released;
    let token: string | undefined;
    if (!borrowed) { token = await this.acquire(owner, directory); lease = this.tokens.get(token); }
    if (!lease || lease.released) throw new Error('课程写入已取消。');
    lease.operations++;
    try { return await operation(); }
    finally {
      lease.operations--;
      if (token && this.tokens.has(token)) this.release(owner, token);
      else this.finishRelease(lease);
    }
  }

  close(): Promise<void> {
    this.closed = true;
    const owners = new Set([...this.holders.values()].map(lease => lease.owner));
    for (const queue of this.queues.values()) for (const waiter of queue) owners.add(waiter.owner);
    for (const owner of owners) this.releaseOwner(owner);
    if (!this.holders.size) return Promise.resolve();
    return new Promise(resolve => this.drains.add(resolve));
  }
  private grant(owner: number, directory: string): string {
    const token = randomUUID();
    const lease = { owner, directory, token, operations: 0, released: false };
    this.holders.set(directory, lease); this.tokens.set(token, lease);
    return token;
  }
  private finishRelease(lease: Lease) {
    if (!lease.released || lease.operations || this.holders.get(lease.directory) !== lease) return;
    this.holders.delete(lease.directory);
    if (this.closed && !this.holders.size) { for (const resolve of this.drains) resolve(); this.drains.clear(); }
    const queue = this.queues.get(lease.directory);
    const waiter = queue?.shift();
    if (!queue?.length) this.queues.delete(lease.directory);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    if (this.closed) waiter.reject(new Error('课程写入服务正在关闭。'));
    else waiter.resolve(this.grant(waiter.owner, lease.directory));
  }
}
