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
      async withWriteLock(operation) { window.fixture.lockCalls++; return operation(); }
      async openPdf(id) { return window.fixture.files.get(id) ?? new File(['pdf'], 'lesson.pdf', {type:'application/pdf'}); }
      async loadGlossary() { return structuredClone(window.fixture.glossary); }
      async saveGlossary(value) { window.fixture.glossary = structuredClone(value); }
      async load() { return structuredClone(window.fixture.bundle); }
      async savePdf(file, metadata, options, revision) {
        const f = window.fixture; f.calls.save++;
        if (f.pauseCommit) await new Promise(resolve => { f.finishCommit = resolve; });
        if (revision !== f.bundle.manifest.revision) throw new Error('stale revision');
        const document = f.record(metadata.fingerprint, file.name);
        if (options.generateSummary || options.generateMindmap || options.mergeIntoCourse)
          document.processing = {phase:'document',status:'queued',options,updatedAt:new Date().toISOString()};
        f.bundle.manifest.documents.push(document);
        f.bundle.manifest.revision++;
        f.files.set(document.id, file);
        return {bundle: structuredClone(f.bundle), document};
      }
      async setDocumentProcessing(id, processing, revision) {
        const f=window.fixture;
        if (revision!==f.bundle.manifest.revision) throw new Error('stale revision');
        f.bundle.manifest.documents.find(doc=>doc.id===id).processing=processing;
        f.bundle.manifest.revision++;
        return this.load();
      }
      async updateDocumentArtifacts(id, revision, digest) {
        const f=window.fixture;
        if (revision!==f.bundle.manifest.revision) throw new Error('stale revision');
        const doc=f.bundle.manifest.documents.find(doc=>doc.id===id);
        const job=doc.processing;
        f.bundle.digests[id]=digest;
        doc.hasSummary=job.options.generateSummary; doc.hasMindmap=job.options.generateMindmap;
        doc.processing=job.options.mergeIntoCourse?{...job,phase:'course',status:'queued',updatedAt:new Date().toISOString()}:undefined;
        f.bundle.manifest.revision++;
        return this.load();
      }
      async mergeDocuments(ids, revision) {
        const f=window.fixture;
        if(revision!==f.bundle.manifest.revision)throw new Error('stale revision');
        for(const doc of f.bundle.manifest.documents)if(ids.includes(doc.id)){doc.processing=undefined;doc.includedInCourse=true;}
        f.bundle.manifest.revision++;f.bundle.knowledge.version++;
        return this.load();
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
            await new Promise((resolve) => { f.finishAnalysis = resolve; });
          }
          if (f.hierarchyFailure) throw new Error(f.hierarchyFailure);
          if (f.asyncFailure) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            throw new Error(f.asyncFailure);
          }
          if (f.reusableDigest) return {
            schemaVersion:3,documentId:input.documentId,fingerprint:input.fingerprint,
            title:'单份课件',overview:'完整概述',sourcePages:[1],updatedAt:new Date().toISOString(),
            provider:'openai-compatible-knowledge',model:'fixture',promptVersion:'ai-digest-v11',
            sections:[{id:'s1',title:'主题',summary:'完整摘要',pageStart:1,pageEnd:1}],
            concepts:[{id:'c1',parentId:null,label:'主题',description:'完整描述',sources:[{documentId:input.documentId,fileName:input.fileName,pageStart:1,pageEnd:1,type:'pdf'}]}],
            relations:[],unresolvedQuestions:[],
          };
          return {documentId: input.documentId, fingerprint: input.fingerprint, sourcePages: [1]};
        },
        async synthesizeCourseKnowledge() { f.calls.synthesize++; if(f.courseFailure)throw new Error(f.courseFailure); return {}; }
      };
    }
  `,
  '@/lib/knowledge/document-digest': `
    import {sha256Hex} from '@/lib/course-storage/file-utils';
    export async function inspectPdf(file) { return {fingerprint:await sha256Hex(await file.arrayBuffer()),pageCount:1}; }
    export async function extractPdfPages(file) {
      window.fixture.calls.extract++;
      return {fingerprint: await sha256Hex(await file.arrayBuffer()), pages: ['fixture page']};
    }
  `,
  '@/lib/ocr': `
    export function createOcrProviderForSettings() { window.fixture.calls.ocr++; return {}; }
    export function createOcrService() { return {}; }
    export function pageNeedsOcr() { throw new Error('unexpected OCR inspection'); }
    export async function resolvePageOcr() { throw new Error('unexpected OCR request'); }
  `,
};
const mockDependencies: import('esbuild').Plugin = {
  name: 'course-import-mocks',
  setup(builder) {
    // Match module identity rather than the importing file's spelling. The
    // shared background processor uses relative .ts imports, while components
    // use aliases; both must hit the same expensive-boundary fixture.
    const mockedFiles = new Map(Object.keys(mockSources).map(source => [
      path.resolve(root, source.slice(2)), source,
    ]));
    builder.onResolve({ filter: /^(?:@\/lib\/|\.{1,2}\/)/ }, (args) => {
      const resolved = args.path.startsWith('@/')
        ? path.resolve(root, args.path.slice(2))
        : path.resolve(args.resolveDir, args.path);
      const source = mockedFiles.get(resolved.replace(/\.tsx?$/, ''));
      return source ? {path:source, namespace:'mock'} : undefined;
    });
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
  files: new Map(),
  lockCalls: 0,
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
const text = () => document.body.innerText;
const button = (label) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
const check = (value, message) => {if (!value) throw new Error(message)};
async function waitFor(label, predicate) {
  for (let i=0;i<200;i++) {if(predicate()) return; await sleep(20);}
  throw new Error('Timeout: '+label+' '+text());
}
async function submit(content, name, duplicate) {
  button('导入 PDF').click();
  await waitFor('dialog', () => document.querySelector('input[type=file]'));
  const input=document.querySelector('input[type=file]'), transfer=new DataTransfer();
  transfer.items.add(new File([content],name,{type:'application/pdf'}));
  input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor('submit enabled',()=>[...document.querySelectorAll('[role=dialog] button')].some(node=>node.textContent.trim()==='导入 PDF'&&!node.disabled));
  [...document.querySelectorAll('[role=dialog] button')].find(node=>node.textContent.trim()==='导入 PDF').click();
  await waitFor('dialog closed',()=>!document.querySelector('input[type=file]'));
  check(document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('PDF 资料'),'saved PDF is not visible in document tab');
  if(duplicate)check(text().includes('已存在，已跳过'),'duplicate feedback missing');
}
window.runImportRegression = async () => {
  const original='original PDF bytes', fingerprint=await sha256Hex(new TextEncoder().encode(original).buffer);
  f.bundle.manifest.documents.push(f.record(fingerprint,'lesson.pdf'));
  createRoot(document.getElementById('root')).render(<CourseLibrary
    onOpenDocument={(_file,context)=>{f.opened=context;}}
    onControlReady={control=>{if(control)f.control=control;}} />);
  await waitFor('loaded',()=>button('导入 PDF')&&f.control);
  check(text().includes('阅读资料与查看整理进度'),'existing PDF still shows first-import empty state');
  await createReaderService().progress.save({fingerprint,fileName:'lesson.pdf',pageCount:1,lastPage:1,zoom:1,targetLanguage:'zh',updatedAt:'2026-01-02T00:00:00Z'});
  await waitFor('recent reading refreshed',()=>document.querySelector('[aria-label="继续学习"]')?.textContent.includes('上次读到第 1 / 1 页'));
  document.querySelector('[aria-label="继续学习"] .grid button').click();
  await waitFor('continue opens reader',()=>f.opened?.document.fingerprint===fingerprint);
  check(f.opened.initialPage===undefined,'continue reading should restore saved page fraction rather than force a page jump');
  const before=JSON.stringify(f.bundle);
  const mcpDuplicate=await f.control.importPdf({courseName:'测试课程',fileName:'mcp-duplicate.pdf',fileData:new TextEncoder().encode(original)});
  check(mcpDuplicate.message.includes('已存在，已跳过'),'MCP duplicate result incorrect');
  await submit(original,'lesson.pdf',true);
  await submit(original,'renamed.pdf',true);
  check(Object.values(f.calls).every(count=>count===0),'duplicates invoked AI or save');
  check(JSON.stringify(f.bundle)===before,'duplicate changed course');
  const external='externally imported bytes', externalHash=await sha256Hex(new TextEncoder().encode(external).buffer);
  f.bundle.manifest.documents.push(f.record(externalHash,'external.pdf'));f.bundle.manifest.revision++;
  await submit(external,'external-renamed.pdf',true);
  await submit('different PDF bytes','lesson.pdf',false);
  await waitFor('unconfigured job failed',()=>f.bundle.manifest.documents[2]?.processing?.status==='failed');
  check(f.bundle.manifest.documents[2].processing.error==='mock provider is unconfigured','shared background processor bypassed the AI boundary fixture');
  check(f.bundle.manifest.documents.length===3&&f.calls.save===1,'unconfigured AI prevented PDF saving');
  check(!f.bundle.digests[f.bundle.manifest.documents[2].id],'failed AI produced a fake digest');
  const raw=f.bundle.manifest.documents[2];
  await f.control.openDocument({courseName:'测试课程',documentId:raw.id});
  check(f.opened.document.id===raw.id,'saved PDF could not open before AI completion');
  [...document.querySelectorAll('[role=tab]')].find(node=>node.textContent.includes('PDF 资料')).click();
  await waitFor('document search mounted',()=>document.querySelector('[aria-label="搜索 PDF 文件名"]'));
  const search=document.querySelector('[aria-label="搜索 PDF 文件名"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'EXTERNAL'); search.dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor('filename filtered',()=>search.closest('[role=tabpanel]').textContent.includes('1 份资料'));
  check(!search.closest('[role=tabpanel]').textContent.includes('lesson.pdf'),'file search left unrelated document rows visible');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,''); search.dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor('filter cleared',()=>search.closest('[role=tabpanel]').textContent.includes('3 份资料'));
  f.configured=true;f.blockAnalysis=true;
  await waitFor('retry task visible',()=>button('重试'));
  button('重试').click();
  await waitFor('analysis running',()=>f.finishAnalysis);
  await f.control.openDocument({courseName:'测试课程',documentId:raw.id});
  check(f.opened.document.id===raw.id,'background AI blocks reading');
  check(f.control.getState().courses[0].documents.find(doc=>doc.id===raw.id).processing.status==='running','MCP hides background state');
  f.blockAnalysis=false;f.finishAnalysis();
  await waitFor('background complete',()=>!f.bundle.manifest.documents[2].processing);
  check(f.calls.save===1&&f.calls.analyze===1&&f.calls.synthesize===1,'retry did not resume saved PDF');
  check(f.bundle.manifest.documents[2].fingerprint!==fingerprint,'same-name new content lost');
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
  f.opened = null;
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

  f.courseFailure='mock course synthesis failure';
  const result=await f.control.importPdf({courseName:'测试课程',fileName:'course-failure.pdf',fileData:new TextEncoder().encode('course failure bytes')});
  check(result.documentId,'queued result lacks documentId');
  const failed=()=>f.bundle.manifest.documents.find(doc=>doc.id===result.documentId);
  await waitFor('course-only failure',()=>failed()?.processing?.phase==='course'&&failed()?.processing?.status==='failed');
  check(failed().hasSummary&&f.bundle.digests[result.documentId],'course failure discarded document artifacts');
  const analysisBeforeRetry=f.calls.analyze;
  f.courseFailure=null;
  [...document.querySelectorAll('[role=tab]')].find(node=>node.textContent.includes('PDF 资料')).click();
  await waitFor('retry course visible',()=>button('重试'));
  button('重试').click();
  await waitFor('course retry complete',()=>!failed().processing);
  check(f.calls.analyze===analysisBeforeRetry,'course retry repeated document analysis');
  const beforeOnly={...f.calls};
  const only=await f.control.importPdf({courseName:'测试课程',fileName:'read-only.pdf',fileData:new TextEncoder().encode('read only bytes'),generateSummary:false,generateMindmap:false,mergeIntoCourse:false});
  check(!only.processing,'PDF-only import queued AI');
  await sleep(300);
  check(f.calls.analyze===beforeOnly.analyze&&f.calls.synthesize===beforeOnly.synthesize,'PDF-only import called AI');
  const beforeBatch={...f.calls};
  button('导入 PDF').click();
  await waitFor('batch dialog',()=>document.querySelector('[role=dialog] input[accept="application/pdf,.pdf"]'));
  const batchInput=document.querySelector('[role=dialog] input[accept="application/pdf,.pdf"]'), batch=new DataTransfer();
  batch.items.add(new File(['batch one'],'batch-1.pdf',{type:'application/pdf'}));
  batch.items.add(new File(['batch two'],'batch-2.pdf',{type:'application/pdf'}));
  check(batchInput.multiple,'file picker does not support batches');
  batchInput.files=batch.files;batchInput.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor('batch submit',()=>[...document.querySelectorAll('[role=dialog] button')].some(node=>node.textContent.trim()==='导入 PDF'&&!node.disabled));
  [...document.querySelectorAll('[role=dialog] button')].find(node=>node.textContent.trim()==='导入 PDF').click();
  await waitFor('batch closed',()=>!document.querySelector('[role=dialog] input[accept="application/pdf,.pdf"]'));
  await waitFor('batch AI finished',()=>f.calls.save===beforeBatch.save+2&&f.bundle.manifest.documents.every(doc=>!doc.processing));
  check(f.calls.analyze===beforeBatch.analyze+2,'batch did not analyze each document once');
  check(f.calls.synthesize===beforeBatch.synthesize+1,'batch synthesized the course more than once');
  // A fresh single-PDF course must finish without a redundant course AI request.
  f.bundle.manifest.documents=[];f.bundle.digests={};f.bundle.knowledge.nodes=[];
  f.reusableDigest=true;
  const beforeReuse={...f.calls};
  const reused=await f.control.importPdf({courseName:'测试课程',fileName:'single.pdf',fileData:new TextEncoder().encode('single complete AI digest')});
  await waitFor('single digest reused',()=>f.bundle.manifest.documents.some(doc=>doc.id===reused.documentId&&doc.includedInCourse&&!doc.processing));
  check(f.calls.analyze===beforeReuse.analyze+1,'single document not analyzed');
  check(f.calls.synthesize===beforeReuse.synthesize,'single document redundantly synthesized');
  check(f.lockCalls>=f.calls.save,'course mutations bypassed the desktop write-lock boundary');
  return {...f.calls,quickImport:true,courseRetry:true,batchMergedOnce:true};
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
        /IMPORT_OK .*"quickImport":true,"courseRetry":true,"batchMergedOnce":true/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
