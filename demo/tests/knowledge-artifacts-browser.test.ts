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
import {DocumentSummaryPanel} from '@/components/document-summary-panel';
import {KnowledgeMindmap} from '@/components/knowledge-mindmap';
const source = {documentId:'d',fileName:'fixture.pdf',pageStart:2,type:'pdf'};
const knowledge = {schemaVersion:2,courseId:'c',version:1,updatedAt:'today',conflicts:[],nodes:[
  {id:'root',label:'科学',kind:'course',ownership:'generated',description:'概览',sources:[]},
  ...Array.from({length:80},(_,i) => ({id:'n'+i,label:'概念 '+i,description:'说明 '+i,...(i < 3 ? {parentId:i===0?null:'n'+(i-1)} : {}),kind:'concept',ownership:'generated',sources:[source]})),
],relations:[{from:'n0',to:'n1',label:'包含'},{from:'n1',to:'n2',label:'包含'},{from:'n0',to:'n2',label:'对比'}]};
const scientific = '$$E=mc^2$$'+ '\\n\\n|量|单位|\\n|---|---|\\n|E|J|';
const digest = {documentId:'d',title:'测试总结',promptVersion:'test',sourcePages:[1,2],overview:'概览',unresolvedQuestions:['边界条件？'],sections:
  Array.from({length:15},(_,i) => ({id:'s'+i,title:'章节 '+i,summary:'小节概述',pageStart:1,pageEnd:2,points:[{text:scientific,pageStart:2,pageEnd:2}]}))};
window.sourceJumps = []; window.copied = '';
Object.defineProperty(navigator,'clipboard',{value:{writeText:async (text) => {window.copied = text;}}});
const jump = (...args) => window.sourceJumps.push(args);
createRoot(document.getElementById('root')).render(<><DocumentSummaryPanel digest={digest} onOpenSource={jump}/><KnowledgeMindmap knowledge={knowledge} onOpenSource={jump}/></>);
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
