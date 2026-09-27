import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
// Only the expensive boundaries are mocked; SHA-256 and both UI components are real.
const mockSources: Record<string, string> = {
  '@/lib/course-storage/desktop-course-storage': `
    export class DesktopCourseStorage {
      label = 'fixture';
      async openPdf() { return new File(['pdf'], 'lesson.pdf', {type:'application/pdf'}); }
      async loadGlossary() { return structuredClone(window.fixture.glossary); }
      async saveGlossary(value) { window.fixture.glossary = structuredClone(value); }
      async load() { return structuredClone(window.fixture.bundle); }
      async importDocument(file, digest, options, revision) {
        const f = window.fixture; f.calls.save++;
        if (f.pauseCommit) await new Promise(resolve => { f.finishCommit = resolve; });
        if (revision !== f.bundle.manifest.revision) throw new Error('stale revision');
        const document = f.record(digest.fingerprint, file.name);
        f.bundle.manifest.documents.push(document);
        f.bundle.manifest.revision++;
        f.bundle.digests[document.id] = digest;
        return {bundle: structuredClone(f.bundle), document};
      }
    }
  `,
  '@/lib/knowledge/ai-knowledge-provider': `
    export const describeKnowledgeError = (error) => error.message;
    export function createKnowledgeProviderForSettings() {
      const f = window.fixture; f.calls.provider++;
      if (!f.configured) throw new Error('mock provider is unconfigured');
      return {
        async analyzeDocument(input) {
          f.calls.analyze++;
          if (f.blockAnalysis) {
            input.onStage?.('chunk-analysis',{chunkIndex:1,chunkCount:3});
            await new Promise((resolve) => { f.nextLayer = resolve; });
            input.onStage?.('synthesize',{identity:'lecture/round-0/batch-0'});
            await new Promise((resolve) => { f.nextLayer = resolve; });
            input.onStage?.('course-merge',{identity:'course/final'});
            await new Promise((resolve) => input.signal.addEventListener('abort',resolve,{once:true}));
            throw new Error('生成已取消；旧成果保留，已完成层可复用');
          }
          if (f.hierarchyFailure) throw new Error(f.hierarchyFailure);
          if (f.asyncFailure) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            throw new Error(f.asyncFailure);
          }
          return {documentId: input.documentId, fingerprint: input.fingerprint, sourcePages: [1]};
        },
        async synthesizeCourseKnowledge() { f.calls.synthesize++; return {}; }
      };
    }
  `,
  '@/lib/knowledge/document-digest': `
    import {sha256Hex} from '@/lib/course-storage/file-utils';
    export async function extractPdfPages(file) {
      window.fixture.calls.extract++;
      return {fingerprint: await sha256Hex(await file.arrayBuffer()), pages: ['fixture page']};
    }
  `,
  '@/lib/ocr': `
    export function createOcrProviderForSettings() { window.fixture.calls.ocr++; return {}; }
    export function createOcrService() { return {}; }
    export async function resolvePageOcr() { throw new Error('unexpected OCR request'); }
  `,
};
const mockDependencies: import('esbuild').Plugin = {
  name: 'course-import-mocks',
  setup(builder) {
    builder.onResolve({ filter: /^@\/lib\// }, (args) =>
      args.path in mockSources
        ? { path: args.path, namespace: 'mock' }
        : undefined,
    );
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
      contents: mockSources[args.path],
      loader: 'js',
      resolveDir: root,
    }));
  },
};
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CourseLibrary} from '@/components/course-library';
import {sha256Hex, stableDocumentId} from '@/lib/course-storage/file-utils';
import {createReaderService} from '@/lib/reader-cache';
const now = '2026-01-01T00:00:00.000Z';
const f = window.fixture = {
  glossary: {schemaVersion:1,version:0,entries:[]},
  configured: false,
  calls: {provider:0, analyze:0, synthesize:0, extract:0, save:0, ocr:0},
  record(fingerprint, fileName) {
    return {id:stableDocumentId(fingerprint), fingerprint, fileName, storedFileName:fileName,
      pageCount:1, status:'copied', includedInCourse:false, includeConversationInsights:false,
      hasSummary:false, hasMindmap:false, importedAt:now, updatedAt:now};
  },
  bundle: {
    manifest: {schemaVersion:1,id:'fixture',name:'测试课程',revision:1,createdAt:now,updatedAt:now,activeKnowledgeVersion:1,documents:[]},
    knowledge: {schemaVersion:1,courseId:'fixture',version:1,nodes:[],relations:[],conflicts:[],updatedAt:now},
    digests: {},
  },
};
window.yeyuDesktop = {
  getWorkspaceInfo: async () => ({root:'/fixture'}),
  listCourses: async () => [{directoryName:'fixture', manifest:f.bundle.manifest}],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
const text = () => document.body.textContent;
const button = (label) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
const check = (value, message) => {if (!value) throw new Error(message)};
async function waitFor(label, predicate) {
  for (let i=0;i<200;i++) {if(predicate()) return; await sleep(20);}
  throw new Error('Timeout: '+label+' '+text());
}
async function submit(content, name, duplicate) {
  button('导入 PDF').click();
  await waitFor('dialog', () => document.querySelector('input[type=file]'));
  const input = document.querySelector('input[type=file]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([content], name, {type:'application/pdf'}));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', {bubbles:true}));
  await waitFor('submit enabled', () => button('导入并处理') && !button('导入并处理').disabled);
  button('导入并处理').click();
  await waitFor('completion', () => document.querySelector('output')?.textContent.includes(duplicate ? '已存在，已跳过' : '成果已保存到本地'));
  if (duplicate) check(!document.querySelector('output').textContent.includes('成果已保存到本地'), 'skip reported as saved');
  await waitFor('dialog closed', () => !document.querySelector('input[type=file]'));
  if (duplicate) check(text().includes('已存在，已跳过'), 'skip feedback lost after dialog closed');
}
window.runImportRegression = async () => {
  const original = 'original PDF bytes';
  const fingerprint = await sha256Hex(new TextEncoder().encode(original).buffer);
  f.bundle.manifest.documents.push(f.record(fingerprint, 'lesson.pdf'));
  createRoot(document.getElementById('root')).render(<CourseLibrary
    onOpenDocument={(_file, context) => { f.opened = context; }}
    onControlReady={(control) => { if (control) f.control = control; }} />);
  await waitFor('loaded', () => button('导入 PDF'));
  await waitFor('MCP course control', () => f.control);
  const before = JSON.stringify(f.bundle);
  const mcpDuplicate = await f.control.importPdf({
    courseName:'测试课程', fileName:'mcp-duplicate.pdf',
    fileData:new TextEncoder().encode(original),
    generateSummary:true, generateMindmap:true, mergeIntoCourse:true,
  });
  check(mcpDuplicate.message.includes('已存在，已跳过'), 'MCP duplicate import did not use the course transaction');
  check(Object.values(f.calls).every((count) => count === 0), 'MCP duplicate import called extraction, OCR, AI or save');
  // An unconfigured provider must not even be constructed for duplicates.
  await submit(original, 'lesson.pdf', true);
  await submit(original, 'renamed.pdf', true);
  check(Object.values(f.calls).every((count) => count === 0), 'duplicate called extraction, OCR, AI or save: '+JSON.stringify(f.calls));
  check(JSON.stringify(f.bundle) === before, 'duplicate changed course data');
  // Simulate another window adding a file after this component loaded its manifest.
  const external = 'externally imported bytes';
  const externalHash = await sha256Hex(new TextEncoder().encode(external).buffer);
  f.bundle.manifest.documents.push(f.record(externalHash, 'external.pdf'));
  f.bundle.manifest.revision++;
  await submit(external, 'external-renamed.pdf', true);
  check(Object.values(f.calls).every((count) => count === 0), 'stale UI caused an AI request');
  f.configured = true;
  await submit('different PDF bytes', 'lesson.pdf', false);
  check(f.calls.provider === 1 && f.calls.analyze === 1 && f.calls.synthesize === 1 && f.calls.extract === 1 && f.calls.ocr === 1 && f.calls.save === 1,
    'different content did not import exactly once: '+JSON.stringify(f.calls));
  check(f.bundle.manifest.documents.length === 3, 'same-name different content was lost');
  check(f.bundle.manifest.documents[2].fingerprint !== fingerprint, 'fingerprint ignored content');
  button('课程术语表').click();
  await waitFor('glossary ready', () => button('新增术语') && !button('新增术语').closest('fieldset').disabled);
  button('新增术语').click();
  await waitFor('new term row', () => document.querySelector('input[aria-label="源词 1"]'));
  const inputValue = (label, value) => {
    const input = document.querySelector('input[aria-label="'+label+'"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles:true}));
  };
  inputValue('源词 1', 'momentum'); inputValue('目标译法 1', '动量');
  inputValue('禁用译法 1', '冲量'); inputValue('备注 1', '力学');
  await waitFor('dirty', () => text().includes('有未保存的修改'));
  button('保存术语表').click();
  await waitFor('saved glossary', () => text().includes('已保存版本 1'));
  check(f.glossary.entries[0].target === '动量', 'glossary edit was not saved');
  inputValue('目标译法 1', '线动量');
  await waitFor('edit dirty', () => text().includes('有未保存的修改'));
  button('保存术语表').click();
  await waitFor('updated glossary', () => text().includes('已保存版本 2'));
  await createReaderService().cache.save({key:'',fingerprint,pageNumber:1,sourceHash:await sha256Hex(new TextEncoder().encode('momentum').buffer),
    paragraphs:['冲量'],sourceParagraphs:['momentum'],targetLanguage:'zh',provider:'mock',model:'test',updatedAt:now});
  button('检查译名一致性').click();
  await waitFor('audit coverage', () => text().includes('本机译文覆盖 1/3 页'));
  check(text().includes('未检查'), 'audit must disclose uncovered pages');
  check(text().includes('命中禁用译法「冲量」'), 'audit lost forbidden terminology');
  button('lesson.pdf · 第 1 页 · 译文段落 1').click();
  await waitFor('source opened', () => f.opened?.initialPage === 1);
  check(f.opened.glossary.entries[0].target === '线动量', 'reader did not receive current glossary');
  check(f.opened.glossaryFingerprint.length === 64, 'reader glossary fingerprint missing');
  button('课程术语表').click();
  await waitFor('glossary reload', () => document.querySelector('input[aria-label="源词 1"]')
    && button('删除第 1 条') && !button('删除第 1 条').closest('fieldset').disabled);

  button('删除第 1 条').click();
  await waitFor('deleted row', () => !document.querySelector('input[aria-label="源词 1"]'));
  button('保存术语表').click();
  await waitFor('empty saved', () => text().includes('已保存版本 3'));
  check(f.glossary.entries.length === 0, 'glossary delete not persisted');
  const importInput = document.querySelector('input[aria-label="导入术语表 JSON"]');
  const imported = new DataTransfer();
  imported.items.add(new File([JSON.stringify({schemaVersion:1,version:99,entries:[{source:'mass',target:'质量',forbidden:[],note:''}]})], 'terms.json', {type:'application/json'}));
  importInput.files = imported.files; importInput.dispatchEvent(new Event('change', {bubbles:true}));
  await waitFor('JSON imported', () => document.querySelector('input[aria-label="源词 1"]')?.value === 'mass');
  button('保存术语表').click();
  await waitFor('import saved', () => text().includes('已保存版本 4'));
  check(f.glossary.entries[0].target === '质量' && f.glossary.version === 4, 'import did not use local revision');

  const beforeFailure = JSON.stringify(f.bundle);
  f.hierarchyFailure = '脑图结构不达标：最大深度 1 < 3，已自动重试一次仍失败；未保存本次结果';
  button('导入 PDF').click();
  await waitFor('failure dialog', () => document.querySelector('input[accept="application/pdf,.pdf"]'));
  const failedInput = document.querySelector('input[accept="application/pdf,.pdf"]');
  const failedFile = new DataTransfer();
  failedFile.items.add(new File(['flat hierarchy bytes'], 'flat.pdf', {type:'application/pdf'}));
  failedInput.files = failedFile.files; failedInput.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor('failure submit', () => button('导入并处理') && !button('导入并处理').disabled);
  button('导入并处理').click();
  await waitFor('visible structure error', () => [...document.querySelectorAll('[role=alert]')].some(node => node.textContent.includes('最大深度 1 < 3')));
  check(button('重试导入'), 'structure failure must offer retry');
  check(JSON.stringify(f.bundle) === beforeFailure && f.calls.save === 1, 'structure failure mutated existing course');
  f.hierarchyFailure = null;
  f.blockAnalysis = true;
  button('重试导入').click();
  await waitFor('chunk progress', () => text().includes('分块层：'));
  f.nextLayer();
  await waitFor('document progress', () => text().includes('文档层：'));
  f.nextLayer();
  await waitFor('course progress', () => text().includes('课程层：'));
  button('取消生成').click();
  await waitFor('cancelled', () => text().includes('生成已取消') && button('重试导入'));
  check(JSON.stringify(f.bundle) === beforeFailure && f.calls.save === 1, 'cancel changed old course');
  f.blockAnalysis = false;
  f.pauseCommit = true;
  button('重试导入').click();
  await waitFor('retry saved', () => f.calls.save === 2);
  await waitFor('commit cannot be cancelled halfway', () => button('取消生成')?.disabled);
  f.finishCommit();
  await waitFor('retry closed', () => !document.querySelector('input[accept="application/pdf,.pdf"]'));
  check(f.calls.analyze === 4 && f.calls.synthesize === 2 && f.calls.extract === 4 && f.calls.save === 2,
    'existing import/cancel assertions changed before async failure regression: ' + JSON.stringify(f.calls));

  f.pauseCommit = false;
  const asyncFailurePrefix = '知识库 AI 请求超时：';
  f.asyncFailure = asyncFailurePrefix + '服务端诊断信息。'.repeat(120);
  button('导入 PDF').click();
  await waitFor('async failure dialog', () => document.querySelector('input[accept="application/pdf,.pdf"]'));
  const asyncInput = document.querySelector('input[accept="application/pdf,.pdf"]');
  const asyncFile = new DataTransfer();
  asyncFile.items.add(new File(['async failure bytes'], 'async-failure.pdf', {type:'application/pdf'}));
  asyncInput.files = asyncFile.files; asyncInput.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor('async failure submit', () => button('导入并处理') && !button('导入并处理').disabled);
  button('导入并处理').click();
  await waitFor('async failure visible', () => text().includes(f.asyncFailure) && button('重试导入'));
  check(text().includes('处理已停止，请查看具体错误后重试'), 'failure status must direct users to the concrete error');
  const asyncError = [...document.querySelectorAll('[role=alert]')]
    .find((node) => node.textContent.includes(f.asyncFailure));
  const retryButton = button('重试导入');
  check(asyncError && retryButton, 'async failure must render its concrete error and retry action');
  const viewport = {width: window.innerWidth, height: window.innerHeight};
  check(asyncError.textContent.trim().startsWith(asyncFailurePrefix), 'long async failure must keep its concrete opening visible');
  check(asyncError.scrollTop === 0 && asyncError.scrollHeight > asyncError.clientHeight,
    'long async failure must scroll inside its bounded error area');
  check(asyncError.clientHeight <= viewport.height * 0.2 + 2,
    'long async failure must not grow past its viewport allowance');
  const errorRect = asyncError.getBoundingClientRect();
  const retryRect = retryButton.getBoundingClientRect();
  const visible = (rect) => rect.top >= 0 && rect.left >= 0
    && rect.bottom <= viewport.height && rect.right <= viewport.width;
  check(visible(errorRect), 'async error is outside viewport: ' + JSON.stringify({viewport, rect: errorRect.toJSON()}));
  check(visible(retryRect), 'retry button is outside viewport: ' + JSON.stringify({viewport, rect: retryRect.toJSON()}));
  f.asyncFailure = null;
  retryButton.click();
  await waitFor('async retry closed', () => !document.querySelector('input[accept="application/pdf,.pdf"]'));
  check(f.calls.save === 3, 'retry after async failure did not complete the import');
  return f.calls;
};
`;

void test(
  'course import skips identical and renamed PDFs before extraction/AI, but accepts different content with the same name',
  {
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !existsSync('/usr/bin/xvfb-run')
        ? 'Requires a display or Xvfb for Chromium interaction tests'
        : false,
  },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'yeyu-course-import-'),
    );
    const bundle = await build({
      stdin: { contents: entry, loader: 'tsx', resolveDir: root },
      alias: { '@': root },
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
      plugins: [mockDependencies],
    });
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<html><head><style>
          * { box-sizing: border-box; }
          body { margin: 0; }
          [data-slot="dialog-content"] {
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            display: flex; flex-direction: column; width: calc(100% - 2rem); max-width: 580px;
            max-height: 90vh; gap: 16px; overflow: hidden; padding: 16px; background: white;
          }
          [data-slot="dialog-content"] > .shrink-0 { flex-shrink: 0; }
          [data-slot="dialog-content"] > .min-h-0.flex-1.overflow-y-auto {
            min-height: 0; flex: 1 1 auto; overflow-y: auto;
          }
          [data-slot="dialog-content"] [role="alert"][class~="max-h-[20vh]"][class~="overflow-y-auto"] {
            max-height: 20vh; overflow-y: auto;
          }
          [data-slot="dialog-footer"] {
            display: flex; flex-shrink: 0; justify-content: flex-end; gap: 8px;
            margin: 0 -16px -16px; padding: 16px; border-top: 1px solid #ddd;
          }
        </style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
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
      const win = new BrowserWindow({width: 640, height: 480, show: true,
        webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
      try {
        await win.loadURL(${JSON.stringify(url)});
        const result = await win.webContents.executeJavaScript('window.runImportRegression()', true);
        console.log('IMPORT_OK ' + JSON.stringify(result)); win.destroy(); app.exit(0);
      } catch (error) { console.error(error); win.destroy(); app.exit(1); }
    });
  `,
    );
    try {
      const electron = require('electron') as string;
      const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
      const args = [
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${directory}/profile`,
        main,
      ];
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          useXvfb ? 'xvfb-run' : electron,
          useXvfb ? ['-a', electron, ...args] : args,
          {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let logs = '';
        child.stdout.on('data', (data: Buffer) => {
          logs += data;
        });
        child.stderr.on('data', (data: Buffer) => {
          logs += data;
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(logs));
        }, 30000);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(logs);
          else reject(new Error(logs));
        });
      });
      assert.match(
        output,
        /IMPORT_OK .*"analyze":6,"synthesize":3,"extract":6,"save":3/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
