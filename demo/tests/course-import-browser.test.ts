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
      args.path in mockSources ? { path: args.path, namespace: 'mock' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
      contents: mockSources[args.path], loader: 'js', resolveDir: root,
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
  createRoot(document.getElementById('root')).render(<CourseLibrary onOpenDocument={(_file, context) => { f.opened = context; }}/>);
  await waitFor('loaded', () => button('导入 PDF'));
  const before = JSON.stringify(f.bundle);
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
  await waitFor('glossary reload', () => document.querySelector('input[aria-label="源词 1"]'));

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

  return f.calls;
};
`;

void test('course import skips identical and renamed PDFs before extraction/AI, but accepts different content with the same name', {
  skip: process.platform === 'linux' && !process.env.DISPLAY && !existsSync('/usr/bin/xvfb-run')
    ? 'Requires a display or Xvfb for Chromium interaction tests' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-course-import-'));
  const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root },
    alias: { '@': root }, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent', plugins: [mockDependencies] });
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const main = path.join(directory, 'main.cjs');
  await writeFile(main, `
    const {app, BrowserWindow} = require('electron');
    app.disableHardwareAcceleration();
    app.whenReady().then(async () => {
      const win = new BrowserWindow({width: 1200, height: 900, show: true,
        webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
      try {
        await win.loadURL(${JSON.stringify(url)});
        const result = await win.webContents.executeJavaScript('window.runImportRegression()', true);
        console.log('IMPORT_OK ' + JSON.stringify(result)); win.destroy(); app.exit(0);
      } catch (error) { console.error(error); win.destroy(); app.exit(1); }
    });
  `);
  try {
    const electron = require('electron') as string;
    const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
    const args = ['--no-sandbox', '--disable-gpu', `--user-data-dir=${directory}/profile`, main];
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(useXvfb ? 'xvfb-run' : electron, useXvfb ? ['-a', electron, ...args] : args,
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let logs = '';
      child.stdout.on('data', (data: Buffer) => { logs += data; });
      child.stderr.on('data', (data: Buffer) => { logs += data; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(logs)); }, 30000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(logs); else reject(new Error(logs)); });
    });
    assert.match(output, /IMPORT_OK .*"analyze":1,"synthesize":1,"extract":1,"save":1/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
