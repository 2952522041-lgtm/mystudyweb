import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

import { DshManager } from '../electron/dsh-manager.ts';
import { DshError } from '../electron/dsh-errors.ts';
import { DSH_CLIENT_VERSION, DSH_RUNTIME_VERSION } from '../electron/dsh-policy.ts';
import type { DshCompletionRequest, DshProgress } from '../electron/dsh-types.ts';

// Exercise the actual bundled worker and manager. Only the SDK is substituted;
// this fixture never loads an installed runtime, credentials or network code.
const MOCK_SDK = `
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const scenario = JSON.parse(await readFile(path.join(root, 'scenario.json'), 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = (sessionId, type, data) => ({
  method: 'session.event', params: { sessionId, event: { type, data } },
});

export class HarnessClient {
  constructor(options) { this.options = options; }
  start() {
    // A real child also proves close/cancel reaps the SDK process tree.
    this.child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  }
  async initialize() {
    const policy = JSON.parse(await readFile(this.options.patches[0], 'utf8'));
    await writeFile(path.join(root, 'worker-state.json'), JSON.stringify({
      workerPid: process.pid, sdkPid: this.child.pid,
      taskRoot: path.dirname(this.options.patches[0]),
      sdkIdleMs: policy.find(row => row.id === 'llm-deepseek').config.streamIdleTimeoutMs,
    }));
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime' } };
  }
  async prompt() { return 'mock-message'; }
  subscribeSessionTree(sessionId) {
    let index = 0;
    return {
      async next() {
        if (scenario.mode === 'startup-silent') return new Promise(() => {});
        const current = index++;
        if (current === 0) {
          await writeFile(path.join(root, 'status-delivered'), 'yes');
          return { method: 'session.status', params: { sessionId, status: 'running' } };
        }
        if (current === 1) {
          if (scenario.mode === 'hang') return new Promise(() => {});
          await delay(scenario.silenceMs);
          return event(sessionId, 'agent/inbox/spliced', { inserted: [{ id: 'mock-message' }] });
        }
        if (current === 2) return event(sessionId, 'turn/start', { turn: 1 });
        if (scenario.mode === 'sdk-idle') {
          await writeFile(path.join(root, 'sdk-idle-reported'), 'yes');
          return event(sessionId, 'turn/end', {
            turn: 1, reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'private-sdk-body' } },
          });
        }
        if (current === 3) return event(sessionId, 'assistant/message', {
          turn: 1, step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'complete answer' }] },
        });
        return event(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
      },
      close() {},
    };
  }
  async close() {
    const exited = once(this.child, 'exit');
    this.child.kill('SIGTERM');
    await exited;
    await writeFile(path.join(root, 'sdk-closed'), 'yes');
  }
}
`;

type WorkerState = {
  workerPid: number;
  sdkPid: number;
  taskRoot: string;
  sdkIdleMs: number;
};

async function fixture(mode: 'success' | 'sdk-idle' | 'hang' | 'startup-silent') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-real-worker-test-'));
  const runtimeRoot = path.join(root, 'runtime');
  const packageRoot = path.join(runtimeRoot, 'node_modules', '@deepseek-ai');
  for (const [name, version] of [
    ['dsh', DSH_RUNTIME_VERSION],
    ['dsh-sdk-client', DSH_CLIENT_VERSION],
    ['dsh-llm-pi-ai', DSH_RUNTIME_VERSION],
    ['dsh-attachment-local', DSH_RUNTIME_VERSION],
  ]) {
    const directory = path.join(packageRoot, name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', version }));
  }
  const sdkDirectory = path.join(packageRoot, 'dsh-sdk-client', 'lib');
  await mkdir(sdkDirectory);
  await writeFile(path.join(sdkDirectory, 'index.js'), MOCK_SDK);
  await writeFile(path.join(runtimeRoot, 'scenario.json'), JSON.stringify({ mode, silenceMs: 120 }));
  const workerPath = path.join(root, 'worker.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../electron/dsh-worker.ts', import.meta.url))],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  const manager = new DshManager(workerPath, runtimeRoot, process.execPath);
  const active: Promise<unknown>[] = [];
  const request: DshCompletionRequest = {
    requestId: `worker-${mode}`,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'fake-never-sent',
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'local fixture' }],
    maxTokens: 128,
    thinking: 'default',
    timeoutMs: 2_000,
    connectionTimeoutMs: 40,
    streamStallTimeoutMs: 20,
  };
  return {
    runtimeRoot,
    manager,
    request,
    run(overrides: Partial<DshCompletionRequest> = {}, progress: (value: DshProgress) => void = () => {}) {
      const pending = manager.run(7, { ...request, ...overrides }, progress);
      active.push(pending);
      void pending.catch(() => {});
      return pending;
    },
    async state(): Promise<WorkerState> {
      return JSON.parse(await readFile(path.join(runtimeRoot, 'worker-state.json'), 'utf8')) as WorkerState;
    },
    async cleanup() {
      await manager.close();
      await Promise.allSettled(active);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  for (;;) {
    try { await access(file); return; } catch { /* worker not ready */ }
    if (Date.now() >= deadline) throw new Error('mock SDK did not reach expected stage');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function assertReaped(value: Awaited<ReturnType<typeof fixture>>) {
  const state = await value.state();
  await access(path.join(value.runtimeRoot, 'sdk-closed'));
  await assert.rejects(access(state.taskRoot));
  for (const pid of [state.workerPid, state.sdkPid]) {
    assert.throws(() => process.kill(pid, 0), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

void test('real worker accepts status-only silence longer than SDK idle before a complete result', { timeout: 5_000 }, async () => {
  const value = await fixture('success');
  try {
    const partials: string[] = [];
    assert.deepEqual(await value.run({}, progress => {
      if (progress.content) partials.push(progress.content);
    }), { content: 'complete answer', finishReason: 'stop' });
    assert.deepEqual(partials, ['complete answer']);
    assert.equal((await value.state()).sdkIdleMs, 20, 'real network idle policy stays delegated to SDK');
    await assertReaped(value);
  } finally { await value.cleanup(); }
});

void test('real worker retains the first-notification startup timeout', { timeout: 5_000 }, async () => {
  const value = await fixture('startup-silent');
  try {
    const startedAt = Date.now();
    await assert.rejects(value.run(), (error: unknown) => error instanceof DshError && error.code === 'timeout');
    assert.ok(Date.now() - startedAt < 1_000, 'startup timeout must precede the 2-second total deadline');
    await assertReaped(value);
  } finally { await value.cleanup(); }
});

void test('real worker forwards an SDK network idle error without private response text', { timeout: 5_000 }, async () => {
  const value = await fixture('sdk-idle');
  try {
    await assert.rejects(value.run(), (error: unknown) => error instanceof DshError
      && error.code === 'timeout' && !error.message.includes('private-sdk-body'));
    await access(path.join(value.runtimeRoot, 'sdk-idle-reported'));
    await assertReaped(value);
  } finally { await value.cleanup(); }
});

void test('manager total deadline still terminates and reaps a silent real worker and SDK child', { timeout: 5_000 }, async () => {
  const value = await fixture('hang');
  try {
    const pending = value.run({ timeoutMs: 500 });
    await waitForFile(path.join(value.runtimeRoot, 'status-delivered'));
    await assert.rejects(pending, (error: unknown) => error instanceof DshError && error.code === 'timeout');
    await assertReaped(value);
  } finally { await value.cleanup(); }
});

void test('owner cancellation during notification silence still reaps the real worker and SDK child', { timeout: 5_000 }, async () => {
  const value = await fixture('hang');
  try {
    const partials: string[] = [];
    const pending = value.run({}, progress => { if (progress.content) partials.push(progress.content); });
    await waitForFile(path.join(value.runtimeRoot, 'status-delivered'));
    const startedAt = Date.now();
    value.manager.cancel(7, value.request.requestId);
    await assert.rejects(pending, (error: unknown) => error instanceof DshError && error.code === 'cancelled');
    assert.ok(Date.now() - startedAt < 1_000, 'cancellation must not wait for total timeout');
    assert.deepEqual(partials, []);
    await assertReaped(value);
  } finally { await value.cleanup(); }
});
