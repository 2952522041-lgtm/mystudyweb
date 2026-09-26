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
window.pdfLoads = 0;
const task = {destroy: async () => {}};
const doc = {numPages:1, loadingTask:task, getPage:async () => ({userUnit:1,
  getViewport:({scale}) => ({width:600*scale,height:800*scale}),
  getTextContent:async () => ({items:[{str:'Enough source text for import regression.',transform:[12,0,0,12,20,350],width:300,height:12}]}),
  render:() => ({promise:Promise.resolve(),cancel(){}})})};
export async function loadPdfjs() {return {getDocument:() => {window.pdfLoads++;return {...task,promise:Promise.resolve(doc)}},TextLayer:class {async render(){} cancel(){}}};}
`;
const entry = `
import React, {StrictMode, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PdfReader} from '@/app/page';
const original = new File(['course-a'],'course-a.pdf');
const context = {courseName:'Course A',document:{id:'a',fingerprint:'fixture'},onBack(){}};
function App() {
  const [file,setFile] = useState(original);
  const [course,setCourse] = useState(context);
  window.reloadContext = () => setCourse({...context});
  window.clearContext = () => setCourse(null);
  window.openAnother = () => setFile(new File(['course-b'],'course-b.pdf'));
  return <PdfReader initialFile={file} courseContext={course} onOpenCourses={() => {}} onStandaloneImport={() => setCourse(null)} />;
}
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
async function waitFor(label,predicate) {
  for(let i=0;i<300;i++){if(predicate()) return;await sleep(20)}
  throw new Error('Timeout: '+label+' '+document.body.textContent.slice(-600));
}
const check = (value,message) => {if(!value) throw new Error(message)};
window.runReaderRegression = async () => {
  await waitFor('initial PDF', () => document.querySelector('.pdf-page canvas'));
  await sleep(100);
  check(window.pdfLoads === 1, 'initial PDF should load once under StrictMode');
  window.reloadContext(); await sleep(250);
  check(window.pdfLoads === 1, 'context reload repeated PDF import: expected 1, observed ' + window.pdfLoads);
  // The production standalone-import callback clears context while initialFile still points to A.
  [...document.querySelectorAll('button')].find((button) => button.textContent.includes('更换 PDF')).click();
  await waitFor('import dialog', () => document.querySelector('input[type=file]'));
  const input = document.querySelector('input[type=file]');
  const transfer = new DataTransfer(); transfer.items.add(new File(['standalone'],'standalone.pdf',{type:'application/pdf'}));
  input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor('standalone PDF', () => document.querySelector('main')?.textContent.includes('standalone.pdf'));
  await sleep(350);
  check(window.pdfLoads === 2, 'clearing context re-imported old initial PDF');
  check(document.querySelector('main')?.textContent.includes('standalone.pdf'), 'old course PDF replaced standalone PDF');
  window.openAnother();
  await waitFor('explicit new file', () => document.querySelector('main')?.textContent.includes('course-b.pdf'));
  check(window.pdfLoads === 3, 'new File must still import: observed ' + window.pdfLoads);
  return {loads:window.pdfLoads};
};
`;

void test('initial PDF is consumed once across course reload, standalone import and StrictMode', {
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
    assert.match(output, /READER_OK .*"loads":3/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
