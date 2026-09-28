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
const mockPdfjs = `
window.pdfLoads = 0; window.progressFails = true; window.progressSaves = 0;
const task = {destroy: async () => {}};
const doc = {numPages:3, loadingTask:task, getPage:async () => ({userUnit:1,
  getViewport:({scale}) => ({width:600*scale,height:800*scale}),
  getTextContent:async () => ({items:[{str:'Enough source text for import regression.',transform:[12,0,0,12,20,350],width:300,height:12}]}),
  render:() => ({promise:Promise.resolve(),cancel(){}})})};
export async function loadPdfjs() {return {getDocument:() => {window.pdfLoads++;return {...task,promise:window.corruptPdf ? Promise.reject(new Error('Invalid PDF')) : Promise.resolve(doc)}},TextLayer:class {async render(){} cancel(){}}};}
`;
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PdfReader} from '@/app/page';
function App() {
  const [file,setFile] = useState(new File(['good'],'good.pdf'));
  window.openFile = (name) => setFile(new File([name],name+'.pdf'));
  return <PdfReader initialFile={file} onOpenCourses={() => {}} />;
}
createRoot(document.getElementById('root')).render(<App />);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
async function waitFor(label,predicate) {
  for(let i=0;i<300;i++){if(predicate()) return;await sleep(20)}
  throw new Error('Timeout: '+label+' '+document.body.textContent.slice(-600));
}
const check = (value,message) => {if(!value) throw new Error(message)};
const button = (label) => [...document.querySelectorAll('button')].find((el) => el.textContent.includes(label));
const has = (text) => document.body.textContent.includes(text);
window.runReaderRegression = async () => {
  await waitFor('readable PDF with storage failure', () => document.querySelector('.pdf-page canvas') && has('阅读进度恢复失败'));
  check(!has('文件可能已损坏'), 'storage failure mislabeled as damaged PDF');
  await sleep(800);
  check(window.progressSaves === 0, 'unread saved progress was overwritten');
  button('重试恢复进度').click(); await sleep(100);
  check(has('阅读进度恢复失败'), 'failed retry should retain recovery actions');
  window.progressFails = false;
  button('重试恢复进度').click();
  await waitFor('restored page', () => document.querySelector('input[inputmode=numeric]')?.value === '3' && !has('阅读进度恢复失败'));
  check(window.pdfLoads === 1, 'progress retry should not reparse PDF');
  window.progressFails = true; window.openFile('second');
  await waitFor('second storage error', () => has('second.pdf') && has('阅读进度恢复失败'));
  button('忽略并继续阅读').click();
  await waitFor('ignored recovery', () => !has('阅读进度恢复失败'));
  await sleep(800);
  check(window.progressSaves > 0, 'ignore should enable progress saving');
  window.corruptPdf = true;
  button('更换 PDF').click();
  await waitFor('import input', () => document.querySelector('input[type=file]'));
  const input = document.querySelector('input[type=file]');
  const transfer = new DataTransfer(); transfer.items.add(new File(['bad'],'bad.pdf',{type:'application/pdf'}));
  input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor('damaged PDF error', () => has('文件可能已损坏或已加密'));
  check(!has('阅读进度恢复失败'), 'PDF error should not become a storage error');
  check(has('second.pdf'), 'bad import should retain the previous readable PDF');
  return {recovery:true,corruption:true};
};
`;

void test('storage recovery failure permits reading, retry and ignore while corrupt PDFs retain their own error', {
  skip: process.platform === 'linux' && !process.env.DISPLAY && !existsSync('/usr/bin/xvfb-run')
    ? 'Requires a display or Xvfb for Chromium interaction tests' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-progressive-'));
  const postcss = require('postcss');
  const tailwind = require('@tailwindcss/postcss');
  const cssPath = path.join(root, 'app/globals.css');
  const css = (await postcss([tailwind({base:root})]).process(await readFile(cssPath, 'utf8'), {from:cssPath})).css;
  const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root },
    plugins: [{name:'reader-fixture',setup(build) {
      build.onLoad({filter:/lib\/reader-cache\.ts$/}, async (args) => ({contents:(await readFile(args.path,'utf8'))
        .replace('return store.get(`progress:${fingerprint}`);', 'if (window.progressFails) throw new Error("storage unavailable"); return {fingerprint,lastPage:3,zoom:100,targetLanguage:"简体中文"};')
        .replace('await store.set(`progress:${progress.fingerprint}`, progress);', 'window.progressSaves++;'),loader:'ts',resolveDir:path.dirname(args.path)}));
      build.onLoad({filter:/lib\/pdfjs\.ts$/}, () => ({contents:mockPdfjs,loader:'ts'}));
      build.onLoad({filter:/app\/page\.tsx$/}, async (args) => ({contents:(await readFile(args.path,'utf8')).replace('function PdfReader(', 'export function PdfReader('),loader:'tsx',resolveDir:path.dirname(args.path)}));
    }}], alias: { '@': root }, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><head><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`);
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
      const win = new BrowserWindow({width: 1000, height: 420, show: true,
        webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
      try {
        await win.loadURL(${JSON.stringify(url)});
        const result = await win.webContents.executeJavaScript('window.runReaderRegression()', true);
        console.log('READER_OK ' + JSON.stringify(result)); win.destroy(); app.exit(0);
      } catch (error) { console.error(error); win.destroy(); app.exit(1); }
    });
  `);
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
      const child = spawn(useXvfb ? 'xvfb-run' : electron, useXvfb ? ['-a', electron, ...args] : args,
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let logs = '';
      child.stdout.on('data', (data: Buffer) => { logs += data; });
      child.stderr.on('data', (data: Buffer) => { logs += data; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(logs)); }, 30000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(logs); else reject(new Error(logs)); });
    });
    assert.match(output, /READER_OK .*"recovery":true,"corruption":true/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
