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
import {PdfReader} from '@/app/page';
function pdfFile(name = 'comparison.pdf', blank = false) {
  const stream = blank ? '' : 'BT /F1 12 Tf 40 750 Td (First paragraph of the comparison fixture) Tj 0 -16 Td (continues with enough selectable text.) Tj 0 -434 Td (Second paragraph is far below the first) Tj 0 -16 Td (and should scroll into view when selected.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length '+stream.length+' >>\\nstream\\n'+stream+'\\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'];
  let pdf = '%PDF-1.4\\n'; const offsets = [0];
  objects.forEach((object,index) => {offsets.push(pdf.length);pdf += (index+1)+' 0 obj\\n'+object+'\\nendobj\\n';});
  const xref = pdf.length;
  pdf += 'xref\\n0 7\\n0000000000 65535 f \\n'+offsets.slice(1).map((offset)=>String(offset).padStart(10,'0')+' 00000 n \\n').join('');
  pdf += 'trailer\\n<< /Size 7 /Root 1 0 R >>\\nstartxref\\n'+xref+'\\n%%EOF';
  return new File([pdf],name,{type:'application/pdf'});
}
const original = pdfFile();
function App() {
  const [file, setFile] = useState(original);
  window.openBlank = () => setFile(pdfFile('blank.pdf',true));
  window.reopenOriginal = () => setFile(new File([original], 'comparison.pdf', {type:'application/pdf'}));
  return <PdfReader initialFile={file} onOpenCourses={() => {}} />;
}
createRoot(document.getElementById('root')).render(<App />);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
async function waitFor(label,predicate) {
  for(let i=0;i<400;i++){if(predicate()) return;await sleep(20)}
  throw new Error('Timeout: '+label+' '+document.querySelector('main')?.textContent.slice(-900));
}
const check = (value,message) => {if(!value) throw new Error(message)};
const target = (index) => document.querySelector('.translation-copy [data-paragraph-index="'+index+'"]');
const source = (page,index) => document.querySelector('.pdf-text-layer[data-page-number="'+page+'"] [data-source-paragraphs~="'+index+'"]');
const active = () => [...document.querySelectorAll('.paragraph-source-active')];
window.runReaderRegression = async () => {
  await waitFor('real PDF text layer and translation', () => source(1,1) && target(1));
  [...document.querySelectorAll('button')].find((button) => button.textContent === '快捷键说明').click();
  await waitFor('shortcut help', () => document.querySelector('[role="dialog"]')?.textContent.includes('Alt + 1'));
  const helpPage = document.querySelector('input[inputmode="numeric"]').value;
  document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}));
  await sleep(40);
  check(document.querySelector('input[inputmode="numeric"]').value === helpPage, 'help dialog allowed page navigation');
  [...document.querySelectorAll('button')].find((button) => button.textContent === '知道了').click();
  await waitFor('help closed', () => !document.querySelector('[role="dialog"]'));
  const stage = document.querySelector('.document-stage');
  check(source(1,1).getBoundingClientRect().top > stage.getBoundingClientRect().bottom, 'fixture second paragraph should be below viewport');
  target(1).click();
  await waitFor('target to source', () => active().length === 2 && active()[0].dataset.sourceParagraphs === '1');
  check(active().every((span) => span.getBoundingClientRect().top >= stage.getBoundingClientRect().top && span.getBoundingClientRect().bottom <= stage.getBoundingClientRect().bottom), 'target did not reveal all lines of the source paragraph');
  check(target(1).dataset.active === 'true', 'target highlight missing');
  check(getComputedStyle(source(1,1)).backgroundColor !== 'rgba(0, 0, 0, 0)', 'source highlight has no color');
  // A1 drag selection must not become an A2 click.
  const range = document.createRange(); range.selectNodeContents(source(1,0));
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  source(1,0).click(); await sleep(30);
  check(target(1).dataset.active === 'true', 'selection drag changed the paragraph');
  window.getSelection().removeAllRanges();
  const right = document.querySelector('.translation-scroll');
  right.scrollTop = right.scrollHeight;
  source(1,0).click();
  await waitFor('source to target', () => target(0)?.dataset.active === 'true');
  check(target(0).getBoundingClientRect().top >= right.getBoundingClientRect().top-1, 'source did not reveal target');
  target(1).querySelector('button').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await waitFor('keyboard activation', () => target(1).dataset.active === 'true');
  const beforeZoom = source(1,1);
  document.querySelector('[aria-label="放大"]').click();
  await waitFor('zoom rebuild preserves geometry and highlight', () => source(1,1) !== beforeZoom && source(1,1)?.classList.contains('paragraph-source-active'));
  document.querySelector('[aria-label="查看第 2 页"]').click();
  await waitFor('second-page translation', () => target(1)?.textContent.includes('第 2 页'));
  check(!active().length, 'highlight leaked to another page');
  source(2,1).click();
  await waitFor('second-page reverse activation', () => target(1)?.dataset.active === 'true');
  check(active().every((span)=>span.closest('.pdf-text-layer').dataset.pageNumber === '2'), 'wrong page highlighted');
  const language = document.querySelector('[aria-label="目标语言"]');
  language.value = '日本語'; language.dispatchEvent(new Event('change',{bubbles:true}));
  await sleep(100);
  check(!active().length, 'old-language highlight leaked');
  await waitFor('new-language translation', () => target(1));
  target(0).click(); await waitFor('new-language activation', () => target(0).dataset.active === 'true');
  window.reopenOriginal();
  await waitFor('cached translation after reopen', () => target(0) && document.querySelector('.translation-copy')?.textContent.includes('本机缓存'));
  check(!active().length, 'reopening retained an old selection');
  target(1).click(); await waitFor('cached correspondence', () => active().length === 2);
  return {realTextLayer:true, bidirectional:true, page:2};
};
window.runBlankRegression = async () => {
  window.openBlank();
  await waitFor('blank PDF', () => document.querySelector('main')?.textContent.includes('blank.pdf') && document.querySelector('main')?.textContent.includes('该页无可选文字'));
  check(!active().length && !target(0), 'blank/replaced PDF retained stale correspondence');
  return {realTextLayer:true, bidirectional:true, page:2};
};
`;

void test('real PDF paragraph comparison supports both directions, scroll, zoom, language and document isolation', {
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
      build.onLoad({filter:/app\/page\.tsx$/}, async (args) => ({contents:(await readFile(args.path,'utf8')).replace('function PdfReader(', 'export function PdfReader('),loader:'tsx',resolveDir:path.dirname(args.path)}));
    }}], alias: { '@': root }, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  const worker = await readFile(path.join(root, 'public/pdf.worker.min.mjs'));
  const server = http.createServer((request, response) => {
    if (request.url === '/pdf.worker.min.mjs') { response.setHeader('content-type','text/javascript'); response.end(worker); return; }
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
        await win.webContents.executeJavaScript('window.runBlankRegression()', true);
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
    assert.match(output, /READER_OK .*"realTextLayer":true,"bidirectional":true,"page":2/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
