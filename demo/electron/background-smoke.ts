/** Opt-in real Electron integration probe, using only the test's temporary
 * workspace and isolated Chromium profile. No model key or API call is used. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { BackgroundService } from './background-service.ts';
import type { WorkspaceLayout } from './workspace-paths.ts';

export const BACKGROUND_SMOKE_MARKER = 'YEYU_BACKGROUND_SMOKE_RESULT';
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 25_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`后台冒烟等待超时：${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
export async function probeBackgroundHost(window: BrowserWindow, service: BackgroundService, workerWindow: () => BrowserWindow | undefined, layout: WorkspaceLayout) {
  const directoryName = '后台宿主冒烟';
  const root = path.join(layout.coursesRoot, directoryName);
  const courseId = 'background-smoke-course';
  const documentId = 'background-smoke-document';
  const now = new Date().toISOString();
  const processing = { status: 'paused', phase: 'document', updatedAt: now, options: { generateSummary: true, generateMindmap: true, mergeIntoCourse: false, includeConversationInsights: false } };
  const manifest = { schemaVersion: 1, id: courseId, name: directoryName, revision: 1, createdAt: now, updatedAt: now, activeKnowledgeVersion: 0,
    documents: [{ id: documentId, fingerprint: 'a'.repeat(64), fileName: 'fixture.pdf', storedFileName: 'fixture.pdf', pageCount: 1, status: 'copied', includedInCourse: false, includeConversationInsights: false, hasSummary: false, hasMindmap: false, importedAt: now, updatedAt: now, processing }],
  };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'course.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, '课程脑图.json'), JSON.stringify({ schemaVersion: 1, courseId, version: 0, theme: directoryName, nodes: [], relations: [], conflicts: [], unresolvedQuestions: [], updatedAt: now }));
  const readManifest = async () => JSON.parse(await fs.readFile(path.join(root, 'course.json'), 'utf8')) as typeof manifest;
  service.start();
  await until(() => service.getSnapshot().available && service.getSnapshot().tasks.some(task => task.documentId === documentId && task.status === 'paused'), '真实后台页面发布磁盘任务');
  const worker = workerWindow();
  assert.ok(worker);
  assert.equal(worker.isVisible(), false);
  assert.equal(new URL(worker.webContents.getURL()).searchParams.get('background-worker'), '1');
  const originalOwner = service.owner;
  const roleBlocked = await window.webContents.executeJavaScript(`(async () => { try { await window.yeyuDesktop.publishBackgroundSnapshot({tasks:[],executor:'desktop',available:true}); return false; } catch { return true; } })()`);
  assert.equal(roleBlocked, true);

  // Freeze only the executor's timer clock while exercising real IPC/file IO.
  // This prevents its 250ms AI scheduler from claiming the synthetic queued
  // fixture before the pause command, without mocking the host or its processor.
  worker.webContents.debugger.attach('1.3');
  try {
    await worker.webContents.debugger.sendCommand('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    await window.webContents.executeJavaScript(`(async () => {
      const api = window.yeyuDesktop;
      const directory = ${JSON.stringify(directoryName)};
      const token = await api.acquireCourseLock(directory);
      try {
        const manifest = JSON.parse(new TextDecoder().decode(await api.readFile(directory,['course.json'])));
        manifest.revision++;
        manifest.documents[0].processing.status = 'queued';
        await api.writeFile(directory,['course.json'],new TextEncoder().encode(JSON.stringify(manifest)));
      } finally { await api.releaseCourseLock(token); }
      await api.controlBackgroundTask({action:'pause',courseId:${JSON.stringify(courseId)},documentId:${JSON.stringify(documentId)}});
    })()`);
    const paused = await readManifest();
    assert.equal(paused.documents[0].processing.status, 'paused');
    assert.ok(paused.revision > 2, 'pause must persist a new revision through the actual hidden processor');
  } finally { if (worker.webContents.debugger.isAttached()) worker.webContents.debugger.detach(); }

  await window.loadURL(window.webContents.getURL());
  assert.equal(service.owner, originalOwner, 'visible reload cannot replace hidden executor');
  assert.equal(worker.isDestroyed(), false);
  await window.webContents.executeJavaScript(`window.yeyuDesktop.controlBackgroundTask({action:'cancel',courseId:${JSON.stringify(courseId)},documentId:${JSON.stringify(documentId)}})`);
  assert.equal((await readManifest()).documents[0].processing.status, 'cancelled');

  let recovered = 0;
  for (let crash = 0; crash < 4; crash++) {
    const active = workerWindow();
    assert.ok(active);
    const owner = service.owner;
    active.webContents.forcefullyCrashRenderer();
    if (crash < 3) {
      await until(() => service.owner !== undefined && service.owner !== owner && service.getSnapshot().available, '崩溃后后台窗口恢复');
      assert.equal(service.getSnapshot().tasks.find(task => task.documentId === documentId)?.status, 'cancelled');
      assert.equal(active.isDestroyed(), true);
      recovered++;
    } else {
      await until(() => service.owner === undefined && /自动恢复已停止/.test(service.getSnapshot().error ?? ''), '重启次数上限');
    }
  }
  assert.equal((await readManifest()).documents[0].processing.status, 'cancelled');
  const unavailable = await window.webContents.executeJavaScript('window.yeyuDesktop.getBackgroundSnapshot()');
  assert.equal(unavailable.available, false);
  service.close();
  assert.equal(workerWindow(), undefined);
  return { ok: true, registered: true, hidden: true, roleBlocked, pausePersisted: true, survivesUiReload: true, cancellationPersisted: true, recovered, boundedRestart: true, closed: true };
}
