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

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const RESULT_MARKER = 'YEYU_SHARED_AUTO_TRANSLATION_RESULT';
const BROWSER_TIMEOUT_MS = 90_000;

const MOCK_PDFJS = `
export async function loadPdfjs() {
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    TextLayer: class { async render() {} cancel() {} },
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1 }) }),
  };
}
`;

/**
 * The browser bundle replaces the real shared client with this fixture. The
 * requests intentionally remain pending until the probe settles them, so an
 * aborted request can still call its resolve callback later.
 */
const MOCK_LAN_SHARE_API = `
function fixture() {
  if (!window.__sharedTranslationFixture) {
    window.__sharedTranslationFixture = {
      calls: [],
      loads: [],
      records: Object.create(null),
      delayedLoads: Object.create(null),
      pendingLoads: Object.create(null),
      nextId: 1,
    };
  }
  return window.__sharedTranslationFixture;
}

fixture();

export class SharedApiError extends Error {
  constructor(status, message, state) {
    super(message);
    this.name = 'SharedApiError';
    this.status = status;
    this.state = state;
  }
}

export function loadSharedTranslations(courseId, documentId) {
  const state = fixture();
  state.loads.push({ courseId, documentId });
  const records = state.records && typeof state.records === 'object' ? state.records : {};
  const translations = Array.isArray(records[documentId]) ? records[documentId] : [];
  if (state.delayedLoads[documentId]) {
    return new Promise((resolve) => {
      (state.pendingLoads[documentId] ||= []).push(() => resolve({ translations }));
    });
  }
  return Promise.resolve({ translations });
}

export function translateSharedPage(
  courseId,
  documentId,
  page,
  targetLanguage,
  bypassCache = false,
  signal,
) {
  const state = fixture();
  const request = {
    id: state.nextId++,
    courseId,
    documentId,
    page,
    targetLanguage,
    bypassCache,
    signal,
    aborted: false,
    settled: false,
  };
  state.calls.push(request);
  const promise = new Promise((resolve, reject) => {
    request.resolve = (paragraphs) => {
      if (request.settled) return;
      request.settled = true;
      const values = Array.isArray(paragraphs) ? paragraphs : [paragraphs];
      resolve({
        translation: {
          pageNumber: page,
          targetLanguage,
          paragraphs: values,
          provider: 'fixture-provider',
          model: 'fixture-model',
          updatedAt: '2026-09-29T00:00:00.000Z',
        },
      });
    };
    request.reject = (message) => {
      if (request.settled) return;
      request.settled = true;
      reject(new Error(message));
    };
  });
  signal?.addEventListener('abort', () => { request.aborted = true; }, { once: true });
  return promise;
}

export const askSharedDocument = () => Promise.reject(new Error('unused fixture API'));
export const clearSharedConversation = () => Promise.resolve();
export const loadSharedConversation = () => Promise.resolve({ conversation: null });
export const loadSharedReadingState = () => Promise.resolve({ state: null });
export const saveSharedReadingState = () => Promise.resolve({ state: null });
`;

const BROWSER_ENTRY = `
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SharedTranslationPanel } from '@/components/shared-pdf-reader';

const root = createRoot(document.getElementById('root'));
const state = window.__sharedTranslationFixture || {
  calls: [],
  loads: [],
  records: Object.create(null),
  delayedLoads: Object.create(null),
  pendingLoads: Object.create(null),
  nextId: 1,
};
window.__sharedTranslationFixture = state;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(description, predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('等待超时：' + description + ' ' + document.body.textContent?.slice(-800));
}

function check(value, message) {
  if (!value) throw new Error(message);
}

function panelText() {
  return document.querySelector('[aria-label="页面翻译面板"]')?.textContent || '';
}

function buttonWithText(text) {
  const button = [...document.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(text),
  );
  if (!button) throw new Error('找不到按钮：' + text + ' body=' + document.body.textContent?.slice(-500));
  return button;
}

function makeRecord(documentId, page, targetLanguage, paragraphs) {
  return {
    schemaVersion: 1,
    documentId,
    fingerprint: 'fixture-' + documentId,
    pageNumber: page,
    sourceHash: String(page).padStart(64, 'a'),
    targetLanguage,
    provider: 'fixture-provider',
    model: 'fixture-model',
    promptVersion: 4,
    paragraphs: Array.isArray(paragraphs) ? paragraphs : [paragraphs],
    updatedAt: '2026-09-28T00:00:00.000Z',
  };
}

function resetFixture(documentId, records = [], delayedLoad = false) {
  state.calls.length = 0;
  state.loads.length = 0;
  state.records = Object.create(null);
  state.delayedLoads = Object.create(null);
  state.pendingLoads = Object.create(null);
  state.records[documentId] = records;
  state.delayedLoads[documentId] = delayedLoad;
  try { localStorage.clear(); } catch {}
}

async function unmount() {
  root.render(null);
  await sleep(45);
}

function mount({ courseId = 'course-fixture', documentId, page = 1, canUseAi = true, active = true }) {
  root.render(React.createElement(
    StrictMode,
    null,
    React.createElement(SharedTranslationPanel, {
      courseId,
      documentId,
      page,
      canUseAi,
      active,
    }),
  ));
}

async function startScenario(documentId, records = [], options = {}) {
  await unmount();
  resetFixture(documentId, records, options.delayedLoad === true);
  mount({ documentId, ...options });
  await waitFor('翻译面板', () => document.querySelector('[aria-label="页面翻译面板"]'));
}

function pendingRequest(index = 0) {
  const request = state.calls[index];
  if (!request) throw new Error('找不到第 ' + (index + 1) + ' 个翻译请求');
  return request;
}

function releaseLoad(documentId) {
  for (const resolve of state.pendingLoads[documentId] || []) resolve();
  delete state.pendingLoads[documentId];
  delete state.delayedLoads[documentId];
}

function setLanguage(value) {
  const input = document.querySelector('[aria-label="译文目标语言"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('找不到目标语言输入框');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function autoMissingAndStrictMode() {
  const documentId = 'auto-strict';
  await startScenario(documentId);
  await waitFor('缓存读取完成', () => !panelText().includes('正在读取译文'));
  await waitFor('缺失页面自动翻译请求', () => state.calls.length === 1);
  await sleep(500);
  const request = pendingRequest();
  check(request.bypassCache === false, '自动翻译必须使用 bypassCache=false');
  check(request.page === 1 && request.documentId === documentId, '自动翻译参数不匹配');
  check(state.calls.length === 1, 'StrictMode 或 effect 重跑产生了重复自动翻译请求');
  request.resolve('自动翻译结果');
  await waitFor('自动翻译结果显示', () => panelText().includes('自动翻译结果'));
  const result = { requestCount: state.calls.length, bypassCache: request.bypassCache, rendered: true };
  await unmount();
  return result;
}

async function publishedCacheSkipsRequest() {
  const documentId = 'published-cache';
  await startScenario(documentId, [makeRecord(documentId, 1, '简体中文', '已发布译文')]);
  await waitFor('已有译文显示', () => panelText().includes('已发布译文'));
  await sleep(500);
  check(state.calls.length === 0, '已有译文仍触发了自动翻译请求');
  const result = { requestCount: state.calls.length, rendered: true };
  await unmount();
  return result;
}

async function inactiveAndNoAiSkipRequest() {
  const inactiveId = 'inactive-panel';
  await startScenario(inactiveId, [], { active: false });
  await waitFor('inactive 缓存读取完成', () => !panelText().includes('正在读取译文'));
  await sleep(650);
  const inactiveRequests = state.calls.length;
  check(inactiveRequests === 0, 'active=false 仍触发了自动翻译');

  const noAiId = 'no-ai-panel';
  await startScenario(noAiId, [], { canUseAi: false });
  await waitFor('无 AI 缓存读取完成', () => !panelText().includes('正在读取译文'));
  await sleep(650);
  const noAiRequests = state.calls.length;
  check(noAiRequests === 0, 'canUseAi=false 仍触发了自动翻译');
  const result = { inactiveRequests, noAiRequests };
  await unmount();
  return result;
}

async function pageAndDocumentRace() {
  const firstDocument = 'race-document-a';
  const secondDocument = 'race-document-b';
  await startScenario(firstDocument);
  await waitFor('第一页请求', () => state.calls.length === 1);
  const first = pendingRequest(0);

  mount({ documentId: firstDocument, page: 2 });
  await waitFor('翻页取消第一页请求', () => first.aborted === true);
  await waitFor('第二页请求', () => state.calls.length === 2);
  const second = pendingRequest(1);
  check(second.page === 2, '翻页后的自动翻译请求页码错误');

  mount({ documentId: secondDocument, page: 1 });
  await waitFor('换文档取消第二页请求', () => second.aborted === true);
  await waitFor('新文档请求', () => state.calls.length === 3);
  const third = pendingRequest(2);
  check(third.documentId === secondDocument, '换文档后的请求仍指向旧文档');

  first.resolve('迟到的第一页旧结果');
  second.resolve('迟到的第二页旧结果');
  await sleep(100);
  check(!document.body.textContent?.includes('迟到的第一页旧结果'), '迟到的旧页结果覆盖了当前状态');
  check(!document.body.textContent?.includes('迟到的第二页旧结果'), '迟到的旧文档结果覆盖了当前状态');
  third.resolve('新文档结果');
  await waitFor('新文档译文显示', () => panelText().includes('新文档结果'));
  const result = { firstAborted: first.aborted, secondAborted: second.aborted, rendered: true };
  await unmount();
  return result;
}

async function languageDebounceAndRace() {
  const documentId = 'language-race';
  await startScenario(documentId);
  await waitFor('默认语言自动请求', () => state.calls.length === 1);
  const first = pendingRequest();
  setLanguage('日');
  await sleep(35);
  setLanguage('日本');
  await sleep(35);
  setLanguage('日本語');
  await waitFor('语言切换取消旧请求', () => first.aborted === true);
  await sleep(200);
  check(state.calls.length === 1, '目标语言 debounce 期间按字符触发了新请求');
  await waitFor('最终语言请求', () => state.calls.length === 2);
  const second = pendingRequest(1);
  check(second.targetLanguage === '日本語', '最终请求没有使用完整目标语言');
  check(second.bypassCache === false, '语言切换自动翻译必须使用 bypassCache=false');
  first.resolve('迟到的默认语言结果');
  await sleep(100);
  check(!panelText().includes('迟到的默认语言结果'), '迟到的旧语言结果覆盖了当前状态');
  second.resolve('日本語结果');
  await waitFor('最终语言译文显示', () => panelText().includes('日本語结果'));
  const result = { firstAborted: first.aborted, requestCount: state.calls.length, language: second.targetLanguage };
  await unmount();
  return result;
}

async function failureAllowsManualRetryWithoutLoop() {
  const documentId = 'failure-retry';
  await startScenario(documentId);
  await waitFor('失败场景自动请求', () => state.calls.length === 1);
  const first = pendingRequest();
  first.reject('fixture translation failure');
  await waitFor('失败提示', () => panelText().includes('fixture translation failure'));
  await sleep(800);
  check(state.calls.length === 1, '失败后自动无限重试');
  buttonWithText('生成译文').click();
  await waitFor('手动重试请求', () => state.calls.length === 2);
  const retry = pendingRequest(1);
  check(retry.bypassCache === false, '缺失译文手动重试不应绕过缓存');
  retry.resolve('手动重试结果');
  await waitFor('手动重试结果显示', () => panelText().includes('手动重试结果'));
  const result = { automaticRequests: 1, retryRequests: state.calls.length, rendered: true };
  await unmount();
  return result;
}

async function cancelAllowsManualRetryWithoutLoop() {
  const documentId = 'cancel-retry';
  await startScenario(documentId);
  await waitFor('取消场景自动请求', () => state.calls.length === 1);
  const first = pendingRequest();
  buttonWithText('取消').click();
  await waitFor('自动请求已取消', () => first.aborted === true);
  await sleep(800);
  check(state.calls.length === 1, '取消后自动无限重试');
  buttonWithText('生成译文').click();
  await waitFor('取消后的手动重试请求', () => state.calls.length === 2);
  const retry = pendingRequest(1);
  retry.resolve('取消后重试结果');
  await waitFor('取消后重试结果显示', () => panelText().includes('取消后重试结果'));
  const result = { firstAborted: first.aborted, requestCount: state.calls.length, rendered: true };
  await unmount();
  return result;
}

async function existingTranslationCanBeForced() {
  const documentId = 'force-existing';
  await startScenario(documentId, [makeRecord(documentId, 1, '简体中文', '旧版译文')]);
  await waitFor('已有译文显示', () => panelText().includes('旧版译文'));
  buttonWithText('重新翻译').click();
  await waitFor('强制翻译请求', () => state.calls.length === 1);
  const request = pendingRequest();
  check(request.bypassCache === true, '已有译文重新翻译必须使用 bypassCache=true');
  request.resolve('强制翻译结果');
  await waitFor('强制翻译结果显示', () => panelText().includes('强制翻译结果'));
  const result = { requestCount: state.calls.length, bypassCache: request.bypassCache, rendered: true };
  await unmount();
  return result;
}

window.__runSharedAutoTranslationProbe = async () => ({
  auto: await autoMissingAndStrictMode(),
  published: await publishedCacheSkipsRequest(),
  gates: await inactiveAndNoAiSkipRequest(),
  race: await pageAndDocumentRace(),
  language: await languageDebounceAndRace(),
  failure: await failureAllowsManualRetryWithoutLoop(),
  cancel: await cancelAllowsManualRetryWithoutLoop(),
  force: await existingTranslationCanBeForced(),
});

root.render(null);
`;

const browserMain = `
const { app, BrowserWindow } = require('electron');
const marker = ${JSON.stringify(RESULT_MARKER)};
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let window;
  let exitCode = 0;
  try {
    window = new BrowserWindow({
      width: 1100,
      height: 800,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await window.loadURL(process.env.YEYU_SHARED_AUTO_TRANSLATION_URL);
    const result = await window.webContents.executeJavaScript(
      'window.__runSharedAutoTranslationProbe()',
      true,
    );
    process.stdout.write(marker + ' ' + JSON.stringify({ ok: true, result }) + '\\n');
  } catch (error) {
    exitCode = 1;
    process.stdout.write(marker + ' ' + JSON.stringify({ ok: false, error: String(error) }) + '\\n');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(exitCode);
  }
});
`;

function displayUnavailable(): string | false {
  if (process.platform !== 'linux') return false;
  if (process.env.DISPLAY) return false;
  return existsSync('/usr/bin/xvfb-run')
    ? false
    : '当前环境没有 DISPLAY 或 xvfb-run，跳过 Electron 真浏览器行为测试。';
}

async function buildBrowserBundle(directory: string): Promise<string> {
  const pdfjsStubPath = path.join(directory, 'pdfjs-stub.ts');
  await writeFile(pdfjsStubPath, MOCK_PDFJS);
  let mockLoaded = false;
  const result = await build({
    stdin: {
      contents: BROWSER_ENTRY,
      loader: 'tsx',
      resolveDir: root,
      sourcefile: 'shared-auto-translation-browser.tsx',
    },
    plugins: [
      {
        name: 'mock-lan-share-api',
        setup(pluginBuild) {
          pluginBuild.onLoad(
            { filter: /[\\/]lib[\\/]lan-share-api\.ts$/ },
            () => {
              mockLoaded = true;
              return { contents: MOCK_LAN_SHARE_API, loader: 'ts' };
            },
          );
        },
      },
    ],
    alias: {
      '@/lib/pdfjs': pdfjsStubPath,
      '@': root,
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  assert.equal(mockLoaded, true, '浏览器 bundle 未命中 lan-share-api mock');
  return result.outputFiles[0]!.text;
}

async function startServer(bundle: string) {
  const server = http.createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(bundle);
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('自动翻译浏览器测试服务没有分配端口。');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function launchBrowser(url: string, directory: string) {
  const mainPath = path.join(directory, 'main.cjs');
  await writeFile(mainPath, browserMain);
  const electronArgs = [
    '--no-sandbox',
    '--disable-gpu',
    ...(process.platform === 'linux' &&
    process.env.DISPLAY &&
    process.env.WAYLAND_DISPLAY
      ? ['--ozone-platform=x11']
      : []),
    `--user-data-dir=${path.join(directory, 'profile')}`,
    mainPath,
  ];
  const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
  const command = useXvfb ? 'xvfb-run' : electronBinary;
  const args = useXvfb ? ['-a', electronBinary, ...electronArgs] : electronArgs;
  return new Promise<{ result: unknown; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, YEYU_SHARED_AUTO_TRANSLATION_URL: url },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('自动翻译 Electron 测试超时。\n' + stderr));
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
          .find((value) => value.startsWith(RESULT_MARKER));
        if (!line) {
          reject(
            new Error(
              '自动翻译 Electron 测试没有结果标记（exit ' +
                code +
                '）。\nstdout:\n' +
                stdout +
                '\nstderr:\n' +
                stderr,
            ),
          );
          return;
        }
        resolve({
          result: JSON.parse(line.slice(RESULT_MARKER.length + 1)),
          stdout,
          stderr,
        });
      });
    },
  );
}

type ProbeResults = {
  auto: { requestCount: number; bypassCache: boolean; rendered: boolean };
  published: { requestCount: number; rendered: boolean };
  gates: { inactiveRequests: number; noAiRequests: number };
  race: { firstAborted: boolean; secondAborted: boolean; rendered: boolean };
  language: { firstAborted: boolean; requestCount: number; language: string };
  failure: {
    automaticRequests: number;
    retryRequests: number;
    rendered: boolean;
  };
  cancel: { firstAborted: boolean; requestCount: number; rendered: boolean };
  force: { requestCount: number; bypassCache: boolean; rendered: boolean };
};

let browserProbe: Promise<ProbeResults> | null = null;

function runBrowserProbe(): Promise<ProbeResults> {
  if (!browserProbe) {
    browserProbe = (async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'yeyu-shared-auto-translation-'),
      );
      try {
        const bundle = await buildBrowserBundle(directory);
        const server = await startServer(bundle);
        try {
          const launched = await launchBrowser(server.url, directory);
          const parsed = launched.result as {
            ok: boolean;
            result?: ProbeResults;
            error?: string;
          };
          assert.equal(parsed.ok, true, JSON.stringify(parsed));
          assert.ok(parsed.result);
          return parsed.result;
        } finally {
          await server.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })();
  }
  return browserProbe;
}

const noDisplay = displayUnavailable();

void test(
  'shared panel automatically translates a missing page once under StrictMode',
  { skip: noDisplay },
  async () => {
    const result = await runBrowserProbe();
    assert.equal(result.auto.requestCount, 1);
    assert.equal(result.auto.bypassCache, false);
    assert.equal(result.auto.rendered, true);
  },
);

void test(
  'shared panel renders published cache without requesting AI',
  { skip: noDisplay },
  async () => {
    const result = await runBrowserProbe();
    assert.equal(result.published.requestCount, 0);
    assert.equal(result.published.rendered, true);
  },
);

void test(
  'shared panel honors active and AI capability gates',
  { skip: noDisplay },
  async () => {
    const result = await runBrowserProbe();
    assert.equal(result.gates.inactiveRequests, 0);
    assert.equal(result.gates.noAiRequests, 0);
  },
);

void test(
  'shared panel cancels page and document races and ignores late results',
  { skip: noDisplay },
  async () => {
    const result = await runBrowserProbe();
    assert.equal(result.race.firstAborted, true);
    assert.equal(result.race.secondAborted, true);
    assert.equal(result.race.rendered, true);
  },
);

void test(
  'shared panel debounces language changes and ignores late language results',
  { skip: noDisplay },
  async () => {
    const result = await runBrowserProbe();
    assert.equal(result.language.firstAborted, true);
    assert.equal(result.language.requestCount, 2);
    assert.equal(result.language.language, '日本語');
  },
);

void test(
  'shared panel does not retry failed automatic translation until manual retry',
  { skip: noDisplay },
  async () => {
    const result = await runBrowserProbe();
    assert.equal(result.failure.automaticRequests, 1);
    assert.equal(result.failure.retryRequests, 2);
    assert.equal(result.failure.rendered, true);
  },
);

void test(
  'shared panel does not retry canceled translation until manual retry',
  { skip: noDisplay },
  async () => {
    const result = await runBrowserProbe();
    assert.equal(result.cancel.firstAborted, true);
    assert.equal(result.cancel.requestCount, 2);
    assert.equal(result.cancel.rendered, true);
  },
);

void test(
  'shared panel forces cache bypass when re-translating an existing result',
  { skip: noDisplay },
  async () => {
    const result = await runBrowserProbe();
    assert.equal(result.force.requestCount, 1);
    assert.equal(result.force.bypassCache, true);
    assert.equal(result.force.rendered, true);
  },
);
