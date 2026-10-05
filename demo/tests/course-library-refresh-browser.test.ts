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
const mocks: Record<string, string> = {
  '@/lib/course-storage/desktop-course-storage': `export class DesktopCourseStorage {
    constructor(_api,label){this.label=label;}
    async load(){const fixture=window.fixture;if(fixture.defer)return new Promise(resolve=>fixture.reads.push(resolve));return structuredClone(fixture.bundle);}
    async loadNotes(){return {content:'',token:'notes'};}
    async loadGlossary(){return {schemaVersion:1,version:0,entries:[]};}
  }`,
  '@/lib/background-processor': `export function createBackgroundProcessor(){return {register(){},unregister(){},wake(){},resume(){},stop(){}};}`,
};
const mockDependencies: import('esbuild').Plugin = {
  name: 'course-refresh-boundaries',
  setup(builder) {
    builder.onResolve({ filter: /^@\/lib\// }, (args) =>
      args.path in mocks ? { path: args.path, namespace: 'refresh-mock' } : undefined,
    );
    builder.onLoad({ filter: /.*/, namespace: 'refresh-mock' }, (args) => ({
      contents: mocks[args.path], loader: 'js', resolveDir: root,
    }));
  },
};
const entry = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CourseLibrary} from '@/components/course-library';
import {BackgroundTaskCenter} from '@/components/background-task-center';
import {setBackgroundSnapshot} from '@/lib/background-task-store';
import {stageCourseReviewBundle} from '@/lib/course-storage/course-review';
const now='2026-10-05T00:00:00.000Z';
const fixture=window.fixture={defer:false,reads:[],changed:null,control:null,subscriptions:0,unsubscribed:0,updates:[],bundle:{
 manifest:{schemaVersion:1,id:'course',name:'Test course',revision:1,createdAt:now,updatedAt:now,activeKnowledgeVersion:0,documents:[{id:'doc',fingerprint:'a'.repeat(64),fileName:'lesson.pdf',storedFileName:'lesson.pdf',pageCount:2,status:'document-artifacts-ready',includedInCourse:false,includeConversationInsights:false,hasSummary:true,hasMindmap:true,importedAt:now,updatedAt:now}]},
 knowledge:{schemaVersion:3,courseId:'course',version:0,nodes:[],relations:[],conflicts:[],updatedAt:now},
 digests:{doc:{schemaVersion:3,documentId:'doc',fingerprint:'a'.repeat(64),title:'Lesson',overview:'Fixture overview',sections:[],concepts:[],relations:[],unresolvedQuestions:[],sourcePages:[1],promptVersion:'fixture',updatedAt:now}}
}};
window.yeyuDesktop={
 async getWorkspaceInfo(){return {root:'/synthetic-workspace'};},
 async listCourses(){return [{directoryName:'course-folder',manifest:fixture.bundle.manifest}];},
 async getBackgroundSnapshot(){return {tasks:[],executor:'desktop',available:true};},
 onCoursesChanged(listener){fixture.subscriptions++;fixture.changed=listener;return()=>{fixture.unsubscribed++;fixture.changed=null};},
};
function App(){
 const [callbackVersion,setCallbackVersion]=useState(1);window.updateCallback=()=>setCallbackVersion(2);
 return <><BackgroundTaskCenter onOpenDocument={async()=>{}} onOpenCourse={async courseId=>fixture.control.openCourse({courseId})}/><div className="flex h-dvh"><CourseLibrary onOpenDocument={()=>{}} onControlReady={control=>{fixture.control=control;}}
   onBundleUpdated={bundle=>fixture.updates.push({revision:bundle.manifest.revision,callbackVersion})}/></div></>;
}
const root=createRoot(document.getElementById('root'));root.render(<App/>);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw new Error(message)};
const revision=()=>Number(document.querySelector('.course-workspace')?.textContent.match(/版本[^0-9]*([0-9]+)/)?.[1]);
async function waitFor(label,predicate){for(let i=0;i<200;i++){if(predicate())return;await sleep(10)}throw new Error('Timeout '+label+' revision='+revision());}
const bundleAt=number=>{const next=structuredClone(fixture.bundle);next.manifest.revision=number;return next;};
const notify=()=>fixture.changed({directoryName:'course-folder'});
window.runCourseRefresh=async()=>{
 await waitFor('initial library load',()=>revision()===1);
 const candidate=await stageCourseReviewBundle(fixture.bundle,['doc'],{theme:'Candidate',nodes:[],relations:[],conflicts:[],unresolvedQuestions:[],provider:'fixture',model:'fixture',promptVersion:'fixture'},{id:'review',now});
 candidate.manifest.revision=3;
 fixture.defer=true;notify();notify();await waitFor('two overlapping reads',()=>fixture.reads.length===2);
 fixture.reads.shift()(bundleAt(2));await waitFor('intermediate revision committed',()=>revision()===2);
 window.updateCallback();await sleep(30);
 fixture.reads.shift()(candidate);
 await waitFor('final candidate delivered',()=>revision()===3&&document.querySelector('[aria-label="课程更新审阅"]'));
 const scrollArea=document.querySelector('.course-workspace > main');scrollArea.scrollTop=scrollArea.scrollHeight;await sleep(30);
 const review=()=>document.querySelector('[aria-label="课程更新审阅"]');
 check(review().getBoundingClientRect().bottom<scrollArea.getBoundingClientRect().top,'deep-scroll fixture did not hide the review panel');
 setBackgroundSnapshot({tasks:[{id:'course:doc',courseId:'course',courseName:'Test course',documentId:'doc',fileName:'lesson.pdf',status:'review',phase:'course',updatedAt:now}],executor:'desktop',available:true});
 document.querySelector('[aria-label="打开后台任务中心"]').click();
 await waitFor('review task action',()=>[...document.querySelectorAll('[role=dialog] button')].some(button=>button.textContent==='审阅课程更新'));
 [...document.querySelectorAll('[role=dialog] button')].find(button=>button.textContent==='审阅课程更新').click();
 await waitFor('task center closed',()=>!document.querySelector('[role=dialog]'));
 await waitFor('review visible and focused',()=>{const rect=review().getBoundingClientRect();return rect.top>=scrollArea.getBoundingClientRect().top&&rect.bottom<=scrollArea.getBoundingClientRect().bottom&&review().contains(document.activeElement);});
 check(document.activeElement===review().querySelector('[aria-expanded="false"]'),'review navigation expanded preview or skipped its entry action');
 check(fixture.updates.at(-1).callbackVersion===2,'refresh used stale onBundleUpdated callback');
 check(fixture.subscriptions===1&&fixture.unsubscribed===0,'entries or callback changes re-subscribed IPC');
 notify();notify();await waitFor('reordered reads',()=>fixture.reads.length===2);
 const older=fixture.reads.shift(),newer=fixture.reads.shift();newer(bundleAt(5));await waitFor('latest revision committed',()=>revision()===5);older(bundleAt(4));await sleep(40);
 check(revision()===5&&!fixture.updates.some(item=>item.revision===4),'late old bundle downgraded UI or reader');
 notify();notify();await waitFor('same-turn reads',()=>fixture.reads.length===2);
 const sameTurnOlder=fixture.reads.shift(),sameTurnNewer=fixture.reads.shift();sameTurnNewer(bundleAt(7));sameTurnOlder(bundleAt(6));
 await waitFor('same-turn latest',()=>revision()===7);await sleep(30);
 check(!fixture.updates.some(item=>item.revision===6),'batched stale response downgraded reader callback');
 [...document.querySelectorAll('summary')].find(node=>node.textContent==='课程管理与备份').click();
 const reload=()=>[...document.querySelectorAll('.course-workspace > main details button')].find(button=>button.textContent==='重新加载');
 reload().click();await waitFor('local reload pending',()=>fixture.reads.length===1);notify();await waitFor('IPC overlaps local reload',()=>fixture.reads.length===2);
 const localOld=fixture.reads.shift(),ipcNew=fixture.reads.shift();ipcNew(bundleAt(9));await waitFor('IPC wins reload race',()=>revision()===9);localOld(bundleAt(8));await waitFor('old local reload ends',()=>!reload().disabled);
 check(revision()===9&&!fixture.updates.some(item=>item.revision===8),'older local reload downgraded IPC UI or reader');
 notify();reload().click();await waitFor('local overlaps IPC read',()=>fixture.reads.length===2);
 const ipcOld=fixture.reads.shift(),localNew=fixture.reads.shift();localNew(bundleAt(11));await waitFor('local update wins IPC race',()=>revision()===11&&!reload().disabled);ipcOld(bundleAt(10));await sleep(30);
 check(revision()===11&&!fixture.updates.some(item=>item.revision===10),'older IPC read downgraded local UI or reader');
 const missingArtifacts=bundleAt(11);missingArtifacts.manifest.documents[0].hasSummary=false;delete missingArtifacts.digests.doc;
 reload().click();await waitFor('same revision disk check pending',()=>fixture.reads.length===1);fixture.reads.shift()(missingArtifacts);
 await waitFor('same revision missing artifact visible',()=>!fixture.control.getState().courses[0].documents[0].hasSummary&&!reload().disabled);
 reload().click();await waitFor('same revision recovery pending',()=>fixture.reads.length===1);fixture.reads.shift()(bundleAt(11));
 await waitFor('same revision recovered artifact visible',()=>fixture.control.getState().courses[0].documents[0].hasSummary&&!reload().disabled);
 check(fixture.updates.filter(item=>item.revision===11).length===3,'explicit same revision reload did not notify the reader');
 notify();await waitFor('unmount pending read',()=>fixture.reads.length===1);root.unmount();const count=fixture.updates.length;fixture.reads.shift()(bundleAt(12));await sleep(40);
 check(fixture.updates.length===count&&fixture.unsubscribed===1,'unmounted subscription applied late result');
 return {review:true,monotonic:true,latestCallback:true,disposed:true};
};
`;
void test(
  'course library retains final IPC review and reveals it when opened from a task after deep scrolling',
  {
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !existsSync('/usr/bin/xvfb-run')
        ? 'Requires a display or Xvfb'
        : false,
  },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-course-refresh-'));
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
      plugins: [mockDependencies],
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
      const win=new BrowserWindow({width:1000,height:420,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.on('console-message',details=>console.log(details.message));
      try{const results=[];for(const mode of ['refresh']){await win.loadURL(${JSON.stringify(url)}+'?mode='+mode);results.push(await win.webContents.executeJavaScript('window.runCourseRefresh()',true));}console.log('COURSE_REFRESH_OK '+JSON.stringify(results));win.destroy();app.exit(0);}catch(error){console.error(error);win.destroy();app.exit(1);}
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
      assert.match(output, /COURSE_REFRESH_OK .*"review":true.*"disposed":true/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
