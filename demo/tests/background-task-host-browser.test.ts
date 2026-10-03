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
const mocks: Record<string, string> = {
  '@/lib/course-storage/desktop-course-storage': `export class DesktopCourseStorage {
    async load(){window.fixture.loads++;return structuredClone(window.fixture.bundle);}
  }`,
  '@/lib/background-processor': `export function createBackgroundProcessor(options){
    const fixture=window.fixture;fixture.workerOptions=options;
    return {register(){fixture.registered++},unregister(){fixture.unregistered++},wake(){fixture.wakes++},resume(){fixture.resumed++},stop(){fixture.stopped++},async control(command){fixture.commands.push(command)}};
  }`,
};
const mockDependencies: import('esbuild').Plugin = {
  name: 'background-host-boundaries',
  setup(builder) {
    builder.onResolve({ filter: /^@\/lib\// }, (args) =>
      args.path in mocks
        ? { path: args.path, namespace: 'host-mock' }
        : undefined,
    );
    builder.onLoad({ filter: /.*/, namespace: 'host-mock' }, (args) => ({
      contents: mocks[args.path],
      loader: 'js',
      resolveDir: root,
    }));
  },
};
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BackgroundTaskHost} from '@/components/background-task-host';
import {updateTaskProgress} from '@/lib/background-task-store';
const mode=new URLSearchParams(location.search).get('mode');
const now=new Date().toISOString();
const fixture=window.fixture={fail:false,pending:mode==='initial-pending',pendingReject:null,changed:null,command:null,published:[],loads:0,registered:0,unregistered:0,wakes:0,resumed:0,stopped:0,unwatched:0,uncommanded:0,commands:[],bundle:{manifest:{schemaVersion:1,id:'course',name:'Test course',revision:1,createdAt:now,updatedAt:now,activeKnowledgeVersion:0,documents:[{id:'doc',fingerprint:'a'.repeat(64),fileName:'lesson.pdf',storedFileName:'lesson.pdf',pageCount:2,status:'copied',includedInCourse:false,includeConversationInsights:false,hasSummary:false,hasMindmap:false,importedAt:now,updatedAt:now,processing:{phase:'document',status:'running',options:{generateSummary:true,generateMindmap:true,mergeIntoCourse:true,includeConversationInsights:false},updatedAt:now,startedAt:now,progressRevision:1,completedUnits:1,totalUnits:2}}]},knowledge:{schemaVersion:3,courseId:'course',version:0,nodes:[],relations:[],conflicts:[],updatedAt:now},digests:{}}};
window.yeyuDesktop={
 async listCourses(){if(fixture.pending)await new Promise((resolve,reject)=>{fixture.pendingReject=reject});if(fixture.fail)throw new Error('/private/workspace unavailable sk-private-auth');return [{directoryName:'course',manifest:fixture.bundle.manifest}]},
 async publishBackgroundSnapshot(value){fixture.published.push(structuredClone(value));},
 onCoursesChanged(listener){fixture.changed=listener;return()=>{fixture.unwatched++;fixture.changed=null}},
 onBackgroundCommand(listener){fixture.command=listener;return()=>{fixture.uncommanded++;fixture.command=null}},
};
const root=createRoot(document.getElementById('root'));root.render(<BackgroundTaskHost/>);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw new Error(message)};
async function waitFor(label,predicate){for(let i=0;i<200;i++){if(predicate())return;await sleep(10)}throw new Error('Timeout '+label+' '+JSON.stringify(fixture.published));}
const latest=()=>fixture.published.at(-1);
window.runTaskHost=async()=>{
 if(mode==='initial-pending'){
  await waitFor('initial deferred scan',()=>fixture.pendingReject);root.unmount();const count=fixture.published.length;fixture.pendingReject(new Error('late initial failure'));await sleep(30);fixture.workerOptions.onError('late progress');await sleep(20);check(fixture.published.length===count,'initial scan rejection published after disposal');check(fixture.stopped===1,'worker not stopped on initial unmount');return {disposed:true};
 }
 await waitFor('first successful scan',()=>latest()?.available===true&&latest()?.tasks.length===1);
 check(fixture.registered===1&&fixture.loads===1,'initial scan did not connect storage');
 fixture.fail=true;fixture.changed();await waitFor('later scan failure',()=>latest()?.available===false);
 check(latest().tasks.length===1&&latest().tasks[0].documentId==='doc','scan error discarded previously known tasks');
 check(!JSON.stringify(latest()).includes('private'),'scan error exposed raw failure');
 const beforeProgress=fixture.published.length;
 updateTaskProgress('course','doc',{message:'OCR 2/2',completedUnits:2,totalUnits:2,lastActivityAt:new Date().toISOString(),progressRevision:2});
 await waitFor('progress published',()=>fixture.published.length>beforeProgress);
 check(latest().available===false&&latest().tasks[0].completedUnits===2,'worker progress erased host scan fault or lost actual progress');
 fixture.workerOptions.onError('provider failure');await sleep(20);check(latest().available===false,'worker error callback erased host scan fault');
 fixture.fail=false;fixture.changed();await waitFor('scan recovered',()=>latest()?.available===true);
 check(latest().tasks.length===1&&latest().tasks[0].completedUnits===2,'scan recovery discarded live task progress');
 fixture.pending=true;fixture.changed();await waitFor('late scan pending',()=>fixture.pendingReject);
 root.unmount();const afterUnmount=fixture.published.length;fixture.pendingReject(new Error('late scan failure'));
 updateTaskProgress('course','doc',{message:'late progress'});fixture.workerOptions.onError('late error');await sleep(40);
 check(fixture.published.length===afterUnmount,'disposed host published late task state');
 check(fixture.stopped===1&&fixture.unwatched===1&&fixture.uncommanded===1,'host did not clean up worker and IPC subscriptions');
 return {recovery:true,progress:true,disposed:true};
};
`;
void test(
  'background host preserves task status through scan failures, progress, recovery and disposal',
  {
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !existsSync('/usr/bin/xvfb-run')
        ? 'Requires a display or Xvfb'
        : false,
  },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-task-host-'));
    const bundle = await build({
      stdin: { contents: entry, loader: 'tsx', resolveDir: root },
      alias: { '@': root },
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
      plugins: [mockDependencies],
    });
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<!doctype html><html><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`,
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
      try{const results=[];for(const mode of ['recovery','initial-pending']){await win.loadURL(${JSON.stringify(url)}+'?mode='+mode);results.push(await win.webContents.executeJavaScript('window.runTaskHost()',true));}console.log('TASK_HOST_OK '+JSON.stringify(results));win.destroy();app.exit(0);}catch(error){console.error(error);win.destroy();app.exit(1);}
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
      assert.match(output, /TASK_HOST_OK .*"recovery":true.*"disposed":true/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
