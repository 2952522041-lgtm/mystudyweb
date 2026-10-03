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
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AIChatPanel } from '@/components/ai-chat-panel';
import { createChatService } from '@/lib/chat-cache';
const settings = {baseUrl:'https://fixture.invalid/v1',apiKey:'fixture',model:'test',visionConfirmed:true};
const doc = {numPages:3,getPage:async number => ({getViewport:() => ({width:400,height:500}),getTextContent:async () => ({items:[{str:'Source page '+number,transform:[12,0,0,12,20,450],width:100,height:12}]}),render:()=>({promise:Promise.resolve(),cancel(){}})})};
let calls=0;
window.fetch=async()=>{calls++;return new Response(new ReadableStream({start(controller){window.answerStream=controller;}}),{headers:{'content-type':'text/event-stream'}})};
const sendChunk=(content,finish=null)=>window.answerStream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:finish}]})+'\\n\\n'));
function App(){
  const [page,setPage]=useState(1);const [fingerprint,setFingerprint]=useState('ux-doc');const [draft,setDraft]=useState(null);
  window.navigateChat=(next,fp='ux-doc')=>{setPage(next);setFingerprint(fp)};
  window.offerQuestion=()=>setDraft({id:'summary-1',text:'解释总结中的能量守恒',pageNumber:1});
  return <AIChatPanel pdfDoc={doc} fingerprint={fingerprint} pageNumber={page} settings={settings} onOpenSettings={()=>{}} questionDraft={draft} onQuestionDraftHandled={()=>setDraft(null)}/>;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw new Error(message)};
const input=()=>document.querySelector('textarea');
const setInput=value=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input(),value);input().dispatchEvent(new Event('input',{bubbles:true}))};
const scope=value=>{const select=document.querySelector('select');select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}))};
async function waitFor(label,predicate){for(let i=0;i<300;i++){if(predicate())return;await sleep(20)}throw new Error('Timeout '+label+' '+document.body.textContent.slice(-500))}
window.runChatUx=async()=>{
 await waitFor('history',()=>document.body.textContent.includes('历史回答 23'));
 const scroll=document.querySelector('.ai-message-scroll');
 await sleep(100);check(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<5,'history did not start at latest');
 setInput('第一页草稿');await sleep(30);window.navigateChat(2);await sleep(80);check(input().value==='','draft leaked between pages');
 setInput('第二页草稿');await sleep(30);scope('document');await sleep(80);check(input().value==='','page draft leaked into document');
 setInput('全文草稿');await sleep(30);window.navigateChat(1);await sleep(80);check(input().value==='全文草稿','document draft changed with page');
 scope('page');await sleep(80);check(input().value==='第一页草稿','first-page draft lost');
 window.navigateChat(1,'other-doc');await sleep(80);check(input().value==='','draft leaked between documents');setInput('另一份文档草稿');await sleep(30);window.navigateChat(1);await sleep(80);check(input().value==='第一页草稿','original document draft lost');
 window.offerQuestion();await waitFor('summary draft',()=>input().value==='解释总结中的能量守恒');check(calls===0,'summary question sent without review');
 setInput('正在组合的中文');await sleep(30);input().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
 input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true}));await sleep(60);check(calls===0,'IME Enter sent a question');
 input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await sleep(60);check(calls===0,'composition state was ignored');
 input().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
 input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}));await sleep(40);check(calls===0,'IME keyCode fallback sent a question');
 input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await waitFor('stream started',()=>window.answerStream);check(calls===1,'normal Enter failed to send once');
 sendChunk('第一段回答\\n\\n'.repeat(40));await waitFor('first chunk',()=>document.body.textContent.includes('第一段回答'));await sleep(80);check(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<5,'stream did not follow near bottom');
 scroll.scrollTop=120;scroll.dispatchEvent(new Event('scroll',{bubbles:true}));await sleep(80);const anchored=scroll.scrollTop;
 sendChunk('新增解释\\n\\n'.repeat(70));await waitFor('second chunk',()=>document.body.textContent.includes('新增解释'));await sleep(100);check(Math.abs(scroll.scrollTop-anchored)<2,'stream moved user reading old messages');
 const latest=[...document.querySelectorAll('button')].find(button=>button.textContent.includes('回到最新回答'));check(latest,'missing jump to latest');latest.click();await sleep(80);check(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<5,'jump to latest failed');
 sendChunk('最后一段', 'stop');window.answerStream.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));window.answerStream.close();await waitFor('completed',()=>!document.querySelector('[aria-label="停止回答"]'));
 setInput('重启后继续编辑');await sleep(30);return {calls,scroll:true,ime:true,drafts:true};
};
window.checkDraftAfterReload=async()=>{await waitFor('restored draft',()=>input()?.value==='重启后继续编辑');window.navigateChat(2);await sleep(100);check(input().value==='第二页草稿','page two draft lost after reload');scope('document');await sleep(100);check(input().value==='全文草稿','document draft lost after reload');check(calls===0,'reload sent AI request');return true};
(async()=>{
 const service=createChatService();
 if(!localStorage.getItem('ux-seeded')){
  const now=new Date().toISOString();await service.save({fingerprint:'ux-doc',pageNumber:1,messages:Array.from({length:24},(_,i)=>({id:'seed-'+i,role:i%2?'assistant':'user',content:'历史回答 '+i+'：'+('这是供阅读的历史内容。'.repeat(12)),createdAt:now})),createdAt:now,updatedAt:now});localStorage.setItem('ux-seeded','1');
 }
 createRoot(document.getElementById('root')).render(<App/>);
})();
`;
void test('chat preserves IME input, keyed drafts and scroll position through streaming and reload', {
  skip: process.platform === 'linux' && !process.env.DISPLAY && !existsSync('/usr/bin/xvfb-run')
    ? 'Requires a display or Xvfb for Chromium interaction tests' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-chat-ux-'));
  const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root },
    alias: { '@': root }, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><head><style>.ai-chat-panel{height:650px;display:flex;flex-direction:column}.ai-message-scroll{height:350px;flex:1;overflow:auto;min-height:0}.ai-context-bar,.ai-composer{flex:none}.ai-message-scroll p{margin:18px 0}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`);
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
        const result = await win.webContents.executeJavaScript('window.runChatUx()', true);
        await win.reload(); await new Promise(resolve => win.webContents.once('did-finish-load', resolve)); await win.webContents.executeJavaScript('window.checkDraftAfterReload()', true); console.log('CHAT_UX_OK ' + JSON.stringify(result)); win.destroy(); app.exit(0);
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
    assert.match(output, /CHAT_UX_OK .*"calls":1,"scroll":true,"ime":true,"drafts":true/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
