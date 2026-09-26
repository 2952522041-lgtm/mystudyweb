import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function isActuallyVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.pointerEvents !== 'none' &&
    rect.width > 0 &&
    rect.height > 0
  );
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
  const summaryContent = [...panel.querySelectorAll('[role="tabpanel"]')].find(
    (element) => element.textContent?.includes('课程 A PDF 摘要'),
  );
  assertRect(
    isActuallyVisible(summaryContent),
    '窄窗口没有显示实际可见的 PDF 总结内容',
  );
  const mindmapTab = [...panel.querySelectorAll('[role="tab"]')].find(
    (element) => element.textContent?.includes('PDF 脑图'),
  );
  if (!(mindmapTab instanceof HTMLElement)) throw new Error('找不到 PDF 脑图标签');
  assertRect(
    isActuallyVisible(mindmapTab) && !mindmapTab.hasAttribute('disabled'),
    '窄窗口 PDF 脑图标签不可见或不可点击',
  );
  mindmapTab.focus();
  mindmapTab.click();
  await waitFor('窄窗口 PDF 脑图内容', () => {
    const content = [...panel.querySelectorAll('[role="tabpanel"]')].find(
      (element) => element.textContent?.includes('A 脑图概念'),
    );
    return isActuallyVisible(content);
  });
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

function mockCourse(course: MockCourse, pageCount = 6) {
  const document = {
    id: course.documentId,
    fingerprint: `${course.id}-fingerprint`,
    fileName: course.documentName,
    storedFileName: course.documentName,
    pageCount,
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
    if (
      parts.length === 7 &&
      parts[4] === 'documents' &&
      parts[6] === 'translations'
    ) {
      sendJson(response, 200, {
        translations: [
          {
            schemaVersion: 1,
            documentId: course.documentId,
            fingerprint: `${course.id}-fingerprint`,
            pageNumber: 3,
            sourceHash: 'a'.repeat(64),
            targetLanguage: '简体中文',
            provider: 'test-provider',
            model: 'test-model',
            promptVersion: 4,
            paragraphs: [`${course.name} 第 3 页译文`],
            updatedAt: '2026-09-10T02:00:00.000Z',
          },
          {
            schemaVersion: 1,
            documentId: course.documentId,
            fingerprint: `${course.id}-fingerprint`,
            pageNumber: 6,
            sourceHash: 'b'.repeat(64),
            targetLanguage: '简体中文',
            provider: 'test-provider',
            model: 'test-model',
            promptVersion: 4,
            paragraphs: [`${course.name} 第 6 页译文`],
            updatedAt: '2026-09-10T02:01:00.000Z',
          },
        ],
      });
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

function createFormalMultiPagePdf(pageCount = 6): Buffer {
  const pageObjectIndexes = Array.from(
    { length: pageCount },
    (_, index) => 3 + index,
  );
  const contentObjectIndexes = Array.from(
    { length: pageCount },
    (_, index) => 3 + pageCount + index,
  );
  const fontObjectIndex = 3 + pageCount * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectIndexes.map((index) => `${index} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pageObjectIndexes.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 ${fontObjectIndex} 0 R >> >> /Contents ${contentObjectIndexes[index]} 0 R >>`,
    ),
    ...contentObjectIndexes.map((_, index) => {
      const stream = `BT /F1 22 Tf 40 340 Td (Real PDF page ${index + 1}) Tj ET\nBT /F1 12 Tf 40 300 Td (Shared viewer regression fixture) Tj ET`;
      return `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
    }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let document = '%PDF-1.4\n%\xff\xff\xff\xff\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, 'latin1'));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, 'latin1');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'latin1');
}

async function startFormalShareServer(publicDirectory: string, pdf: Buffer) {
  let loggedIn = false;
  let translationRevision = 0;
  const course = MOCK_COURSES[0]!;
  const detail = mockCourse(course);
  const root = path.resolve(publicDirectory);
  const contentTypes: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.pdf': 'application/pdf',
    '.svg': 'image/svg+xml',
  };
  const sendStatic = async (
    requestPath: string,
    response: http.ServerResponse,
  ) => {
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(
        requestPath === '/' ? '/index.html' : requestPath,
      ).replace(/^\/+/, '');
    } catch {
      sendEmpty(response, 400);
      return;
    }
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      sendEmpty(response, 403);
      return;
    }
    try {
      const file = await readFile(target);
      const extension = path.extname(target).toLowerCase();
      response.statusCode = 200;
      response.setHeader(
        'Content-Type',
        contentTypes[extension] ?? 'application/octet-stream',
      );
      response.setHeader('Content-Length', String(file.byteLength));
      response.end(file);
    } catch {
      sendEmpty(response, 404);
    }
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/share/session') {
      if (!loggedIn) {
        sendJson(response, 401, { error: '请先登录。' });
        return;
      }
      sendJson(response, 200, { expiresAt: Date.now() + 3600000 });
      return;
    }
    if (url.pathname === '/api/share/login' && request.method === 'POST') {
      request.resume();
      loggedIn = true;
      sendJson(response, 200, { expiresAt: Date.now() + 3600000 });
      return;
    }
    if (url.pathname === '/api/share/logout' && request.method === 'POST') {
      request.resume();
      loggedIn = false;
      sendEmpty(response, 204);
      return;
    }
    if (!loggedIn && url.pathname.startsWith('/api/share/')) {
      sendJson(response, 401, { error: '登录已过期。' });
      return;
    }
    if (url.pathname === '/api/share/courses') {
      sendJson(response, 200, {
        courses: [
          {
            id: course.id,
            name: course.name,
            updatedAt: '2026-09-10T01:00:00.000Z',
            documentCount: 1,
          },
        ],
      });
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (
      parts.length === 4 &&
      parts[0] === 'api' &&
      parts[1] === 'share' &&
      parts[2] === 'courses' &&
      parts[3] === course.id
    ) {
      sendJson(response, 200, detail);
      return;
    }
    if (
      parts.length === 7 &&
      parts[0] === 'api' &&
      parts[1] === 'share' &&
      parts[2] === 'courses' &&
      parts[3] === course.id &&
      parts[4] === 'documents' &&
      parts[5] === course.documentId &&
      parts[6] === 'file'
    ) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('Content-Length', String(pdf.byteLength));
      response.end(pdf);
      return;
    }
    if (
      parts.length === 7 &&
      parts[0] === 'api' &&
      parts[1] === 'share' &&
      parts[2] === 'courses' &&
      parts[3] === course.id &&
      parts[4] === 'documents' &&
      parts[5] === course.documentId &&
      parts[6] === 'translations'
    ) {
      sendJson(response, 200, {
        translations: [
          {
            schemaVersion: 1,
            documentId: course.documentId,
            fingerprint: `${course.id}-fingerprint`,
            pageNumber: 6,
            sourceHash: 'c'.repeat(64),
            targetLanguage: '简体中文',
            provider: 'formal-test-provider',
            model: 'formal-test-model',
            promptVersion: 4,
            paragraphs: [`正式真实 PDF 第 6 页译文（响应版本 ${++translationRevision}）`],
            updatedAt: '2026-09-10T02:02:00.000Z',
          },
        ],
      });
      return;
    }
    await sendStatic(url.pathname, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('正式构建浏览器测试服务没有分配端口。');
  }
  return {
    url: `http://127.0.0.1:${address.port}/?yeyu-share=1`,
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

const formalBrowserMain = `
const { app, BrowserWindow } = require('electron');
const marker = ${JSON.stringify(BROWSER_RESULT_MARKER)};
const execute = (window, expression) =>
  window.webContents.executeJavaScript(expression, true);
const setup = String.raw\`(() => {
  const waitFor = async (description, predicate, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('等待超时：' + description);
  };
  const buttonWithText = (text) => {
    const button = [...document.querySelectorAll('button')].find(
      (element) => element.textContent?.includes(text),
    );
    if (!button) throw new Error('找不到按钮：' + text);
    return button;
  };
  const setInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.pointerEvents !== 'none' &&
      rect.width > 0 &&
      rect.height > 0;
  };
  const canvasHasInk = (canvas) => {
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0) return false;
    const context = canvas.getContext('2d');
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhitePixels = 0;
    for (let index = 0; index < data.length; index += 32) {
      if (
        data[index + 3] > 0 &&
        (data[index] < 245 || data[index + 1] < 245 || data[index + 2] < 245)
      ) {
        nonWhitePixels += 1;
        if (nonWhitePixels >= 20) return true;
      }
    }
    return false;
  };
  const pagePosition = (stage, page) => {
    const stageRect = stage.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    if (!(pageRect.top < stageRect.bottom && pageRect.bottom > stageRect.top)) {
      throw new Error('目标 PDF 页面没有进入可视区域');
    }
    return { scrollTop: stage.scrollTop, pageTop: pageRect.top };
  };
  // Observe without changing event order, assertions or deadlines.
  // sendInputEvent queues native input; returning is not a React commit barrier.
  const events = [];
  for (const name of ['pointerdown', 'pointerup', 'click', 'focusin', 'resize']) {
    window.addEventListener(name, (event) => {
      const target = event.target instanceof Element ? event.target : null;
      events.push({ type: name, time: performance.now(), target: target?.textContent?.trim().slice(0, 80),
        x: event.clientX, y: event.clientY, width: window.innerWidth });
      if (events.length > 80) events.shift();
    }, true);
  }
  window.__sharedViewerDiagnostics = () => {
    const panel = document.querySelector('[aria-label="已有课程成果（窄窗口）"]');
    return { events, width: window.innerWidth,
      tabs: [...(panel?.querySelectorAll('[role="tab"]') ?? [])].map((tab) => {
        const rect = tab.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        return { text: tab.textContent, selected: tab.getAttribute('aria-selected'),
          x, y, hit: document.elementFromPoint(x, y)?.closest('[role="tab"]') === tab };
      }),
      panels: [...(panel?.querySelectorAll('[role="tabpanel"]') ?? [])].map((element) => ({
        text: element.textContent?.slice(0, 120), visible: visible(element), hidden: element.hasAttribute('hidden'),
      })),
    };
  };
  window.__formalSharedViewer = {
    async openSource() {
      await waitFor(
        '正式共享页面样式',
        () => [...document.querySelectorAll('link[rel="stylesheet"]')].some(
          (link) => link.getAttribute('href')?.includes('/_next/static/css/'),
        ),
      );
      await waitFor(
        '正式共享登录表单',
        () => document.querySelector('input[type="password"]') instanceof HTMLInputElement,
      );
      const input = document.querySelector('input[type="password"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('找不到密码输入框');
      setInputValue(input, 'test-password');
      buttonWithText('登录查看').click();
      await waitFor('正式页面课程 A', () => document.querySelector('h1')?.textContent?.trim() === '课程 A');
      buttonWithText('打开文档并跳转').click();
      await waitFor('真实 PDF.js 第 3 页绘制', () => {
        const canvas = document.querySelector('canvas[aria-label="第 3 页内容"]');
        return canvasHasInk(canvas);
      });
      const stage = document.querySelector('[aria-label="PDF 连续阅读画布"]');
      const page = document.querySelector('[data-page="3"]');
      if (!(stage instanceof HTMLElement) || !(page instanceof HTMLElement)) {
        throw new Error('正式 PDF 页面布局未完成');
      }
      await waitFor('真实 PDF.js 来源第 3 页进入可视区域', () => {
        const stageRect = stage.getBoundingClientRect();
        const pageRect = page.getBoundingClientRect();
        return pageRect.top < stageRect.bottom &&
          pageRect.bottom > stageRect.top &&
          stage.scrollTop > 0;
      });
      const position = pagePosition(stage, page);
      if (position.scrollTop <= 0) throw new Error('正式页面来源跳转没有滚动阅读区域');
      return { sourcePage: 3, realPdfRendered: true, formalStylesLoaded: true, ...position };
    },
    async reopenDocument() {
      const back = document.querySelector('button[aria-label="返回课程"]');
      if (!(back instanceof HTMLElement)) throw new Error('找不到返回课程按钮');
      back.click();
      await waitFor('返回正式课程 A', () => document.querySelector('h1')?.textContent?.trim() === '课程 A');
      buttonWithText('PDF 资料').click();
      await waitFor('正式课程 PDF 资料按钮', () =>
        [...document.querySelectorAll('button')].some((element) =>
          element.textContent?.includes('打开 PDF'),
        ),
      );
      buttonWithText('打开 PDF').click();
      await waitFor('真实 PDF.js 第 1 页绘制', () => {
        const canvas = document.querySelector('canvas[aria-label="第 1 页内容"]');
        return canvasHasInk(canvas);
      });
      return { reopened: true, firstPageRendered: true };
    },
    async zoomAndPrepareNarrowPanels() {
      await waitFor('窄窗口视口', () => window.innerWidth <= 800);
      const zoom = document.querySelector('button[aria-label="放大"]');
      if (!(zoom instanceof HTMLElement)) throw new Error('找不到放大按钮');
      zoom.click();
      await waitFor('正式 PDF 缩放到 105%', () => document.body.textContent?.includes('105%'));
      const stage = document.querySelector('[aria-label="PDF 连续阅读画布"]');
      const page = document.querySelector('[data-page="6"]');
      if (!(stage instanceof HTMLElement) || !(page instanceof HTMLElement)) {
        throw new Error('找不到正式 PDF 未读页面');
      }
      stage.scrollTo({ top: page.offsetTop, behavior: 'auto' });
      stage.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitFor('正式 PDF 当前页更新为第 6 页', () => {
        const input = document.querySelector('input[inputmode="numeric"]');
        return input instanceof HTMLInputElement && input.value === '6';
      });
      await waitFor('正式 PDF 缩放后第 6 页绘制', () => {
        const canvas = document.querySelector('canvas[aria-label="第 6 页内容"]');
        return canvasHasInk(canvas);
      });
      const position = pagePosition(stage, page);
      const panel = document.querySelector('[aria-label="已有课程成果（窄窗口）"]');
      if (!visible(panel)) throw new Error('正式样式下窄窗口成果面板不可见');
      const mindmapTab = [...panel.querySelectorAll('[role="tab"]')].find(
        (element) => element.textContent?.includes('PDF 脑图'),
      );
      if (!visible(mindmapTab) || mindmapTab.hasAttribute('disabled')) {
        throw new Error('窄窗口面板内 PDF 脑图标签不可见或不可点击');
      }
      const translationTab = [...panel.querySelectorAll('[role="tab"]')].find(
        (element) => element.textContent?.includes('页面翻译'),
      );
      if (!visible(translationTab) || translationTab.hasAttribute('disabled')) {
        throw new Error('窄窗口面板内页面翻译标签不可见或不可点击');
      }
      return {
        lazyPage: 6,
        realLazyPageRendered: true,
        ...position,
        panelVisible: true,
      };
    },
    async prepareNarrowClick(label) {
      let target;
      await waitFor('可点击的窄窗口控件：' + label, () => {
        const panel = document.querySelector('[aria-label="已有课程成果（窄窗口）"]');
        target = [...(panel?.querySelectorAll('button') ?? [])].find((element) =>
          element.getAttribute('aria-label') === label || element.textContent?.trim() === label,
        );
        return visible(target) && !target.hasAttribute('disabled');
      });
      // Measure immediately before each native click, including after a tab's
      // content changed the panel height. Verify the integer input coordinates.
      const rect = target.getBoundingClientRect();
      const x = Math.floor(rect.left + rect.width / 2);
      const y = Math.floor(rect.top + rect.height / 2);
      if (document.elementFromPoint(x, y)?.closest('button') !== target) {
        throw new Error('窄窗口点击命中错误控件：' + label);
      }
      window.__lastNarrowClick = { label, delivered: false };
      window.addEventListener('click', (event) => {
        const actual = event.target instanceof Element ? event.target.closest('button') : null;
        window.__lastNarrowClick.delivered = true;
        window.__lastNarrowClick.correctTarget = actual === target;
      }, { capture: true, once: true });
      return { x, y };
    },
    async assertNarrowClick(label) {
      await waitFor('原生点击送达：' + label, () => window.__lastNarrowClick?.delivered);
      if (window.__lastNarrowClick.label !== label || !window.__lastNarrowClick.correctTarget) {
        throw new Error('原生点击实际目标错误：' + label);
      }
    },
    async waitForMindmapAssertionStarted() {
      await waitFor('脑图断言已在输入送达前启动', () => window.__mindmapAssertionStarted);
    },
    async assertNarrowTranslation() {
      const panel = document.querySelector('[aria-label="已有课程成果（窄窗口）"]');
      await waitFor('窄窗口页面翻译加载完成', () =>
        [...(panel?.querySelectorAll('[role="tabpanel"]') ?? [])].some(
          (element) =>
            element.textContent?.includes('正式真实 PDF 第 6 页译文') &&
            visible(element),
        ),
      );
      const visibleContent = [...(panel?.querySelectorAll('[role="tabpanel"]') ?? [])].find(
        (element) =>
          element.textContent?.includes('正式真实 PDF 第 6 页译文') &&
          visible(element),
      );
      if (!visibleContent) {
        throw new Error(
          '窄窗口页面翻译内容不可见 page=' +
            String(document.querySelector('input')?.value) +
            ' tabs=' +
            [...(panel?.querySelectorAll('[role="tab"]') ?? [])]
              .map((element) =>
                String(element.textContent) + ':' +
                String(element.getAttribute('aria-selected')),
              )
              .join('|') +
            ' contents=' +
            [...(panel?.querySelectorAll('[role="tabpanel"]') ?? [])]
              .map((element) =>
                String(element.getAttribute('data-state')) + ':' +
                String(element.textContent?.slice(0, 120)),
              )
              .join('|'),
        );
      }
      await waitFor('页面翻译刷新按钮可用', () => {
        const button = panel?.querySelector('button[aria-label="刷新译文"]');
        return visible(button) && !button?.hasAttribute('disabled');
      });
      const refreshButton = panel?.querySelector('button[aria-label="刷新译文"]');
      if (!visible(refreshButton) || refreshButton.hasAttribute('disabled')) {
        throw new Error('页面翻译刷新按钮不可见或不可点击');
      }
      window.__translationBeforeRefresh = visibleContent.textContent;
      return {
        translationVisible: true,
        page: 6,
        text: visibleContent.textContent,
      };
    },
    async assertNarrowTranslationRefresh() {
      const stage = document.querySelector('[aria-label="PDF 连续阅读画布"]');
      const pageInput = document.querySelector('input[inputmode="numeric"]');
      const panel = document.querySelector('[aria-label="已有课程成果（窄窗口）"]');
      await waitFor('刷新后的窄窗口页面翻译', () =>
        [...(panel?.querySelectorAll('[role="tabpanel"]') ?? [])].some(
          (element) =>
            element.textContent?.includes('正式真实 PDF 第 6 页译文') &&
            element.textContent !== window.__translationBeforeRefresh &&
            visible(element),
        ),
      );
      if (!(stage instanceof HTMLElement) || !(pageInput instanceof HTMLInputElement)) {
        throw new Error('刷新后找不到 PDF 阅读状态');
      }
      if (pageInput.value !== '6' || !document.body.textContent?.includes('105%')) {
        throw new Error('刷新译文改变了当前页或缩放状态');
      }
      if (stage.scrollTop <= 0) throw new Error('刷新译文改变了 PDF 滚动位置');
      return { page: 6, zoom: 105, scrollPreserved: true };
    },
    async assertNarrowMindmap() {
      const panel = document.querySelector('[aria-label="已有课程成果（窄窗口）"]');
      window.__mindmapAssertionStarted = true;
      const startedBeforeInput = !window.__lastNarrowClick?.delivered;
      // Native input delivery and React's commit are separate asynchronous work.
      // Observe BOTH the selected tab and its visible content before asserting.
      await waitFor('窄窗口脑图标签选中且内容可见', () => {
        const tab = [...(panel?.querySelectorAll('[role="tab"]') ?? [])].find(
          (element) => element.textContent?.includes('PDF 脑图'),
        );
        return tab?.getAttribute('aria-selected') === 'true' &&
          [...(panel?.querySelectorAll('[role="tabpanel"]') ?? [])].some(
            (element) => element.textContent?.includes('A 脑图概念') && visible(element),
          );
      });
      const visibleContent = [...(panel?.querySelectorAll('[role="tabpanel"]') ?? [])].find(
        (element) => element.textContent?.includes('A 脑图概念') && visible(element),
      );
      if (!visibleContent) {
        const tabs = [...(panel?.querySelectorAll('[role="tab"]') ?? [])]
          .map(
            (element) =>
              String(element.textContent?.trim()) +
              ':' +
              (element.getAttribute('data-active') ??
                element.getAttribute('aria-selected')),
          )
          .join('|');
        const contents = [...(panel?.querySelectorAll('[role="tabpanel"]') ?? [])]
          .map(
            (element) =>
              String(element.getAttribute('data-state')) +
              ':' +
              element.hasAttribute('hidden') +
              ':' +
              String(element.textContent?.slice(0, 80)),
          )
          .join('|');
        throw new Error(
          '窄窗口切换后 PDF 脑图内容不可见 tabs=' +
            tabs +
            ' contents=' +
            contents,
        );
      }
      return { mindmapVisible: true, contentVisible: true, startedBeforeInput };
    },
  };
})()\`;
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
    await execute(window, setup);
    const source = await execute(window, 'window.__formalSharedViewer.openSource()');
    const reopened = await execute(window, 'window.__formalSharedViewer.reopenDocument()');
    window.setSize(700, 900);
    const narrow = await execute(window, 'window.__formalSharedViewer.zoomAndPrepareNarrowPanels()');
    const click = async (label, point) => {
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      await execute(window, 'window.__formalSharedViewer.assertNarrowClick(' + JSON.stringify(label) + ')');
    };
    const prepare = (label) => execute(window,
      'window.__formalSharedViewer.prepareNarrowClick(' + JSON.stringify(label) + ')');
    await click('页面翻译', await prepare('页面翻译'));
    const translation = await execute(window, 'window.__formalSharedViewer.assertNarrowTranslation()');
    await click('刷新译文', await prepare('刷新译文'));
    const refreshedTranslation = await execute(window, 'window.__formalSharedViewer.assertNarrowTranslationRefresh()');
    const mindmapPoint = await prepare('PDF 脑图');
    // Force the previously flaky ordering: start checking while translation is
    // still selected, then deliver exactly one native click. No timing sleeps.
    const [mindmap] = await Promise.all([
      execute(window, 'window.__formalSharedViewer.assertNarrowMindmap()'),
      (async () => {
        await execute(window, 'window.__formalSharedViewer.waitForMindmapAssertionStarted()');
        await click('PDF 脑图', mindmapPoint);
      })(),
    ]);
    process.stdout.write(marker + ' ' + JSON.stringify({ ok: true, source, reopened, narrow, translation, refreshedTranslation, mindmap, diagnostics: await execute(window, 'window.__sharedViewerDiagnostics()') }) + '\\n');
  } catch (error) {
    exitCode = 1;
    process.stdout.write(marker + ' ' + JSON.stringify({ ok: false, error: String(error), diagnostics: await execute(window, 'window.__sharedViewerDiagnostics?.()').catch(() => null) }) + '\\n');
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

async function launchBrowserRegression(
  url: string,
  profileDirectory: string,
  mainScript = browserSmokeMain,
) {
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
  await writeFile(path.join(profileDirectory, 'main.cjs'), mainScript);
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
          assert.equal(result.ok, true, JSON.stringify(result));
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

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `正式构建浏览器测试的桌面 Web 构建失败（exit ${code}）。\n${output}`,
        ),
      );
    });
  });
}

type FormalBrowserResult = {
  diagnostics?: { events: Array<{ type: string }>; tabs: Array<{ hit: boolean }> };
  source?: {
    sourcePage?: number;
    realPdfRendered?: boolean;
    formalStylesLoaded?: boolean;
    scrollTop?: number;
  };
  reopened?: { reopened?: boolean; firstPageRendered?: boolean };
  narrow?: {
    lazyPage?: number;
    realLazyPageRendered?: boolean;
    panelVisible?: boolean;
    scrollTop?: number;
  };
  translation?: {
    translationVisible?: boolean;
    page?: number;
    text?: string;
  };
  refreshedTranslation?: {
    page?: number;
    zoom?: number;
    scrollPreserved?: boolean;
  };
  mindmap?: { mindmapVisible?: boolean; contentVisible?: boolean; startedBeforeInput?: boolean };
};

let formalBrowserPromise: Promise<FormalBrowserResult> | null = null;

function runFormalBrowserBehavior(): Promise<FormalBrowserResult> {
  if (!formalBrowserPromise) {
    formalBrowserPromise = (async () => {
      const temporary = await mkdtemp(
        path.join(os.tmpdir(), 'yeyu-formal-shared-viewer-'),
      );
      try {
        const packageManager =
          process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
        await runCommand(packageManager, ['desktop:web'], demoRoot);
        const pdf = createFormalMultiPagePdf();
        const server = await startFormalShareServer(
          path.join(demoRoot, 'dist', 'client'),
          pdf,
        );
        try {
          const launched = await launchBrowserRegression(
            server.url,
            temporary,
            formalBrowserMain,
          );
          const result = launched.result as {
            ok: boolean;
            source?: FormalBrowserResult['source'];
            reopened?: FormalBrowserResult['reopened'];
            narrow?: FormalBrowserResult['narrow'];
            mindmap?: FormalBrowserResult['mindmap'];
            error?: string;
          };
          assert.equal(result.ok, true, JSON.stringify(result));
          return result;
        } finally {
          await server.close();
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    })();
  }
  return formalBrowserPromise;
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

void test(
  'formal build browser flow renders real PDF.js pages and narrow artifacts',
  { skip: noDisplay },
  async () => {
    const result = await runFormalBrowserBehavior();
    assert.equal(result.source?.sourcePage, 3);
    assert.equal(result.source?.realPdfRendered, true);
    assert.equal(result.source?.formalStylesLoaded, true);
    assert.ok(Number(result.source?.scrollTop) > 0);
    assert.equal(result.reopened?.firstPageRendered, true);
    assert.equal(result.narrow?.lazyPage, 6);
    assert.equal(result.narrow?.realLazyPageRendered, true);
    assert.equal(result.narrow?.panelVisible, true);
    assert.ok(Number(result.narrow?.scrollTop) > 0);
    assert.equal(result.translation?.translationVisible, true);
    assert.equal(result.translation?.page, 6);
    assert.equal(result.refreshedTranslation?.page, 6);
    assert.equal(result.refreshedTranslation?.zoom, 105);
    assert.equal(result.refreshedTranslation?.scrollPreserved, true);
    assert.equal(result.mindmap?.mindmapVisible, true);
    assert.equal(result.mindmap?.contentVisible, true);
    assert.ok(result.diagnostics?.events.some((event) => event.type === 'click'), '原生点击诊断应记录真实事件');
    assert.ok(result.diagnostics?.tabs.every((tab) => tab.hit), '窄窗口标签中心应命中对应标签');
  },
);

void test(
  'narrow mindmap assertion waits for native input delivery and the React commit',
  { skip: noDisplay },
  async () => {
    const result = await runFormalBrowserBehavior();
    assert.equal(result.mindmap?.startedBeforeInput, true);
    assert.equal(result.mindmap?.contentVisible, true);
  },
);
