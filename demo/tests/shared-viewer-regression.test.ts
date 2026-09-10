import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const demoRoot = path.resolve(import.meta.dirname, '..');
const electronBinary = require('electron') as string;
const BROWSER_RESULT_MARKER = 'YEYU_SHARED_VIEWER_RESULT';
const BROWSER_TIMEOUT_MS = 90_000;

type MockMode = 'normal' | 'race' | 'fail' | 'pdf-switch';

const MOCK_PDFJS = `
export async function loadPdfjs() {
  const page = (pageNumber) => ({
    getViewport: ({ scale }) => ({
      width: 600 * scale,
      height: 840 * scale,
    }),
    render: () => ({
      promise: Promise.resolve(),
      cancel() {},
    }),
    getTextContent: async () => ({ items: [] }),
    pageNumber,
  });
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    TextLayer: class {
      constructor() {}
      async render() {}
      cancel() {}
    },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 6,
        getPage: async (pageNumber) => page(pageNumber),
      }),
    }),
  };
}
`;

const BROWSER_ENTRY = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SharedCourseViewer } from '@/components/shared-course-viewer';

const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

async function waitFor(description, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error('等待超时：' + description);
}

function buttonWithText(text) {
  const button = [...document.querySelectorAll('button')].find(
    (element) =>
      element.textContent?.includes(text) ||
      element.getAttribute('aria-label')?.includes(text),
  );
  if (!button) {
    throw new Error(
      '找不到按钮：' +
        text +
        '(innerWidth=' +
          window.innerWidth +
          ', body=' +
          document.body.textContent?.slice(0, 300) +
          ')',
    );
  }
  return button;
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function courseHeading() {
  return document.querySelector('h1')?.textContent?.trim() ?? '';
}

function clickCourse(name) {
  const button = [...document.querySelectorAll('button')].find(
    (element) => element.textContent?.trim().startsWith(name),
  );
  if (!button) throw new Error('找不到课程按钮：' + name);
  button.click();
}

function assertRect(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPageVisible(stage, page) {
  const stageRect = stage.getBoundingClientRect();
  const pageRect = page.getBoundingClientRect();
  assertRect(
    pageRect.top < stageRect.bottom && pageRect.bottom > stageRect.top,
    '目标 PDF 页面没有进入可视区域',
  );
  return {
    scrollTop: stage.scrollTop,
    pageTop: pageRect.top,
    stageTop: stageRect.top,
  };
}

async function openSourceAndAssertScroll() {
  await waitFor(
    '登录表单',
    () => document.querySelector('input[type="password"]') instanceof HTMLInputElement,
  );
  const input = document.querySelector('input[type="password"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('找不到密码输入框');
  setInputValue(input, 'test-password');
  buttonWithText('登录查看').click();
  await waitFor('课程 A 详情', () => courseHeading() === '课程 A');
  buttonWithText('打开文档并跳转').click();
  await waitFor(
    'PDF 第 3 页完成渲染',
    () => {
      const canvas = document.querySelector(
        'canvas[aria-label="第 3 页内容"]',
      );
      return canvas instanceof HTMLCanvasElement && canvas.width > 0;
    },
  );
  const stage = document.querySelector('[aria-label="PDF 连续阅读画布"]');
  const page = document.querySelector('[data-page="3"]');
  if (!(stage instanceof HTMLElement) || !(page instanceof HTMLElement)) {
    throw new Error('PDF 页面布局未完成');
  }
  await waitFor('来源 PDF 第 3 页进入可视区域', () => {
    const stageRect = stage.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    return (
      pageRect.top < stageRect.bottom &&
      pageRect.bottom > stageRect.top &&
      stage.scrollTop > 0
    );
  });
  const position = assertPageVisible(stage, page);
  assertRect(position.scrollTop > 0, '来源页跳转没有改变 PDF 阅读区域滚动位置');
  return { sourcePage: 3, ...position };
}

async function assertNarrowArtifacts() {
  await waitFor('窄窗口视口', () => window.innerWidth <= 800);
  const panel = document.querySelector(
    '[aria-label="已有课程成果（窄窗口）"]',
  );
  if (!(panel instanceof HTMLElement)) throw new Error('窄窗口成果面板不存在');
  assertRect(
    getComputedStyle(panel).display !== 'none',
    '窄窗口成果面板被隐藏且没有替代入口',
  );
  assertRect(
    panel.textContent?.includes('课程 A PDF 摘要') ?? false,
    '窄窗口没有显示 PDF 总结内容',
  );
  const mindmapTab = [...document.querySelectorAll('[role="tab"]')].find(
    (element) => element.textContent?.includes('PDF 脑图'),
  );
  if (!(mindmapTab instanceof HTMLElement)) throw new Error('找不到 PDF 脑图标签');
  mindmapTab.click();
  await waitFor('窄窗口 PDF 脑图内容', () =>
    panel.textContent?.includes('A 脑图概念') ?? false,
  );
  return {
    viewportWidth: window.innerWidth,
    panelVisible: true,
    mindmapVisible: true,
  };
}

async function assertZoomAndLazyPage() {
  await waitFor('恢复宽窗口 PDF', () => window.innerWidth >= 1000);
  const stage = document.querySelector('[aria-label="PDF 连续阅读画布"]');
  const page = document.querySelector('[data-page="6"]');
  if (!(stage instanceof HTMLElement) || !(page instanceof HTMLElement)) {
    throw new Error('找不到未读 PDF 页面');
  }
  buttonWithText('放大').click();
  await waitFor('PDF 缩放到 105%', () => document.body.textContent?.includes('105%'));
  stage.scrollTo({ top: page.offsetTop, behavior: 'auto' });
  stage.dispatchEvent(new Event('scroll', { bubbles: true }));
  await waitFor(
    '缩放后滚动到第 6 页并完成渲染',
    () => {
      const canvas = document.querySelector(
        'canvas[aria-label="第 6 页内容"]',
      );
      return canvas instanceof HTMLCanvasElement && canvas.width > 0;
    },
  );
  const position = assertPageVisible(stage, page);
  return { viewportWidth: window.innerWidth, lazyPage: 6, ...position };
}

async function assertCourseRace() {
  buttonWithText('返回课程').click();
  await waitFor('返回课程 A', () => courseHeading() === '课程 A');
  await fetch('/__test__/mode/race');
  clickCourse('课程 B');
  clickCourse('课程 A');
  await waitFor('乱序响应最终保留课程 A', () => courseHeading() === '课程 A');
  await sleep(450);
  assertRect(courseHeading() === '课程 A', '等待后的课程标题不是课程 A');
  assertRect(
    document.body.textContent?.includes('A 脑图概念') ?? false,
    '乱序响应覆盖了当前课程内容',
  );
  return { selectedCourse: courseHeading(), lateResponseIgnored: true };
}

async function assertCourseFailure() {
  await fetch('/__test__/mode/fail');
  clickCourse('课程 B');
  await waitFor('课程 B 请求失败提示', () =>
    document.body.textContent?.includes('课程 B 详情失败') ?? false,
  );
  assertRect(courseHeading() === '暂无课程', '失败后课程详情没有清空');
  assertRect(
    !(document.body.textContent?.includes('B 脑图概念') ?? false),
    '课程请求失败后仍显示旧课程详情',
  );
  await fetch('/__test__/mode/normal');
  clickCourse('课程 A');
  await waitFor('恢复课程 A', () => courseHeading() === '课程 A');
  return { failedCourseCleared: true, recoveredCourse: courseHeading() };
}

async function assertPdfSwitchRace() {
  await fetch('/__test__/mode/pdf-switch');
  buttonWithText('打开文档并跳转').click();
  clickCourse('课程 B');
  await waitFor('PDF 下载期间切换到课程 B', () => courseHeading() === '课程 B');
  await sleep(500);
  assertRect(courseHeading() === '课程 B', 'PDF 下载期间没有切换到课程 B');
  assertRect(
    document.querySelector('[aria-label="PDF 原文阅读区"]') === null,
    '迟到的课程 A PDF 响应打开了阅读器',
  );
  assertRect(
    !(document.body.textContent?.includes('A 脑图概念') ?? false),
    'PDF 下载竞态后仍显示课程 A 内容',
  );
  return { selectedCourse: courseHeading(), latePdfIgnored: true };
}

const steps = {
  'open-source': openSourceAndAssertScroll,
  'narrow-artifacts': assertNarrowArtifacts,
  'zoom-lazy-page': assertZoomAndLazyPage,
  'course-race': assertCourseRace,
  'course-failure': assertCourseFailure,
  'pdf-switch-race': assertPdfSwitchRace,
};

window.__runSharedViewerStep = async (name) => {
  const step = steps[name];
  if (!step) throw new Error('未知测试步骤：' + name);
  return step();
};

createRoot(document.getElementById('root')).render(
  React.createElement(SharedCourseViewer),
);
`;

const BROWSER_STYLE = `
  * { box-sizing: border-box; }
  html, body, #root { width: 100%; height: 100%; margin: 0; }
  body { font-family: sans-serif; color: #172033; }
  button, input { font: inherit; }
  button { min-height: 30px; }
  main { height: 100vh; }
  main:has([aria-label="PDF 连续阅读画布"]) {
    display: flex;
    flex-direction: column;
  }
  main:has([aria-label="PDF 连续阅读画布"]) > section {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
  }
  main:has([aria-label="PDF 连续阅读画布"]) > section > div {
    display: flex;
    min-height: 0;
    flex: 1;
  }
  [aria-label="PDF 原文阅读区"] {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
    flex-direction: column;
  }
  .reader-workspace { display: flex; min-height: 0; flex: 1; }
  .thumbnail-sidebar { width: 118px; flex: 0 0 auto; }
  [aria-label="PDF 连续阅读画布"] {
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow: auto;
    padding: 12px;
  }
  .document-pages { display: flex; flex-direction: column; align-items: center; }
  [data-page] { flex: 0 0 auto; margin: 0 auto 16px; background: white; }
  [data-page] > div { background: white; }
  [aria-label="已有课程成果"] { display: none; }
  [aria-label="已有课程成果（窄窗口）"] {
    display: flex;
    max-height: 38vh;
    flex-direction: column;
    overflow: auto;
  }
  @media (min-width: 1024px) {
    [aria-label="已有课程成果"] { display: flex; }
    [aria-label="已有课程成果（窄窗口）"] { display: none; }
  }
`;

interface MockCourse {
  id: string;
  name: string;
  documentId: string;
  documentName: string;
  concept: string;
  sourcePage: number;
}

const MOCK_COURSES: MockCourse[] = [
  {
    id: 'course-a',
    name: '课程 A',
    documentId: 'doc-a',
    documentName: 'A 讲义.pdf',
    concept: 'A 脑图概念',
    sourcePage: 3,
  },
  {
    id: 'course-b',
    name: '课程 B',
    documentId: 'doc-b',
    documentName: 'B 讲义.pdf',
    concept: 'B 脑图概念',
    sourcePage: 2,
  },
];

function mockCourse(course: MockCourse) {
  const document = {
    id: course.documentId,
    fingerprint: `${course.id}-fingerprint`,
    fileName: course.documentName,
    storedFileName: course.documentName,
    pageCount: 6,
    status: 'course-merged',
    includedInCourse: true,
    includeConversationInsights: false,
    hasSummary: true,
    hasMindmap: true,
    importedAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T01:00:00.000Z',
  };
  const source = {
    documentId: course.documentId,
    fileName: course.documentName,
    pageStart: course.sourcePage,
    type: 'pdf',
  };
  const knowledge = {
    schemaVersion: 2,
    courseId: course.id,
    version: 1,
    nodes: [
      {
        id: `course:${course.id}`,
        label: course.name,
        description: `${course.name} 总结`,
        kind: 'course',
        ownership: 'generated',
        sources: [],
      },
      {
        id: `${course.id}-concept`,
        label: course.concept,
        description: `${course.name} 当前课程内容`,
        kind: 'concept',
        ownership: 'generated',
        sources: [source],
      },
    ],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
    updatedAt: '2026-09-10T01:00:00.000Z',
  };
  const digest = {
    schemaVersion: 2,
    documentId: course.documentId,
    fingerprint: `${course.id}-fingerprint`,
    title: `${course.name} PDF 总结`,
    overview: `${course.name} PDF 摘要`,
    sections: [
      {
        id: `${course.id}-section`,
        title: '来源页回归段落',
        summary: '用于验证来源页定位。',
        pageStart: course.sourcePage,
        pageEnd: course.sourcePage,
      },
    ],
    concepts: [
      {
        id: `${course.id}-concept`,
        label: course.concept,
        description: `${course.name} PDF 脑图概念`,
        sources: [source],
      },
    ],
    relations: [],
    unresolvedQuestions: [],
    sourcePages: [course.sourcePage],
    promptVersion: 'browser-regression',
    updatedAt: '2026-09-10T01:00:00.000Z',
  };
  return {
    manifest: {
      schemaVersion: 1,
      id: course.id,
      name: course.name,
      revision: 1,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T01:00:00.000Z',
      activeKnowledgeVersion: 1,
      documents: [document],
    },
    knowledge,
    digests: { [course.documentId]: digest },
  };
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(Buffer.byteLength(body)));
  response.end(body);
}

function sendEmpty(response: http.ServerResponse, status: number): void {
  response.statusCode = status;
  response.end();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startMockShareServer(bundle: string) {
  let loggedIn = false;
  let mode: MockMode = 'normal';
  const detailCounts = new Map<string, number>();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${BROWSER_STYLE}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
      return;
    }
    if (url.pathname === '/bundle.js') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(bundle);
      return;
    }
    if (url.pathname.startsWith('/__test__/mode/')) {
      const nextMode = url.pathname.slice('/__test__/mode/'.length) as MockMode;
      if (!['normal', 'race', 'fail', 'pdf-switch'].includes(nextMode)) {
        sendJson(response, 400, { error: 'invalid mode' });
        return;
      }
      mode = nextMode;
      detailCounts.clear();
      sendEmpty(response, 204);
      return;
    }
    if (url.pathname === '/api/share/session') {
      if (!loggedIn) {
        sendJson(response, 401, { error: '请先登录。' });
        return;
      }
      sendJson(response, 200, { expiresAt: Date.now() + 3600000 });
      return;
    }
    if (url.pathname === '/api/share/login' && request.method === 'POST') {
      loggedIn = true;
      sendJson(response, 200, { expiresAt: Date.now() + 3600000 });
      return;
    }
    if (url.pathname === '/api/share/logout' && request.method === 'POST') {
      loggedIn = false;
      sendEmpty(response, 204);
      return;
    }
    if (!loggedIn) {
      sendJson(response, 401, { error: '登录已过期。' });
      return;
    }
    if (url.pathname === '/api/share/courses') {
      sendJson(response, 200, {
        courses: MOCK_COURSES.map((course) => ({
          id: course.id,
          name: course.name,
          updatedAt: '2026-09-10T01:00:00.000Z',
          documentCount: 1,
        })),
      });
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const course = MOCK_COURSES.find((item) => item.id === parts[3]);
    if (!course || parts[0] !== 'api' || parts[1] !== 'share') {
      sendJson(response, 404, { error: '不存在。' });
      return;
    }
    const detail = mockCourse(course);
    if (parts.length === 4) {
      const count = (detailCounts.get(course.id) ?? 0) + 1;
      detailCounts.set(course.id, count);
      if (mode === 'fail' && course.id === 'course-b') {
        await wait(40);
        sendJson(response, 503, { error: '课程 B 详情失败' });
        return;
      }
      if (mode === 'race' && course.id === 'course-b') await wait(300);
      if (mode === 'race' && course.id === 'course-a' && count > 1) {
        await wait(20);
      }
      sendJson(response, 200, detail);
      return;
    }
    if (parts.length === 7 && parts[4] === 'documents' && parts[6] === 'file') {
      if (mode === 'pdf-switch' && course.id === 'course-a') await wait(350);
      const body = Buffer.from(`%PDF-${course.id}`);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('Content-Length', String(body.byteLength));
      response.end(body);
      return;
    }
    sendJson(response, 404, { error: '不存在。' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('浏览器回归测试服务没有分配端口。');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const browserSmokeMain = `
const { app, BrowserWindow } = require('electron');
const marker = ${JSON.stringify(BROWSER_RESULT_MARKER)};
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let window;
  let exitCode = 0;
  try {
    window = new BrowserWindow({
      width: 1280,
      height: 900,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await window.loadURL(process.env.YEYU_SHARED_TEST_URL);
    const results = [];
    for (const name of ['open-source', 'narrow-artifacts', 'zoom-lazy-page', 'course-race', 'course-failure', 'pdf-switch-race']) {
      if (name === 'narrow-artifacts') window.setSize(700, 900);
      if (name === 'zoom-lazy-page') window.setSize(1280, 900);
      results.push(await window.webContents.executeJavaScript(
        'window.__runSharedViewerStep(' + JSON.stringify(name) + ')',
        true,
      ));
    }
    process.stdout.write(marker + ' ' + JSON.stringify({ ok: true, results }) + '\\n');
  } catch (error) {
    exitCode = 1;
    process.stdout.write(marker + ' ' + JSON.stringify({ ok: false, error: String(error) }) + '\\n');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(exitCode);
  }
});
`;

function displayAvailable(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? true
    : Boolean(process.env.DISPLAY);
}

async function buildBrowserBundle(directory: string): Promise<string> {
  const pdfjsStubPath = path.join(directory, 'pdfjs-stub.ts');
  await writeFile(pdfjsStubPath, MOCK_PDFJS);
  const result = await build({
    stdin: {
      contents: BROWSER_ENTRY,
      loader: 'tsx',
      resolveDir: demoRoot,
      sourcefile: 'shared-viewer-browser-harness.tsx',
    },
    alias: {
      '@/lib/pdfjs': pdfjsStubPath,
      '@': demoRoot,
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0]!.text;
}

async function launchBrowserRegression(url: string, profileDirectory: string) {
  const launchArgs = [
    '--no-sandbox',
    '--disable-gpu',
    ...(process.platform === 'linux' &&
    process.env.DISPLAY &&
    process.env.WAYLAND_DISPLAY
      ? ['--ozone-platform=x11']
      : []),
    `--user-data-dir=${profileDirectory}`,
    path.join(profileDirectory, 'main.cjs'),
  ];
  await writeFile(path.join(profileDirectory, 'main.cjs'), browserSmokeMain);
  return new Promise<{ stdout: string; stderr: string; result: unknown }>(
    (resolve, reject) => {
      const child = spawn(electronBinary, launchArgs, {
        env: { ...process.env, YEYU_SHARED_TEST_URL: url },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            `浏览器行为测试 ${BROWSER_TIMEOUT_MS}ms 内未结束。\n${stderr}`,
          ),
        );
      }, BROWSER_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = stdout
          .split('\n')
          .find((value) => value.startsWith(BROWSER_RESULT_MARKER));
        if (!line) {
          reject(
            new Error(
              `浏览器行为测试没有结果标记（exit ${code}）。\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
          return;
        }
        resolve({
          stdout,
          stderr,
          result: JSON.parse(line.slice(BROWSER_RESULT_MARKER.length + 1)),
        });
      });
    },
  );
}

const noDisplay = displayAvailable()
  ? false
  : '当前环境没有 DISPLAY，跳过需要真实浏览器窗口的共享查看端行为测试。';

type BrowserBehaviorResults = Array<Record<string, unknown>>;

let browserBehaviorPromise: Promise<BrowserBehaviorResults> | null = null;

function runBrowserBehavior(): Promise<BrowserBehaviorResults> {
  if (!browserBehaviorPromise) {
    browserBehaviorPromise = (async () => {
      const temporary = await mkdtemp(
        path.join(os.tmpdir(), 'yeyu-shared-viewer-'),
      );
      try {
        const bundle = await buildBrowserBundle(temporary);
        const server = await startMockShareServer(bundle);
        try {
          const launched = await launchBrowserRegression(server.url, temporary);
          const result = launched.result as {
            ok: boolean;
            results?: BrowserBehaviorResults;
            error?: string;
          };
          assert.equal(result.ok, true, result.error ?? launched.stdout);
          assert.equal(result.results?.length, 6);
          return result.results ?? [];
        } finally {
          await server.close();
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    })();
  }
  return browserBehaviorPromise;
}

void test(
  'shared source links scroll the actual rendered PDF page',
  { skip: noDisplay },
  async () => {
    const results = await runBrowserBehavior();
    assert.equal(results[0]?.sourcePage, 3);
    assert.ok(Number(results[0]?.scrollTop) > 0);
  },
);

void test(
  'shared reader renders an unread page after resize and zoom',
  { skip: noDisplay },
  async () => {
    const results = await runBrowserBehavior();
    assert.equal(results[2]?.lazyPage, 6);
    assert.ok(Number(results[2]?.scrollTop) > 0);
  },
);

void test(
  'shared reader keeps artifacts operable in a narrow window',
  { skip: noDisplay },
  async () => {
    const results = await runBrowserBehavior();
    assert.equal(results[1]?.panelVisible, true);
    assert.equal(results[1]?.mindmapVisible, true);
  },
);

void test(
  'shared viewer ignores an out-of-order course response',
  { skip: noDisplay },
  async () => {
    const results = await runBrowserBehavior();
    assert.equal(results[3]?.lateResponseIgnored, true);
    assert.equal(results[3]?.selectedCourse, '课程 A');
  },
);

void test(
  'shared viewer clears details after a failed course request',
  { skip: noDisplay },
  async () => {
    const results = await runBrowserBehavior();
    assert.equal(results[4]?.failedCourseCleared, true);
    assert.equal(results[4]?.recoveredCourse, '课程 A');
  },
);

void test(
  'shared viewer ignores a PDF response after switching courses',
  { skip: noDisplay },
  async () => {
    const results = await runBrowserBehavior();
    assert.equal(results[5]?.latePdfIgnored, true);
    assert.equal(results[5]?.selectedCourse, '课程 B');
  },
);
