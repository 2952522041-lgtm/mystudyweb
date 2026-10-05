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
  getTextContent:async () => ({items:[{str:'Enough native source text for the reader translation regression. This page has a complete paragraph explaining how to preserve reading state across panels.',transform:[12,0,0,12,20,350],width:300,height:12}]}),
  render:() => ({promise:Promise.resolve(),cancel(){}})})};
export async function loadPdfjs() {return {getDocument:() => {window.pdfLoads++;return {...task,promise:window.corruptPdf ? Promise.reject(new Error('Invalid PDF')) : Promise.resolve(doc)}},TextLayer:class {async render(){} cancel(){}}};}
`;
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PdfReader} from '@/app/page';
import {createReaderService,computeFileFingerprint} from '@/lib/reader-cache';
const browserErrors=[];
window.translationCalls=[];window.translationAborts=0;
window.addEventListener('error',event=>browserErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>browserErrors.push(String(event.reason)));
const file=new File(['reading-view-fixture'],'view.pdf');
const service=createReaderService();
let fingerprint;
function App(){
 const [shown,setShown]=useState(false);const [instance,setInstance]=useState(0);const [explicit,setExplicit]=useState(undefined);const [initialFile,setInitialFile]=useState(file);const [panel,setPanel]=useState(undefined);const [settingsRequest,setSettingsRequest]=useState(0);
 window.hideReader=()=>setShown(false);window.showReader=()=>setShown(true);
 window.reopenReader=()=>{setInstance(value=>value+1)};
 window.requestSettings=()=>{setShown(false);setSettingsRequest(value=>value+1)};
 window.openSummary=()=>{setPanel('summary');setInitialFile(new File(['reading-view-fixture'],'view.pdf'))};
 window.openFixtureFile=(next,nextFingerprint)=>{fingerprint=nextFingerprint;setPanel('summary');setInitialFile(next)};
 window.openSourcePage=()=>{setExplicit(1);setInitialFile(new File(['reading-view-fixture'],'view.pdf'))};
 return <div hidden={!shown}><PdfReader key={instance} initialFile={initialFile} suspended={!shown} settingsRequest={settingsRequest} courseContext={{initialPage:explicit,initialPanel:panel,courseId:'fixture',courseName:'Fixture',document:{fingerprint,id:'doc',fileName:'view.pdf'},digest:{documentId:'doc',fingerprint,schemaVersion:3,promptVersion:'fixture',updatedAt:'2026-10-05T00:00:00.000Z',title:'Summary fixture',overview:'Overview',sections:[],concepts:[],relations:[],unresolvedQuestions:[],sourcePages:[1]},onBack(){}}} onOpenCourses={()=>{}}/></div>;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw new Error(message)};
async function waitFor(label,predicate){for(let i=0;i<350;i++){if(predicate())return;await sleep(20)}throw new Error('Timeout '+label+' '+document.body.textContent.slice(-500))}
const stage=()=>document.querySelector('.document-stage');
const fraction=number=>{const element=document.querySelector('[data-page="'+number+'"]');return (stage().getBoundingClientRect().top-element.getBoundingClientRect().top)/parseFloat(element.firstElementChild.style.height)};
const close=(left,right)=>Math.abs(left-right)<0.015;
const splitFraction=()=>document.querySelector('[data-slot="resizable-panel"]').getBoundingClientRect().width/document.querySelector('[data-slot="resizable-panel-group"]').getBoundingClientRect().width;
window.runReadingView=async()=>{
 await waitFor('PDF finishes loading in hidden reader',()=>document.querySelector('.pdf-page'));
 check(window.translationCalls.length===0,'hidden reader started translation');
 await sleep(100);window.showReader();
 await waitFor('fraction restored',()=>stage()&&document.querySelector('[data-page="2"]')&&close(fraction(2),.42));
 check(document.querySelector('[role="tab"][data-active]')?.textContent.includes('AI') || [...document.querySelectorAll('[role="tab"]')].some(tab=>tab.getAttribute('aria-selected')==='true'&&tab.textContent.includes('AI')),'right panel not restored');
 const panel=document.querySelector('[data-slot="resizable-panel"]');const group=document.querySelector('[data-slot="resizable-panel-group"]');
 check(close(panel.getBoundingClientRect().width/group.getBoundingClientRect().width,.62),'split width not restored');
 document.querySelector('[aria-label="放大"]').click();await sleep(180);check(close(fraction(2),.42),'zoom changed page fraction');
 window.hideReader();await sleep(150);window.showReader();await sleep(250);check(close(fraction(2),.42),'library roundtrip lost page fraction');check(close(splitFraction(),.62),'library roundtrip lost split ratio');
 const page=document.querySelector('[data-page="2"]');stage().scrollTop += .2*parseFloat(page.firstElementChild.style.height);await sleep(900);
 const record=await service.progress.load(fingerprint);check(close(record.pageFraction,.62),'in-page scroll was not saved');check(record.rightMode==='chat'&&close(record.pdfPanelPercent/100,.62),'panel settings were not saved');
 window.reopenReader();await waitFor('reopen restore',()=>document.querySelector('[data-page="2"]')&&close(fraction(2),.62));
 window.openSourcePage();await waitFor('source page one priority',()=>document.querySelector('[data-page="1"]')&&close(fraction(1),0));
 document.querySelector('[aria-label="收起阅读辅助区"]').click();await sleep(100);
 window.openSummary();await waitFor('explicit summary reopens hidden panel',()=>[...document.querySelectorAll('[role=tab]')].some(tab=>tab.getAttribute('aria-selected')==='true'&&tab.textContent.includes('PDF 总结')));
 await waitFor('62 percent split restored after reopening panel',()=>close(splitFraction(),.62));
 const handle=document.querySelector('[data-slot="resizable-handle"]');
 const rect=handle.getBoundingClientRect();const x=rect.x+rect.width/2,y=rect.y+rect.height/2;
 handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0,buttons:1,clientX:x,clientY:y}));
 document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',button:0,buttons:1,clientX:x-20,clientY:y}));
 await sleep(150);
 const firstDrag=splitFraction();
 document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',button:0,buttons:1,clientX:x-80,clientY:y}));
 await sleep(150);
 const secondDrag=splitFraction();
 document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0,buttons:0,clientX:x-80,clientY:y}));
 check(firstDrag-secondDrag>.035,'continuous drag stopped after first resize: '+JSON.stringify({firstDrag,secondDrag}));
 await sleep(900);
 const draggedRecord=await service.progress.load(fingerprint);
 check(close(draggedRecord.pdfPanelPercent/100,secondDrag),'dragged split was not persisted');
 document.querySelector('[aria-label="收起阅读辅助区"]').click();await sleep(100);
 window.openSummary();
 await waitFor('dragged split restored after reopening panel',()=>document.querySelectorAll('[data-slot="resizable-panel"]').length===2&&close(splitFraction(),secondDrag));

 const hiddenFile=new File(['hidden-reading-fixture'],'hidden.pdf');
 const hiddenFingerprint=await computeFileFingerprint(await hiddenFile.arrayBuffer());
 await service.progress.save({...draggedRecord,fingerprint:hiddenFingerprint,fileName:hiddenFile.name,pdfPanelPercent:66});
 window.hideReader();await sleep(100);
 const loadsBeforeHiddenOpen=window.pdfLoads;
 window.openFixtureFile(hiddenFile,hiddenFingerprint);
 await waitFor('another PDF load starts while hidden',()=>window.pdfLoads>loadsBeforeHiddenOpen);
 await sleep(100);window.showReader();
 await waitFor('hidden reload applies its restored split',()=>close(splitFraction(),.66));

 window.requestSettings();await waitFor('settings over hidden reader',()=>document.querySelector('[role=dialog]'));
 check(document.querySelector('[role=dialog]').getBoundingClientRect().width>0,'settings portal is hidden with reader');
 check([...document.querySelectorAll('[role=dialog] [role=tab]')].some(tab=>tab.getAttribute('aria-selected')==='true'&&tab.textContent.includes('知识库 AI')),'course settings did not open knowledge tab');
 [...document.querySelectorAll('[role=dialog] button')].find(node=>node.textContent.trim()==='取消').click();await waitFor('settings closed',()=>!document.querySelector('[role=dialog]'));
 window.showReader();await sleep(100);check(document.querySelector('.pdf-page canvas'),'settings lost open PDF');check(close(splitFraction(),.66),'hidden reader lost restored split ratio');
 check(window.translationCalls.length===0,'summary/chat/settings started translation or prefetch');
 window.showReader();await sleep(100);
 const translationTab=()=>[...document.querySelectorAll('[role=tab]')].find(tab=>tab.textContent.includes('页面翻译'));
 window.blockTranslations=true;translationTab().click();
 await waitFor('translation requested when visible',()=>window.translationCalls.length>0);
 check(window.translationCalls.length===1,'unexpected initial translation requests '+JSON.stringify(window.translationCalls));
 window.hideReader();await waitFor('hidden reader aborts translation',()=>window.translationAborts===1);
 check(![...document.querySelectorAll('button[aria-label^="查看第 "]')].some(button=>button.textContent.includes('翻译中')),'cancelled translation still shows running');
 window.showReader();await waitFor('visible translation resumes',()=>window.translationCalls.length===2);
 document.querySelector('[aria-label="收起阅读辅助区"]').click();await waitFor('collapsed panel aborts translation',()=>window.translationAborts===2);
 const countWhenCollapsed=window.translationCalls.length;await sleep(250);check(window.translationCalls.length===countWhenCollapsed,'collapsed panel started a request');
 window.openSummary();await sleep(200);check(window.translationCalls.length===countWhenCollapsed,'opening summary restarted translation');
 translationTab().click();await waitFor('translation can restart',()=>window.translationCalls.length===3);
 [...document.querySelectorAll('[role=tab]')].find(tab=>tab.textContent.includes('AI 答疑')).click();await waitFor('chat aborts unused translation',()=>window.translationAborts===3);
 window.blockTranslations=false;translationTab().click();
 await waitFor('current translation and next-page prefetch',()=>window.translationCalls.some(call=>call.task==='prefetch'));
 await sleep(300);window.hideReader();const cachedCalls=window.translationCalls.length;await sleep(200);window.showReader();await sleep(350);
 check(window.translationCalls.length===cachedCalls,'completed translation cache was lost on hide/show');
 check(browserErrors.length===0,'uncaught reader errors: '+browserErrors.join('; '));
 return {fraction:true,panels:true,sourcePriority:true};
};
(async()=>{fingerprint=await computeFileFingerprint(await file.arrayBuffer());await service.progress.save({fingerprint,fileName:file.name,pageCount:3,lastPage:2,pageFraction:.42,rightMode:'chat',pdfPanelPercent:62,zoom:100,targetLanguage:'简体中文',updatedAt:new Date().toISOString()});createRoot(document.getElementById('root')).render(<App/>);})();
`;
void test('reader preserves hidden-load state and continuous dragging across panel reopening', {
  skip: process.platform === 'linux' && !process.env.DISPLAY && !existsSync('/usr/bin/xvfb-run')
    ? 'Requires a display or Xvfb for Chromium interaction tests' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-reading-view-'));
  const postcss = require('postcss');
  const tailwind = require('@tailwindcss/postcss');
  const cssPath = path.join(root, 'app/globals.css');
  const css = (await postcss([tailwind({base:root})]).process(await readFile(cssPath, 'utf8'), {from:cssPath})).css;
  const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root },
    plugins: [{name:'reader-fixture',setup(build) {
      build.onLoad({filter:/lib\/pdfjs\.ts$/}, () => ({contents:mockPdfjs,loader:'ts'}));
      build.onLoad({filter:/lib\/reader-cache\.ts$/}, async (args) => ({contents:(await readFile(args.path,'utf8'))
        .replace('export async function resolvePageTranslation(', 'async function originalResolvePageTranslation(')+`
        export async function resolvePageTranslation(input: Parameters<typeof originalResolvePageTranslation>[0]) {
          (window as any).translationCalls.push({page:input.request.pageNumber,task:input.request.task});
          if ((window as any).blockTranslations) return new Promise<never>((_resolve,reject)=>{
            const abort=()=>{(window as any).translationAborts++;reject(new DOMException('Cancelled','AbortError'));};
            if(input.signal?.aborted) abort(); else input.signal?.addEventListener('abort',abort,{once:true});
          });
          return originalResolvePageTranslation(input);
        }`,loader:'ts',resolveDir:path.dirname(args.path)}));
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
      const win = new BrowserWindow({width: 1000, height: 420, show: true,
        webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
      win.webContents.on('console-message', details=>console.log(details.message));
      try {
        await win.loadURL(${JSON.stringify(url)});
        const result = await win.webContents.executeJavaScript('window.runReadingView()', true);
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
    assert.match(output, /READER_OK .*"fraction":true,"panels":true,"sourcePriority":true/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
