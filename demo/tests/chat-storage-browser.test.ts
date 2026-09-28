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
const settings = {baseUrl:'https://fixture.invalid/v1', apiKey:'fixture', model:'test', visionConfirmed:true};
let failure = 'get';
for (const method of ['get', 'put', 'delete']) {
  const original = IDBObjectStore.prototype[method];
  IDBObjectStore.prototype[method] = function(...args) {
    if (failure === method) throw new DOMException('Injected storage failure', 'UnknownError');
    return original.apply(this, args);
  };
}
let calls = 0;
window.fetch = async () => {
  calls++;
  if (failure === 'auth') return new Response(JSON.stringify({error:{message:'模拟密钥错误'}}),{status:401});
  return new Response('data: ' + JSON.stringify({choices:[{delta:{content:'回答完成'},finish_reason:'stop'}]}) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
};
const doc = {numPages:2, getPage:async (number) => ({getViewport:() => ({width:400,height:500}),
  getTextContent:async () => ({items:[{str:'Source text page ' + number,transform:[12,0,0,12,20,450],width:100,height:12}]}),
  render:() => ({promise:Promise.resolve(),cancel(){}})})};
function App() {
  const [page, setPage] = useState(1);
  return <><button id="next" onClick={() => setPage(2)}>下一页</button><AIChatPanel pdfDoc={doc} fingerprint="storage-test" pageNumber={page} settings={settings} onOpenSettings={() => {}} /></>;
}
createRoot(document.getElementById('root')).render(<App/>);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
const text = () => document.body.textContent;
const button = (label) => [...document.querySelectorAll('button')].find((node) => node.textContent === label);
const check = (value, message) => {if (!value) throw new Error(message)};
async function waitFor(label, predicate) {
  for (let i=0;i<200;i++) { if(predicate()) return; await sleep(20); }
  throw new Error('Timeout: '+label+' '+text());
}
function scope(value) { const select = document.querySelector('select'); select.value = value; select.dispatchEvent(new Event('change',{bubbles:true})); }
window.runStorageRegression = async () => {
  await waitFor('load error', () => text().includes('对话历史读取失败'));
  button('总结这一页').click(); await sleep(50); check(calls === 0, 'failed load must block AI');
  failure = ''; button('重试读取').click(); await waitFor('load recovered', () => !text().includes('对话历史读取失败'));
  failure = 'put'; button('总结这一页').click();
  await waitFor('save error', () => text().includes('回答已生成，但对话保存失败'));
  check(text().includes('回答完成'), 'generated answer lost');
  check(!button('重试'), 'save failure misreported as AI failure');
  check(calls === 1, 'initial answer requested more than once');
  failure = ''; button('重新保存（不调用 AI）').click(); await waitFor('save recovered', () => !text().includes('对话保存失败'));
  check(calls === 1, 'save retry billed AI again');
  failure = 'delete'; document.querySelector('[aria-label="清空本页对话"]').click();
  await waitFor('delete error', () => text().includes('清空对话失败'));
  check(text().includes('回答完成'), 'failed deletion erased messages');
  failure = ''; button('重试清空').click(); await waitFor('clear recovered', () => !text().includes('回答完成') && !text().includes('清空对话失败'));
  scope('document'); await waitFor('document scope', () => text().includes('就整份文档提问'));
  await sleep(80); button('比较第 1 到 2 页').click();
  await waitFor('document reply', () => text().includes('检索来源'));
  check(text().includes('第 1 页') && text().includes('第 2 页'), 'source pages absent');
  document.getElementById('next').click(); await sleep(80);
  check(text().includes('回答完成'), 'document conversation lost on page turn');
  scope('page'); await sleep(80); check(!text().includes('回答完成'), 'document messages leaked into page scope');
  scope('document'); await sleep(80); check(text().includes('回答完成'), 'document history did not return');
  check(calls === 2, 'storage/navigation triggered additional generation');
  scope('page'); await sleep(80); failure = 'auth'; button('总结这一页').click();
  await waitFor('provider auth error', () => text().includes('模拟密钥错误'));
  check(calls === 3 && button('重试'), 'provider failure lost its retry action');
  failure = ''; button('重试').click(); await waitFor('provider retry recovered', () => text().includes('回答完成'));
  check(calls === 4, 'provider retry requested unexpected extra generations');
  return {calls};
};
`;

void test('chat storage failures recover without regenerating answers and scopes stay isolated', {
  skip: process.platform === 'linux' && !process.env.DISPLAY && !existsSync('/usr/bin/xvfb-run')
    ? 'Requires a display or Xvfb for Chromium interaction tests' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-chat-storage-'));
  const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root },
    alias: { '@': root }, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`);
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
        const result = await win.webContents.executeJavaScript('window.runStorageRegression()', true);
        console.log('STORAGE_OK ' + JSON.stringify(result)); win.destroy(); app.exit(0);
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
    assert.match(output, /STORAGE_OK .*"calls":4/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
