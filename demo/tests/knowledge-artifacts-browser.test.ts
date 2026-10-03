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
import {DocumentSummaryPanel} from '@/components/document-summary-panel';
import {KnowledgeMindmap} from '@/components/knowledge-mindmap';
import {CourseNotesPanel} from '@/components/course-notes-panel';
import {CourseHistoryPanel} from '@/components/course-history-panel';
import {MemoryCourseStorage} from '@/lib/course-storage/memory-course-storage';
import {appendStudyNote} from '@/lib/course-storage/study-tools';
const source = {documentId:'d',fileName:'fixture.pdf',pageStart:2,type:'pdf'};
const knowledge = {schemaVersion:2,courseId:'c',version:1,updatedAt:'today',conflicts:[],nodes:[
  {id:'root',label:'科学',kind:'course',ownership:'generated',description:'概览',sources:[]},
  ...Array.from({length:80},(_,i) => ({id:'n'+i,label:'概念 '+i,description:'说明 '+i,...(i < 3 ? {parentId:i===0?null:'n'+(i-1)} : {}),kind:'concept',ownership:'generated',sources:[source]})),
],relations:[{from:'n0',to:'n1',label:'包含'},{from:'n1',to:'n2',label:'包含'},{from:'n0',to:'n2',label:'对比'}]};
const scientific = '$$E=mc^2$$'+ '\\n\\n|量|单位|\\n|---|---|\\n|E|J|';
const digest = {documentId:'d',title:'测试总结',promptVersion:'test',sourcePages:[1,2],overview:'概览',unresolvedQuestions:['边界条件？'],sections:
  Array.from({length:15},(_,i) => ({id:'s'+i,title:'章节 '+i,summary:'小节概述',pageStart:1,pageEnd:2,points:[{text:scientific,pageStart:2,pageEnd:2}]}))};
window.sourceJumps = []; window.copied = ''; window.questions = [];
Object.defineProperty(navigator,'clipboard',{value:{writeText:async (text) => {window.copied = text;}}});
const jump = (...args) => window.sourceJumps.push(args);
const storage = new MemoryCourseStorage();
const historyStorage = {listHistory:async()=>[{id:'past',revision:0,updatedAt:'2026-01-01',source:'snapshot',summary:'历史概览',knowledge:{...knowledge,version:0,nodes:[knowledge.nodes[0],{...knowledge.nodes[1],description:'历史说明'},{...knowledge.nodes[1],id:'removed',label:'已移除概念'}],relations:[],unresolvedQuestions:['旧问题']}}]};
function App() {
  const [notesVisible,setNotesVisible] = useState(true); window.setNotesVisible=setNotesVisible;
  return <><DocumentSummaryPanel digest={digest} onOpenSource={jump} onAskQuestion={question=>window.questions.push(question)} onSaveNote={(text,page)=>appendStudyNote(storage,{text,sources:[{...source,pageStart:page}]})}/><KnowledgeMindmap knowledge={knowledge} onOpenSource={jump} onAskQuestion={question=>window.questions.push(question)} onSaveNote={(text,sources)=>appendStudyNote(storage,{text,sources})}/>{notesVisible ? <CourseNotesPanel storage={storage} courseId="fixture-course"/> : null}<CourseHistoryPanel storage={historyStorage} current={knowledge} currentSummary="当前概览"/></>;
}
createRoot(document.getElementById('root')).render(<App/>);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
async function waitFor(label,predicate) { for(let i=0;i<200;i++){if(predicate()) return;await sleep(20)} throw new Error('Timeout: '+label); }
const check = (value,message) => {if(!value) throw new Error(message)};
const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.includes(text));
window.runReaderRegression = async () => {
  await waitFor('summary',() => button('章节 14'));
  check(document.querySelectorAll('table').length === 2,'only open sections mount tables');
  check(document.querySelectorAll('.katex').length >= 2,'math rendered');
  button('章节 14').click(); await sleep(50);
  check(document.querySelectorAll('table').length === 3,'all later chapters reachable');
  button('要点来源').click(); check(window.sourceJumps[0][0] === 2,'point source jump');
  button('继续追问').click(); check(window.questions[0].pageNumber === 2 && window.questions[0].text.includes('E=mc^2'),'summary follow-up preserves page and formula');
  button('复制总结').click(); await waitFor('summary copied',()=>window.copied.includes('边界条件？')); check(window.copied.includes('章节 14'),'summary copies all sections');
  button('加入课程笔记').click(); await waitFor('note saved',()=>document.body.textContent.includes('已加入课程笔记'));
  check((await storage.loadNotes()).content.includes('第 2 页'),'summary note has source page');
  button('重新加载').click(); await waitFor('notes refreshed',()=>document.querySelector('[aria-label="编辑课程笔记"]').value.includes('E=mc^2'));
  const editor = document.querySelector('[aria-label="编辑课程笔记"]');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,'我的未保存草稿'); editor.dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor('draft dirty',()=>button('保存笔记')&&!button('保存笔记').disabled);
  await storage.saveNotes('其他窗口的新笔记',(await storage.loadNotes()).token);
  button('保存笔记').click(); await waitFor('conflict surfaced',()=>document.body.textContent.includes('课程笔记已在其他窗口或外部修改'));
  check(editor.value==='我的未保存草稿','external conflict preserves editor draft');
  check((await storage.loadNotes()).content==='其他窗口的新笔记','external note remains untouched');
  window.setNotesVisible(false); await waitFor('notes unmounted',()=>!document.querySelector('[aria-label="编辑课程笔记"]'));
  window.setNotesVisible(true); await waitFor('draft restored',()=>document.querySelector('[aria-label="编辑课程笔记"]')?.value==='我的未保存草稿');
  check(document.body.textContent.includes('其他窗口的新笔记'),'remount shows latest external content for merging');
  const history=document.querySelector('[aria-label="成果历史"]');
  await waitFor('history versions loaded',()=>history.textContent.includes('对比版本新增 79 项'));
  check(history.textContent.includes('移除 1 项')&&history.textContent.includes('修改 1 项'),'history node differences wrong');
  check(history.textContent.includes('移除问题：旧问题')&&history.textContent.includes('新增关系'),'history lost questions or relation changes');
  check(history.textContent.includes('历史概览')&&history.textContent.includes('不支持整门课程恢复'),'artifact-only history preview missing scope');
  const summaryDiff=[...history.querySelectorAll('section')].find(node=>(node.getAttribute('aria-label')??document.getElementById(node.getAttribute('aria-labelledby'))?.textContent)==='总结文字差异');
  check(summaryDiff,'summary text comparison missing');
  check(summaryDiff.querySelector('[data-diff-kind="removed"] [data-diff-text]')?.textContent==='历史概览','historical summary was not used');
  check(summaryDiff.querySelector('[data-diff-kind="added"] [data-diff-text]')?.textContent==='当前概览','current rendered summary was not used');
  const comparison=document.querySelector('[aria-label="历史对比版本"]');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(comparison,'past');comparison.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor('history comparison selection',()=>history.textContent.includes('对比版本新增 0 项 · 移除 0 项 · 修改 0 项'));
  await waitFor('same summary comparison',()=>summaryDiff.textContent.includes('总结文字没有变化。'));
  check(summaryDiff.querySelectorAll('[data-diff-kind]').length===0,'same historical summary still shows changes');
  const oldHistory=await historyStorage.listHistory();
  historyStorage.listHistory=async()=>[{...oldHistory[0],id:'legacy',source:'knowledge',summary:''}];
  [...history.querySelectorAll('button')].find(node=>node.textContent.trim()==='刷新').click();
  await waitFor('legacy summary fallback',()=>history.textContent.includes('部分版本缺少完整总结'));
  check(comparison.value==='current','deleted comparison target did not fall back to current');
  check(!summaryDiff.textContent.includes('当前概览'),'legacy knowledge compared against full summary');
  check(summaryDiff.textContent.includes('历史说明')&&summaryDiff.textContent.includes('说明 1'),'legacy knowledge text comparison missing');
  const canvas = document.querySelector('[aria-label="脑图画布"]');
  const conceptButton = (label) => [...canvas.querySelectorAll('button')].find(node => node.querySelector('.line-clamp-1')?.textContent === label);
  check(conceptButton('概念 2') && conceptButton('概念 2').offsetLeft > conceptButton('概念 1').offsetLeft && conceptButton('概念 1').offsetLeft > conceptButton('概念 0').offsetLeft, 'three hierarchy levels visible by default despite cross link');
  check([...canvas.querySelectorAll('svg text')].some(node => node.textContent === '对比'),'cross relation label visible');
  document.querySelector('[aria-label="缩小脑图"]').click(); await sleep(30);
  check(document.querySelector('[aria-label="脑图缩放比例"]').textContent === '75%','zoom works');
  button('折叠此分支').click(); await sleep(30);
  check(document.querySelector('[aria-label="脑图画布"]').querySelectorAll('button').length === 1,'root collapse hides descendants');
  button('展开此分支').click(); await sleep(30);
  const input = document.querySelector('[aria-label="搜索脑图节点"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'概念 79');
  input.dispatchEvent(new Event('input',{bubbles:true})); await sleep(50);
  const result = document.querySelector('[aria-label="脑图搜索结果"] button');
  check(result?.textContent === '概念 79','hidden node searchable'); result.click(); await sleep(30);
  button('跳转到来源').click(); check(window.sourceJumps.at(-1).join(',') === 'd,2','hidden node source reachable');
  button('复制脑图').click(); await sleep(30);
  check(window.copied.includes('概念 79') && window.copied.includes('fixture.pdf'),'full Markdown copied');
  check(document.querySelector('[aria-label="脑图画布"]').querySelectorAll('button').length <= 60,'bounded nodes');
  Object.defineProperty(navigator.clipboard,'writeText',{value:async () => {throw new Error('denied');}});
  button('复制脑图').click(); await sleep(30); check(document.body.textContent.includes('复制失败'),'copy failure visible');
  return {summary:true,mindmap:true};
};
`;

void test(
  'knowledge summaries and mindmaps render science, reveal all sections, search hidden nodes and jump to sources',
  {
    skip:
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !existsSync('/usr/bin/xvfb-run')
        ? 'Requires a display or Xvfb for Chromium interaction tests'
        : false,
  },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-knowledge-'));
    const postcss = require('postcss');
    const tailwind = require('@tailwindcss/postcss');
    const cssPath = path.join(root, 'app/globals.css');
    const css = (
      await postcss([tailwind({ base: root })]).process(
        await readFile(cssPath, 'utf8'),
        { from: cssPath },
      )
    ).css;
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
      response.setHeader('content-type', 'text/html');
      response.end(
        `<html><head><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`,
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
  `,
    );
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
      assert.match(output, /READER_OK .*"summary":true,"mindmap":true/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
