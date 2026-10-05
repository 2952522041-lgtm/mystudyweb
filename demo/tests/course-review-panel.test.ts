import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { stageCourseReviewBundle } from '../lib/course-storage/course-review.ts';
import type {
  AiCourseKnowledge,
  CourseBundle,
  CourseKnowledge,
  DocumentDigest,
  DocumentRecord,
  SourceReference,
} from '../lib/course-storage/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

const NOW = '2026-01-02T03:04:05.000Z';

function source(documentId: string, page = 1): SourceReference {
  return {
    documentId,
    fileName: `${documentId}.pdf`,
    pageStart: page,
    type: 'pdf',
  };
}

function digest(
  documentId: string,
  fingerprint: string,
  title: string,
): DocumentDigest {
  return {
    schemaVersion: 3,
    documentId,
    fingerprint,
    title,
    overview: `${title} 概览`,
    sections: [],
    concepts: [],
    relations: [],
    unresolvedQuestions: [],
    sourcePages: [1],
    promptVersion: 'test-v1',
    updatedAt: NOW,
  };
}

function document(
  id: string,
  overrides: Partial<DocumentRecord> = {},
): DocumentRecord {
  return {
    id,
    fingerprint: `${id}-fp`,
    fileName: `${id}.pdf`,
    storedFileName: `${id}.pdf`,
    pageCount: 3,
    status: 'document-artifacts-ready',
    includedInCourse: false,
    includeConversationInsights: false,
    hasSummary: true,
    hasMindmap: true,
    importedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function knowledge(): CourseKnowledge {
  return {
    schemaVersion: 3,
    courseId: 'course-1',
    version: 2,
    nodes: [
      {
        id: 'root',
        label: '课程',
        description: '课程总知识入口。',
        kind: 'course',
        ownership: 'generated',
        sources: [],
      },
      {
        id: 'user-note',
        label: '用户笔记',
        description: '用户手工保留的节点。',
        kind: 'insight',
        ownership: 'user',
        sources: [],
      },
      {
        id: 'gen-a',
        label: '概念 A',
        description: '生成的概念。',
        kind: 'concept',
        ownership: 'generated',
        sources: [source('doc-a')],
      },
    ],
    relations: [],
    conflicts: [],
    updatedAt: NOW,
  };
}

function aiKnowledge(): AiCourseKnowledge {
  return {
    theme: '课程主题',
    nodes: [
      {
        id: 'ai-b',
        label: '概念 B',
        description: '候选概念 B。',
        sources: [source('doc-b')],
      },
    ],
    relations: [{ from: 'root', to: 'ai-b', label: '包含' }],
    conflicts: [],
    unresolvedQuestions: ['候选问题？'],
    provider: 'provider',
    model: 'model',
    promptVersion: 'prompt-v1',
  };
}

function baseBundle(): CourseBundle {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'course-1',
      name: '课程',
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
      activeKnowledgeVersion: 2,
      documents: [
        document('doc-a', { includedInCourse: true, status: 'course-merged' }),
        document('doc-b'),
        document('doc-raw', { status: 'selected' }),
      ],
    },
    knowledge: knowledge(),
    digests: {
      'doc-a': digest('doc-a', 'doc-a-fp', '文档 A'),
      'doc-b': digest('doc-b', 'doc-b-fp', '文档 B'),
    },
  };
}

async function fixtures() {
  const valid = await stageCourseReviewBundle(
    baseBundle(),
    ['doc-b'],
    aiKnowledge(),
    { id: 'review-1', now: NOW },
  );
  const staleBase = await stageCourseReviewBundle(
    baseBundle(),
    ['doc-b'],
    aiKnowledge(),
    { id: 'review-stale', now: NOW },
  );
  const stale: CourseBundle = {
    ...staleBase,
    knowledge: {
      ...staleBase.knowledge,
      nodes: staleBase.knowledge.nodes.map((node) =>
        node.id === 'gen-a' ? { ...node, label: '改过的概念' } : node,
      ),
    },
  };
  const second = await stageCourseReviewBundle(
    baseBundle(),
    ['doc-b'],
    aiKnowledge(),
    { id: 'review-2', now: NOW },
  );
  return { valid, stale, second };
}

function entryScript(data: {
  valid: CourseBundle;
  stale: CourseBundle;
  second: CourseBundle;
}): string {
  return `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CourseReviewPanel} from '@/components/course-review-panel';

const fixtures = ${JSON.stringify(data)};
let calls = [];
let mode = 'ok';
let releasePending = null;

function App() {
  const [bundle, setBundle] = useState(fixtures.valid);
  window.__show = (next) => setBundle(next);
  return <CourseReviewPanel bundle={bundle} onResolve={async (id, accept) => {
    calls.push([id, accept]);
    if (mode === 'throw') throw new Error('候选处理失败');
    if (mode === 'pending') await new Promise((resolve) => { releasePending = resolve; });
  }} />;
}
window.__setMode = (value) => { mode = value; };
window.__releasePending = () => { const release = releasePending; releasePending = null; if (release) release(); };
window.__calls = () => calls;
createRoot(document.getElementById('root')).render(<App />);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const panel = () => document.querySelector('section[aria-label="课程更新审阅"]');
const button = (label) => [...(panel()?.querySelectorAll('button') || [])].find((node) => node.textContent.trim() === label);
const toggle = () => panel()?.querySelector('button[aria-controls]');
const previewRegion = () => { const node = toggle(); return node ? document.getElementById(node.getAttribute('aria-controls')) : null; };
const check = (value, message) => { if (!value) throw new Error(message); };
async function waitFor(label, predicate) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await sleep(20); }
  throw new Error('Timeout: ' + label + ' ' + document.body.textContent);
}
const visible = (node) => typeof node.checkVisibility === 'function' ? node.checkVisibility() : !!node.offsetParent;

window.runCourseReviewPanelRegression = async () => {
  await waitFor('panel', () => panel());
  await waitFor('validation settles', () => !button('接受更新').disabled);

  check(document.body.textContent.includes('课程更新等待审阅'), 'heading missing');
  check(document.body.textContent.includes('PDF') && document.body.textContent.includes('成果文件'), 'preservation guidance missing');
  check(document.body.textContent.includes('新增 1 个知识点 · 修改 1 个 · 移除 1 个'), 'knowledge change counts missing: ' + panel().textContent);

  const start = toggle();
  check(start, 'preview toggle missing');
  check(start.textContent.trim() === '查看更新预览', 'default toggle label wrong: ' + start.textContent);
  check(start.getAttribute('aria-expanded') === 'false', 'toggle must start collapsed');
  const controls = start.getAttribute('aria-controls');
  check(controls, 'toggle lacks aria-controls');
  const region = previewRegion();
  check(region, 'aria-controls must point at a preview region');
  check(region.tagName === 'SECTION' && region.getAttribute('aria-label') === '课程更新预览', 'preview must have an accessible region name');
  check(region.hidden === true, 'preview region must start hidden');
  const collapsedFocusable = [...region.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')];
  check(collapsedFocusable.every((node) => !visible(node)), 'collapsed preview must not be keyboard focusable');

  const accept = button('接受更新');
  const discard = button('保留原成果');
  check(accept && discard, 'resolution actions missing');
  check(!region.contains(accept) && !region.contains(discard), 'actions must live outside the preview region');
  check(accept.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING, 'accept must precede preview');
  check(discard.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING, 'discard must precede preview');

  start.focus();
  check(document.activeElement === start, 'precondition: toggle focused');
  start.click();
  await waitFor('expanded', () => toggle().getAttribute('aria-expanded') === 'true');
  check(toggle().textContent.trim() === '收起更新预览', 'expanded toggle label wrong: ' + toggle().textContent);
  check(previewRegion().hidden === false, 'preview region must be visible when expanded');
  check(document.activeElement === toggle(), 'focus must stay on the toggle after expanding');
  check(window.__calls().length === 0, 'expanding must never resolve');
  const regionText = previewRegion().textContent;
  check(regionText.includes('知识结构变化'), 'knowledge structure changes missing');
  check(regionText.includes('概念 B'), 'candidate knowledge node missing from preview');
  check(regionText.includes('总结文字差异'), 'SummaryDiffView missing from preview');
  const scroll = previewRegion().querySelector('[data-preview-scroll="true"]');
  check(scroll, 'bounded scroll preview missing');
  check(!scroll.contains(accept) && !scroll.contains(discard), 'actions must not sit inside the scroll area');
  check(document.activeElement === toggle(), 'expanding preview must not accept');

  toggle().focus();
  toggle().click();
  await waitFor('collapsed again', () => toggle().getAttribute('aria-expanded') === 'false');
  check(toggle().textContent.trim() === '查看更新预览', 'collapsed toggle label wrong');
  check(previewRegion().hidden === true, 'preview region must hide again');
  check(document.activeElement === toggle(), 'focus must stay on the toggle after collapsing');
  check(window.__calls().length === 0, 'toggling the preview must never resolve');

  const validId = fixtures.valid.manifest.pendingReview.id;
  window.__setMode('ok');
  button('接受更新').click();
  await waitFor('accept call', () => window.__calls().length === 1);
  check(JSON.stringify(window.__calls()[0]) === JSON.stringify([validId, true]), 'accept must call onResolve with the exact id and true');
  await waitFor('accept settles', () => !button('接受更新').disabled && !button('保留原成果').disabled);

  button('保留原成果').click();
  await waitFor('discard call', () => window.__calls().length === 2);
  check(JSON.stringify(window.__calls()[1]) === JSON.stringify([validId, false]), 'discard must call onResolve with the exact id and false');
  await waitFor('discard settles', () => !button('保留原成果').disabled);

  window.__setMode('pending');
  button('接受更新').click();
  await waitFor('busy', () => button('接受更新').disabled && button('保留原成果').disabled);
  check(window.__calls().length === 3, 'busy accept did not reach onResolve');
  check(JSON.stringify(window.__calls()[2]) === JSON.stringify([validId, true]), 'busy accept call wrong');
  window.__releasePending();
  await waitFor('idle', () => !button('接受更新').disabled && !button('保留原成果').disabled);

  window.__show(fixtures.stale);
  await waitFor('stale warning', () => panel().textContent.includes('课程内容已变化'));
  check(button('接受更新').disabled, 'stale candidate must disable accept');
  check(!button('保留原成果').disabled, 'stale candidate must still allow discard');
  const staleId = fixtures.stale.manifest.pendingReview.id;
  window.__setMode('ok');
  const beforeStale = window.__calls().length;
  button('保留原成果').click();
  await waitFor('stale discard', () => window.__calls().length === beforeStale + 1);
  check(JSON.stringify(window.__calls()[beforeStale]) === JSON.stringify([staleId, false]), 'stale discard call wrong');

  window.__show(fixtures.valid);
  await waitFor('valid again', () => !button('接受更新').disabled);
  window.__setMode('throw');
  button('保留原成果').click();
  await waitFor('alert', () => document.querySelector('[role="alert"]'));
  check(document.querySelector('[role="alert"]').textContent.includes('候选处理失败'), 'resolution error must surface as alert');
  window.__setMode('ok');

  if (toggle().getAttribute('aria-expanded') !== 'true') {
    toggle().click();
    await waitFor('expanded before switch', () => toggle().getAttribute('aria-expanded') === 'true');
  }
  check(previewRegion().hidden === false, 'precondition: preview expanded');
  window.__show(fixtures.second);
  await waitFor('new candidate collapsed', () => toggle().getAttribute('aria-expanded') === 'false');
  check(previewRegion()?.hidden === true, 'a new candidate id must start collapsed');

  return {calls: window.__calls(), collapsedOnNewCandidate: true};
};
`;
}

void test('course review panel keeps acceptance explicit and preview opt-in', {
  skip:
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !existsSync('/usr/bin/xvfb-run')
      ? 'Requires a display or Xvfb for Chromium interaction tests'
      : false,
}, async () => {
  const data = await fixtures();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-course-review-panel-'));
  const bundle = await build({
    stdin: { contents: entryScript(data), loader: 'tsx', resolveDir: root },
    alias: { '@': root },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const main = path.join(directory, 'main.cjs');
  await writeFile(
    main,
    `
      const {app, BrowserWindow} = require('electron');
      app.disableHardwareAcceleration();
      app.whenReady().then(async () => {
        const win = new BrowserWindow({width: 1280, height: 900, show: true,
          webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
        try {
          await win.loadURL(${JSON.stringify(url)});
          const result = await win.webContents.executeJavaScript('window.runCourseReviewPanelRegression()', true);
          console.log('PANEL_OK ' + JSON.stringify(result)); win.destroy(); app.exit(0);
        } catch (error) { console.error(error); win.destroy(); app.exit(1); }
      });
    `,
  );
  try {
    const electron = require('electron') as string;
    const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
    const args = [
      ...(process.platform === 'linux' && process.env.DISPLAY && process.env.WAYLAND_DISPLAY
        ? ['--ozone-platform=x11']
        : []),
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${directory}/profile`,
      main,
    ];
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        useXvfb ? 'xvfb-run' : electron,
        useXvfb ? ['-a', electron, ...args] : args,
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let logs = '';
      child.stdout.on('data', (buffer: Buffer) => { logs += buffer; });
      child.stderr.on('data', (buffer: Buffer) => { logs += buffer; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(logs)); }, 30000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(logs); else reject(new Error(logs)); });
    });
    const marker = /PANEL_OK (\{[^\n]*\})/.exec(output);
    assert.ok(marker, `missing PANEL_OK marker in: ${output}`);
    const result = JSON.parse(marker[1]) as { calls: Array<[string, boolean]> };
    assert.deepStrictEqual(result.calls, [
      ['review-1', true],
      ['review-1', false],
      ['review-1', true],
      ['review-stale', false],
      ['review-1', false],
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
