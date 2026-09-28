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
window.renderMode = 'reject'; window.renderCalls = 0; window.cancelCalls = 0;
export const fixtureDoc = {getPage:async () => {
  if(window.renderMode === 'page') throw new Error('page unavailable');
  return {userUnit:1, getViewport:({scale}) => ({width:600*scale,height:800*scale}),
    getTextContent:async () => ({items:[]}),
    render:() => {
      window.renderCalls++;
      if(window.renderMode === 'throw') throw new Error('render threw');
      let reject;
      const promise = window.renderMode === 'pending' ? new Promise((_resolve, fail) => {reject=fail;}) :
        window.renderMode === 'reject' ? Promise.reject(new Error('render failed')) : Promise.resolve();
      return {promise,cancel(){window.cancelCalls++;reject?.(new Error('cancelled'))}};
    }};
}};
export async function loadPdfjs() {return {TextLayer:class {async render(){} cancel(){}}};}
`;
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PdfPageCanvas} from '@/app/page';
import {fixtureDoc} from '@/lib/pdfjs';
const context = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(...args) {return window.renderMode === 'context' ? null : context.apply(this,args)};
const noop = () => {};
function App() {
  const [page,setPage] = useState(1);
  window.changePage = () => setPage((value) => value+1);
  return <div style={{position:'relative',width:300,height:400}}><PdfPageCanvas pdfDoc={fixtureDoc} pageNumber={page}
    width={300} height={400} activeParagraphs={[]} revealRequest={null} onParagraphsReady={noop} onParagraphActivate={noop} /></div>;
}
createRoot(document.getElementById('root')).render(<App />);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
async function waitFor(label,predicate) {
  for(let i=0;i<300;i++){if(predicate()) return;await sleep(20)}
  throw new Error('Timeout: '+label+' '+document.body.textContent);
}
const check = (value,message) => {if(!value) throw new Error(message)};
window.runReaderRegression = async () => {
  await waitFor('render failure', () => document.querySelector('[role=alert]'));
  for(const mode of ['page','throw','context','ok']) {
    window.renderMode = mode;
    document.querySelector('button').click();
    await sleep(80);
    if(mode !== 'ok') check(document.querySelector('[role=alert]')?.textContent.includes('重试渲染第 1 页'), mode+' should be retryable');
  }
  check(!document.querySelector('[role=alert]'), 'successful retry should remove the error');
  check(!document.querySelector('.animate-spin'), 'successful retry should remove loading overlay');
  check(document.querySelector('canvas').width === 300, 'canvas should render after recovery');
  window.renderMode = 'pending'; window.changePage();
  await waitFor('pending render', () => document.querySelector('.animate-spin'));
  window.renderMode = 'ok'; window.changePage();
  await waitFor('replacement render', () => !document.querySelector('.animate-spin'));
  check(window.cancelCalls > 0, 'page changes must cancel old render tasks');
  check(!document.querySelector('[role=alert]'), 'cancelled old render must not show an error over the new page');
  return {renderRecovery:true,cancelledSafely:true};
};
`;

void test('canvas page, context and render failures show retry; successful retry and cancellation clear overlays', {
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
      build.onLoad({filter:/app\/page\.tsx$/}, async (args) => ({contents:(await readFile(args.path,'utf8')).replace('function PdfPageCanvas(', 'export function PdfPageCanvas('),loader:'tsx',resolveDir:path.dirname(args.path)}));
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
    assert.match(output, /READER_OK .*"renderRecovery":true,"cancelledSafely":true/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
