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
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BackgroundTaskCenter} from '@/components/background-task-center';
import {registerTaskControl,setBackgroundSnapshot} from '@/lib/background-task-store';
const mode=new URLSearchParams(location.search).get('mode');
const desktop=mode.startsWith('desktop');
const now=new Date().toISOString();
let tasks=['queued','paused','failed','completed','cancelled','running','review'].map((status,index)=>({id:'course:'+status,courseId:'course',courseName:'测试课程',documentId:status,fileName:status+'.pdf',phase:status==='failed'?'course':'document',status,updatedAt:now,...(status==='failed'?{error:'模型临时不可用；单篇成果保留'}:{}),...(status==='running'?{completedUnits:3,totalUnits:8,message:'OCR 3/8',startedAt:now,lastActivityAt:now,attempt:2,resumedAt:now}:{})}));
const fixture={commands:[],opened:[],failNext:false,failOpen:false,hold:false,release:null,subscription:null,initial:null};window.fixture=fixture;
const snapshot=()=>({tasks:tasks.map(task=>({...task})),executor:desktop?'desktop':'browser',available:true});
const publish=(value=snapshot())=>desktop?fixture.subscription(value):setBackgroundSnapshot(value);
async function control(command){
 fixture.commands.push(command);
 if(fixture.failNext){fixture.failNext=false;throw new Error('操作失败：模拟临时断开');}
 if(fixture.hold)await new Promise(resolve=>{fixture.release=resolve});
 tasks=tasks.map(task=>{
  const matched=command.documentId?task.documentId===command.documentId:command.action==='pause-queued'?task.status==='queued':command.action==='resume-paused'?task.status==='paused':task.status==='failed';
  if(!matched)return task;
  const status=command.action==='pause'||command.action==='pause-queued'?'paused':command.action==='cancel'?'cancelled':'queued';
  return {...task,status,error:undefined};
 });publish();
}
if(desktop){window.yeyuDesktop={getBackgroundSnapshot:()=>new Promise((resolve,reject)=>{fixture.initial=resolve;fixture.initialReject=reject}),controlBackgroundTask:control,onBackgroundSnapshot:listener=>{fixture.subscription=listener;return()=>{fixture.subscription=null}}};}
else{registerTaskControl(control);setBackgroundSnapshot(snapshot());}
createRoot(document.getElementById('root')).render(<BackgroundTaskCenter onOpenDocument={async(courseId,documentId,panel)=>{if(fixture.failOpen)throw new Error('PDF 暂时无法读取');fixture.opened.push({courseId,documentId,panel});}}/>);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw new Error(message)};
const button=(text,container=document)=>[...container.querySelectorAll('button')].find(node=>node.textContent.trim()===text);
const row=id=>[...document.querySelectorAll('[aria-label="后台任务列表"] li')].find(node=>node.querySelector('p')?.textContent===id+'.pdf');
const select=value=>{const input=document.querySelector('[aria-label="筛选后台任务"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('change',{bubbles:true}));};
async function waitFor(label,predicate){for(let i=0;i<200;i++){if(predicate())return;await sleep(10)}throw new Error('Timeout '+label+' '+document.body.textContent.slice(-1200));}
window.runTaskCenter=async()=>{
 await waitFor('entry',()=>document.querySelector('[aria-label="打开后台任务中心"]'));
 if(desktop){await waitFor('desktop subscribed',()=>fixture.subscription&&fixture.initial);publish();if(mode==='desktop-failure')fixture.initialReject(new Error('late initial snapshot failure'));else fixture.initial({tasks:[],executor:'desktop',available:true});await sleep(30);}
 check(document.querySelector('[aria-label="打开后台任务中心"]').textContent.includes('1 项失败')&&document.querySelector('[aria-label="打开后台任务中心"]').textContent.includes('1 项待审阅'),'running jobs hid attention counts');
 if(mode==='browser-narrow'){
  const entry=document.querySelector('[aria-label="打开后台任务中心"]');
  const bounds=entry.getBoundingClientRect();const range=document.createRange();range.selectNodeContents(entry);const content=range.getBoundingClientRect();
  check(content.left>=bounds.left&&content.right<=bounds.right&&bounds.left>=0&&bounds.right<=innerWidth,'task counts overflow narrow viewport '+JSON.stringify({bounds:bounds.toJSON(),content:content.toJSON(),viewport:innerWidth}));
  entry.focus();check(document.activeElement===entry,'narrow task entry unreachable by focus');entry.click();await waitFor('narrow dialog opens',()=>document.querySelector('[role="dialog"]'));
  return {narrow:true};
 }
 document.querySelector('[aria-label="打开后台任务中心"]').click();
 await waitFor('dialog',()=>document.querySelector('[role="dialog"]'));
 check(row('running')&&row('queued')&&row('paused')&&row('failed'),'active filter lost pending states');
 check(!row('completed')&&!row('cancelled'),'active filter includes terminal states');
 check(row('running').textContent.includes('已处理 3 / 8')&&row('running').textContent.includes('第 2 次执行')&&row('running').textContent.includes('已恢复上次未完成任务'),'actual progress/recovery details missing');
 check(document.body.textContent.includes(desktop?'整理由桌面宿主管理':'请保持此浏览器页面打开'),'executor-specific lifecycle guidance missing');
 button('暂停',row('running')).click();await waitFor('running paused',()=>button('继续',row('running')));
 check(fixture.commands.at(-1).action==='pause'&&fixture.commands.at(-1).courseId==='course'&&fixture.commands.at(-1).documentId==='running','pause lost task identity');
 button('继续',row('running')).click();await waitFor('resumed queued',()=>row('running').textContent.includes('排队中'));
 button('取消任务',row('queued')).click();await waitFor('cancel removed from active',()=>!row('queued'));
 select('all');await waitFor('all includes cancellation',()=>row('queued')?.textContent.includes('已取消'));
 check(row('completed')&&row('cancelled'),'all filter misses terminal tasks');
 select('failed');await waitFor('failure filter',()=>row('failed')&&!row('running'));
 check(row('failed').textContent.includes('单篇成果保留'),'failure evidence missing');
 fixture.failNext=true;button('重试',row('failed')).click();await waitFor('control error',()=>document.body.textContent.includes('操作失败：模拟临时断开'));
 check(row('failed').textContent.includes('模型临时不可用'),'failed command discarded existing task error');
 button('重试',row('failed')).click();await waitFor('successful retry removes failed row',()=>!row('failed'));
 check(document.body.textContent.includes('当前没有符合筛选条件的任务'),'empty filter feedback missing');
 check(!document.body.textContent.includes('操作失败：模拟临时断开'),'successful retry did not clear error');
 select('all');await waitFor('all returned',()=>row('failed'));
 fixture.hold=true;button('暂停排队任务').click();await waitFor('bulk pending',()=>fixture.release);
 check(button('继续暂停任务').disabled&&button('阅读 PDF',row('running')).disabled,'in-flight command did not disable duplicate actions');
 fixture.hold=false;fixture.release();await waitFor('bulk pause done',()=>!button('继续暂停任务').disabled&&row('failed').textContent.includes('已暂停'));
 button('继续暂停任务').click();await waitFor('bulk resume done',()=>row('failed').textContent.includes('排队中'));
 tasks=tasks.map(task=>task.documentId==='failed'?{...task,status:'failed',error:'模拟失败'}:task);publish();await waitFor('failed task returned',()=>!button('重试失败任务').disabled);
 button('重试失败任务').click();await waitFor('bulk retry done',()=>row('failed').textContent.includes('排队中'));
 publish({...snapshot(),available:false,error:'后台服务未连接'});await waitFor('unavailable feedback',()=>document.body.textContent.includes('后台服务未连接'));
 const commandsBefore=fixture.commands.length;
 check(button('暂停排队任务').disabled&&button('继续暂停任务').disabled&&button('重试失败任务').disabled,'unavailable bulk controls enabled');
 check(button('暂停',row('running')).disabled&&button('取消任务',row('running')).disabled&&button('重试',row('cancelled')).disabled,'unavailable task controls enabled');
 button('暂停',row('running')).click();await sleep(20);check(fixture.commands.length===commandsBefore,'disabled command invoked handler');
 check(!button('阅读 PDF',row('running')).disabled,'executor unavailable should not block already-saved PDFs');
 publish();fixture.failOpen=true;button('阅读 PDF',row('running')).click();await waitFor('open failure retained',()=>document.body.textContent.includes('PDF 暂时无法读取'));
 check(document.querySelector('[role="dialog"]'),'failed open closed task center');fixture.failOpen=false;
 select('completed');await waitFor('completed filter',()=>row('completed')&&!row('running'));
 button('打开成果',row('completed')).click();await waitFor('open result closes modal',()=>!document.querySelector('[role="dialog"]'));
 check(fixture.opened.at(-1).documentId==='completed'&&fixture.opened.at(-1).courseId==='course','open artifact lost document identity');
 check(fixture.opened.at(-1).panel==='summary','completed task must request summary explicitly');
 const actions=fixture.commands.map(command=>command.action);for(const action of ['pause','resume','cancel','retry','pause-queued','resume-paused','retry-failed'])check(actions.includes(action),'missing control '+action);
 return {desktop,initialRejected:mode==='desktop-failure',actions:true,filters:true,unavailable:true,errors:true,open:true};
};
`;

void test(
  'task center controls, filters, failures and saved PDF access work in browser and desktop modes',
  {
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !existsSync('/usr/bin/xvfb-run')
        ? 'Requires a display or Xvfb'
        : false,
  },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'yeyu-task-center-'),
    );
    const cssPath = path.join(root, 'app/globals.css');
    const css = (await require('postcss')([require('@tailwindcss/postcss')({base:root})])
      .process(await readFile(cssPath, 'utf8'), {from:cssPath})).css;
    const bundle = await build({
      stdin: { contents: entry, loader: 'tsx', resolveDir: root },
      alias: { '@': root },
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
    });
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`,
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
    const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(async()=>{
      const win=new BrowserWindow({width:1200,height:900,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      try{const results=[];for(const mode of ['browser-narrow','browser','desktop','desktop-failure']){win.setSize(mode==='browser-narrow'?360:1200,900);await win.loadURL(${JSON.stringify(url)}+'?mode='+mode);results.push(await win.webContents.executeJavaScript('window.runTaskCenter()',true));}console.log('TASK_CENTER_OK '+JSON.stringify(results));win.destroy();app.exit(0);}catch(error){console.error(error);win.destroy();app.exit(1);}
    });`,
    );
    try {
      const electron = require('electron') as string;
      const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
      const args = [
        ...(process.platform === 'linux' &&
        process.env.DISPLAY &&
        process.env.WAYLAND_DISPLAY
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
        /TASK_CENTER_OK .*"desktop":false.*"desktop":true.*"initialRejected":true/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
