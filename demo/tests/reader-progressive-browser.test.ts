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
let release;
const delayed = new Promise((resolve) => { release = resolve; });
window.releaseSizes = () => { window.sizesReleased = true; release(); };
const task = {destroy: async () => {}};
const doc = {numPages:20, loadingTask:task, getPage:async (number) => {
  if (number === 2 && !window.sizesReleased) await delayed;
  return {userUnit:1, getViewport:({scale}) => ({width:600*scale,height:(number === 1 ? 800 : number % 2 ? 1000 : 400)*scale}),
    getTextContent:async () => ({items:[{str:'This is enough extractable text for the reader fixture.',transform:[12,0,0,12,20,350],width:300,height:12}]}),
    render:() => ({promise:Promise.resolve(),cancel(){}})};
}};
export async function loadPdfjs() {return {getDocument:() => ({...task,promise:Promise.resolve(doc)}),TextLayer:class {async render(){} cancel(){}}};}
`;
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PdfReader} from '@/app/page';
createRoot(document.getElementById('root')).render(<PdfReader initialFile={new File(['fixture'],'progressive.pdf')} onOpenCourses={() => {}} />);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
async function waitFor(label,predicate) {
  for(let i=0;i<300;i++){if(predicate()) return;await sleep(20)}
  throw new Error('Timeout: '+label+' '+document.body.textContent.slice(-600));
}
const check = (value,message) => {if(!value) throw new Error(message)};
window.runReaderRegression = async () => {
  await waitFor('first page before blocked second-page dimensions', () => document.querySelector('.pdf-page canvas'));
  check(!window.sizesReleased, 'reader waited for all dimensions');
  check(document.querySelectorAll('.pdf-page').length === 20, 'missing estimated page slots');
  document.querySelector('[aria-label="查看第 15 页"]').click();
  await waitFor('jump to unmeasured page', () => document.querySelector('[data-page="15"] canvas'));
  const stage = document.querySelector('.document-stage');
  const target = document.querySelector('[data-page="15"]');
  await sleep(100);
  check(Math.abs(target.getBoundingClientRect().top-stage.getBoundingClientRect().top)<3, 'estimated jump mispositioned');
  window.releaseSizes();
  await sleep(700);
  check(Math.abs(target.getBoundingClientRect().top-stage.getBoundingClientRect().top)<3, 'background dimensions moved the target: ' + JSON.stringify({top:target.getBoundingClientRect().top,stage:stage.getBoundingClientRect().top,scroll:stage.scrollTop, width:target.clientWidth, heights:[...document.querySelectorAll('.pdf-page')].slice(0,15).map((p)=>p.clientHeight)}));
  check(document.querySelector('[data-page="15"].pdf-page-current'), 'current-page tracking drifted');
  check(document.querySelectorAll('.pdf-page canvas').length < 12, 'virtualization rendered every page');
  const visible = (element) => {const rect=element.getBoundingClientRect();return rect.height>0 && rect.top>=0 && rect.bottom<=innerHeight+1;};
  check(visible(document.querySelector('[aria-label="阅读器状态栏"]')), 'short window clipped the status bar');
  check(visible(document.querySelector('[aria-label="下一页"]')), 'short window clipped page controls');
  [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes('AI 答疑')).click();
  await sleep(80);
  check(visible(document.querySelector('[aria-label="AI 答疑输入"]')), 'short window clipped the AI composer');
  check(visible(document.querySelector('[aria-label="发送问题"]')), 'short window clipped send controls');
  return {jump:15, shortWindow:true};
};
`;

void test('reader preserves progressive jumps and keeps controls visible in a 420px window', {
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
    assert.match(output, /READER_OK .*"jump":15,"shortWindow":true/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
