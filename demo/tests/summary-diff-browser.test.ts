import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
const target = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(target, 'package.json'));
import { build } from 'esbuild';

void test('real Chromium: bounded rows, filtering, reset, literal text and keyboard interaction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-diff-eval-'));
  const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {SummaryDiffView} from './components/summary-diff-view.tsx';
const root=createRoot(document.getElementById('root'));
const same=Array.from({length:45},(_,i)=>'same-'+i).join('\\n\\n');
const changed=Array.from({length:45},(_,i)=>'new-'+i).join('\\n\\n');
let props={before:same,after:same+'\\n\\n'+changed,beforeLabel:'历史 v1',afterLabel:'当前 v2'};
const render=()=>root.render(<SummaryDiffView {...props}/>);render();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(v,message)=>{if(!v)throw new Error(message)};
const rows=()=>[...document.querySelectorAll('[data-diff-kind]')];
const more=()=>[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='显示更多');
const checkbox=()=>document.querySelector('input[type=checkbox]');
async function until(message,f){for(let i=0;i<150;i++){if(f())return;await sleep(10);}throw new Error(message+' '+document.body.innerText.slice(0,700));}
window.evaluateInitial=async()=>{
 await until('initial rows',()=>rows().length>0);
 check([...document.querySelectorAll('section')].some(node=>(node.getAttribute('aria-label')??(node.getAttribute('aria-labelledby')??'').split(/\\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ')).trim()==='总结文字差异'),'named section missing');
 check(document.body.textContent.includes('历史 v1')&&document.body.textContent.includes('当前 v2'),'version labels missing');
 check(document.body.innerText.includes('新增 45 段')&&document.body.innerText.includes('未变 45 段'),'counts wrong: '+document.body.innerText.slice(0,500));
 check(checkbox()?.checked,'default only changes');check(rows().length===20&&rows().every(n=>n.dataset.diffKind==='added'),'initial render unbounded or equal visible');
 more().click();await until('40 rows',()=>rows().length===40);more().click();await until('45 rows',()=>rows().length===45);check(!more(),'more button remains after all rows');
 checkbox().click();await until('toggle resets rows',()=>rows().length===20&&rows()[0].dataset.diffKind==='equal');
 check(!checkbox().checked,'checkbox cannot toggle');
 more().click();await until('unfiltered pagination',()=>rows().length===40);
 props={...props,beforeLabel:'改名 v1'};render();await until('label changed',()=>document.body.textContent.includes('改名 v1'));
 check(!checkbox().checked&&rows().length===40,'label-only update reset controls');
 props={before:'old',after:'new',beforeLabel:'起始',afterLabel:'当前'};render();await until('content reset',()=>rows().length===2&&checkbox().checked);
 check(rows().map(n=>n.dataset.diffKind).join(',')==='removed,added','replacement order wrong');
 const text='literal <img src=x onerror=window.injected=1> and [link](javascript:bad)';
 props={before:'',after:text};render();await until('literal text',()=>rows()[0]?.querySelector('[data-diff-text]')?.textContent===text);
 check(!document.querySelector('img')&&!document.querySelector('a')&&!window.injected,'source HTML/link rendered');
 props={before:'',after:''};render();await until('empty',()=>document.body.textContent.includes('没有可比较的总结文字。'));check(rows().length===0,'empty rows');
 props={before:'same',after:'same'};render();await until('equal',()=>document.body.textContent.includes('总结文字没有变化。'));
 check(rows().length===0,'equal paragraphs visible by default');checkbox().click();await until('view equal',()=>rows().length===1);
 props={before:Array.from({length:201},(_,i)=>'a'+i).join('\\n\\n'),after:Array.from({length:201},(_,i)=>'b'+i).join('\\n\\n')};render();
 await until('coarse',()=>document.body.textContent.includes('内容较长，显示简化差异。'));check(rows().length===20,'coarse list unbounded');
 checkbox().focus();check(document.activeElement===checkbox(),'checkbox not focusable');
 return true;
};
window.evaluateKeyboard=async()=>{await until('keyboard toggles checkbox',()=>checkbox().checked===false);return true;};
`;
  const bundle = await build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: target },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<!doctype html><html><body><div id="root"></div><script>' +
        bundle.outputFiles[0].text +
        '</script></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const main = path.join(directory, 'main.cjs');
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:820,height:600,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 try{await win.loadURL(${JSON.stringify(url)});await win.webContents.executeJavaScript('window.evaluateInitial()',true);
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
 await win.webContents.executeJavaScript('window.evaluateKeyboard()',true);console.log('SUMMARY_DIFF_BROWSER_OK');win.destroy();app.exit(0);}
 catch(e){console.error(e);win.destroy();app.exit(1);}
 });`,
  );
  try {
    const electron = require('electron') as string;
    const xvfb = process.platform === 'linux' && !process.env.DISPLAY;
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
        xvfb ? 'xvfb-run' : electron,
        xvfb ? ['-a', electron, ...args] : args,
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let log = '';
      child.stdout.on('data', (v) => {
        log += v;
      });
      child.stderr.on('data', (v) => {
        log += v;
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('browser timeout ' + log));
      }, 30000);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(log);
        else reject(new Error(log));
      });
    });
    assert.match(output, /SUMMARY_DIFF_BROWSER_OK/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
