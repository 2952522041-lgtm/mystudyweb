import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReaderSettingsDialog} from '@/components/reader-settings-dialog';
import {CourseImportDialog} from '@/components/course-import-dialog';
import {TranslationBody} from '@/app/page';
import {DEFAULT_SETTINGS} from '@/lib/reader-cache';
import {DEFAULT_CHAT_SETTINGS} from '@/lib/chat-cache';
import {DEFAULT_KNOWLEDGE_SETTINGS} from '@/lib/knowledge-settings';
let saved = 0, imports = 0, retries = 0, openedSettings = 0;
function App() {
  const [mode, setMode] = useState('settings');
  window.openImport = () => setMode('import');
  window.openTranslation = (mode) => setMode(mode);
  if (mode === 'error' || mode === 'demo') return <TranslationBody page={1} targetLanguage="zh"
    state={mode === 'error' ? {status:'error',errorMessage:'模拟公式校验失败'} : {status:'complete',paragraphs:['演示内容']}}
    remoteProvider={false} onRetry={() => retries++} onRetrySave={() => {}}
    onOpenSettings={() => openedSettings++} alignment={{mode:'unavailable',targetToSource:[],sourceToTarget:[]}}
    activeParagraphs={[]} onParagraphActivate={() => {}} revealRequest={null} />;

  return mode === 'settings' ? <ReaderSettingsDialog initialTab="translation"
    translationSettings={{...DEFAULT_SETTINGS,providerMode:'openai-compatible',apiKey:'test',baseUrl:'https://mock.test/v1/chat/completions'}}
    chatSettings={DEFAULT_CHAT_SETTINGS} knowledgeSettings={DEFAULT_KNOWLEDGE_SETTINGS}
    onClose={() => setMode('closed')} onSave={() => {saved++;setMode('closed')}} />
    : <CourseImportDialog open={mode === 'import'} onOpenChange={(open) => !open && setMode('closed')}
      onImport={async (file,options,progress) => {
        imports++; progress('模拟分析中',30);
        await new Promise(resolve=>setTimeout(resolve,120));
        if(imports === 1) throw new Error('模拟接口失败，请检查知识库 AI 设置');
      }} />;
}
createRoot(document.getElementById('root')).render(<App />);
const sleep = (ms) => new Promise(resolve=>setTimeout(resolve,ms));
const button = (text) => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
const check = (ok,msg) => {if(!ok)throw new Error(msg)};
async function waitFor(label,predicate) {for(let i=0;i<200;i++){if(predicate())return;await sleep(20)}throw new Error(label)}
window.runStorageRegression = async () => {
  await waitFor('settings',()=>button('保存设置'));
  button('保存设置').click();
  await waitFor('focused error',()=>document.activeElement?.getAttribute('role')==='alert');
  check(document.activeElement.textContent.includes('基础地址'), 'missing actionable URL guidance');
  check(saved === 0,'invalid settings saved');
  const input = document.getElementById('setting-base-url');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'https://mock.test/v1');
  input.dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor('stale error removed',()=>!document.querySelector('[role="alert"]'));
  button('保存设置').click(); await waitFor('settings saved',()=>saved===1);
  window.openImport(); await waitFor('import dialog',()=>document.querySelector('input[type="file"]'));
  check(document.body.textContent.includes('导入仍需知识库 AI'), 'AI requirement hidden');
  const data = new DataTransfer();data.items.add(new File(['mock'],'fixture.pdf',{type:'application/pdf'}));
  const file = document.querySelector('input[type="file"]');file.files=data.files;file.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor('file selected',()=>button('导入并处理')&&!button('导入并处理').disabled);
  button('导入并处理').click();
  await waitFor('busy',()=>button('正在处理…'));
  check([...document.querySelectorAll('[role="switch"]')].every(el=>el.disabled||el.getAttribute('aria-disabled')==='true'),'options editable during import');
  await waitFor('recoverable import error',()=>button('重试导入'));
  check(document.querySelector('[role="alert"]').textContent.includes('模拟接口失败'),'error not announced');
  check(document.querySelector('output').textContent.includes('处理已停止'),'stale running status');
  check(document.body.textContent.includes('fixture.pdf'),'retry lost the selected file');
  button('重试导入').click();await waitFor('retry completed',()=>imports===2&&!document.querySelector('[role="dialog"]'));
  window.openTranslation('error');await waitFor('translation recovery',()=>button('检查或更换服务'));
  check(document.querySelector('[role="alert"]').textContent.includes('校验失败'),'translation error not announced');
  button('检查或更换服务').click();button('重新翻译').click();
  check(openedSettings===1&&retries===1,'recovery actions not wired');
  window.openTranslation('demo');await waitFor('demo next step',()=>button('配置翻译服务'));
  button('配置翻译服务').click();check(openedSettings===2,'demo configuration action not wired');
  return {calls:imports};
};
`;

void test('settings errors focus recovery guidance and course import can retry the selected file', {
  skip: process.platform === 'linux' && !process.env.DISPLAY && !existsSync('/usr/bin/xvfb-run')
    ? 'Requires a display or Xvfb for Chromium interaction tests' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-chat-storage-'));
  const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root },
    plugins: [{name:'translation-body-fixture',setup(build) {
      build.onLoad({filter:/app\/page\.tsx$/}, async (args) => ({contents:(await readFile(args.path,'utf8')).replace('function TranslationBody(', 'export function TranslationBody('),loader:'tsx',resolveDir:path.dirname(args.path)}));
    }}],
    alias: { '@': root }, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
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
        const result = await win.webContents.executeJavaScript('window.runStorageRegression()', true);
        console.log('STORAGE_OK ' + JSON.stringify(result)); win.destroy(); app.exit(0);
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
    assert.match(output, /STORAGE_OK .*"calls":2/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
