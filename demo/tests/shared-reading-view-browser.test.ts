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
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SharedPdfReader} from '@/components/shared-pdf-reader';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw new Error(message)};
async function waitFor(label,predicate){for(let i=0;i<300;i++){if(predicate())return;await sleep(20)}throw new Error('Timeout '+label+' '+document.getElementById('root').innerText.slice(-800)+' geometry='+JSON.stringify({scroll:stage()?.scrollTop,top:document.querySelector('[data-page="2"]')?.getBoundingClientRect().top,stage:stage()?.getBoundingClientRect().top,fraction:document.querySelector('[data-page="2"]')?fraction(2):null,saved:window.lastSaved}))}
const stage=()=>document.querySelector('.document-stage');
const fraction=number=>{const element=document.querySelector('[data-page="'+number+'"]');return (stage().getBoundingClientRect().top+12-element.getBoundingClientRect().top)/parseFloat(element.firstElementChild.style.height)};
const close=(left,right)=>Math.abs(left-right)<.015;
const input=()=>[...document.querySelectorAll('textarea')].find(element=>element.getBoundingClientRect().height>0);
const edit=value=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input(),value);input().dispatchEvent(new Event('input',{bubbles:true}))};
window.runSharedView=async()=>{
 await waitFor('host fractional view',()=>document.querySelector('[data-page="2"]')&&close(fraction(2),.35));
 await waitFor('chat mode restored',()=>input()&&!input().disabled);
 check(Number(document.querySelector('[aria-label="原文分栏宽度"]').value)===61,'host width not restored');
 edit('共享端中文输入');await sleep(30);input().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));await sleep(60);check(window.aiCalls===0,'shared IME sent a question');
 input().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await waitFor('shared answer',()=>window.aiCalls===1&&!input().disabled);
 edit('第二页保留草稿');await sleep(30);document.querySelector('[aria-label="下一页"]').click();await waitFor('third page',()=>document.querySelector('input[inputmode="numeric"]').value==='3'&&!input().disabled);check(input().value==='','shared draft leaked to next page');
 edit('第三页草稿');await sleep(30);document.querySelector('[aria-label="上一页"]').click();await waitFor('second draft restored',()=>input()?.value==='第二页保留草稿');
 const page=document.querySelector('[data-page="2"]');stage().scrollTop+=parseFloat(page.firstElementChild.style.height)*.4;await sleep(850);
 check(close(window.lastSaved.pageFraction,.4),'shared in-page scroll was not saved');check(window.lastSaved.rightMode==='chat'&&window.lastSaved.pdfPanelPercent===61,'shared view metadata lost');
 return {restore:true,ime:true,drafts:true};
};
createRoot(document.getElementById('root')).render(<SharedPdfReader file={new File(['fixture'],'shared.pdf')} fileKey="shared-key" courseId="course" documentId="document" hasSummary={false} hasMindmap={false} canUseAi={true} onBack={()=>{}}/>);
`;

void test('shared reader restores the host view, protects IME and persists page-specific drafts', {
  skip: process.platform === 'linux' && !process.env.DISPLAY && !existsSync('/usr/bin/xvfb-run')
    ? 'Requires a display or Xvfb for Chromium interaction tests' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-shared-view-'));
  const postcss = require('postcss');
  const tailwind = require('@tailwindcss/postcss');
  const cssPath = path.join(root, 'app/globals.css');
  const css = (await postcss([tailwind({base:root})]).process(await readFile(cssPath, 'utf8'), {from:cssPath})).css;
  const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root },
    plugins: [{name:'reader-fixture',setup(build) {
      build.onLoad({filter:/lib\/lan-share-api\.ts$/},()=>({loader:'ts',contents:`
window.aiCalls=0;
export class SharedApiError extends Error {}
export const loadSharedReadingState=async()=>({state:{page:2,zoom:100,pageFraction:.35,rightMode:'chat',pdfPanelPercent:61,version:1,updatedAt:'2026-10-02T00:00:00Z'}});
export const saveSharedReadingState=async(a,b,state)=>{window.lastSaved=state;return {state:{...state,version:state.expectedVersion+1}}};
export const loadSharedConversation=async()=>({conversation:null});
export const clearSharedConversation=async()=>({});
export const askSharedDocument=async(a,b,page,scope,question)=>{window.aiCalls++;return {conversation:{messages:[{id:'answer',role:'assistant',content:'共享答复',createdAt:'now'}]}}};
export const loadSharedTranslations=async()=>({translations:[]});
export const translateSharedPage=async()=>{throw new Error('unused')};
`}));
      build.onLoad({filter:/lib\/pdfjs\.ts$/}, () => ({contents:mockPdfjs,loader:'ts'}));
      build.onLoad({filter:/app\/page\.tsx$/}, async (args) => ({contents:(await readFile(args.path,'utf8')).replace('function PdfReader(', 'export function PdfReader('),loader:'tsx',resolveDir:path.dirname(args.path)}));
    }}], alias: { '@': root }, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`);
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
      const win = new BrowserWindow({width: 1280, height: 700, show: true,
        webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
      win.webContents.on('console-message', details=>console.log(details.message));
      try {
        await win.loadURL(${JSON.stringify(url)});
        const result = await win.webContents.executeJavaScript('window.runSharedView()', true);
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
    assert.match(output, /READER_OK .*"restore":true,"ime":true,"drafts":true/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
