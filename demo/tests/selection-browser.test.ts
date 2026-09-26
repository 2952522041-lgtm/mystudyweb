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
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SelectionToolbar } from '@/components/selection-toolbar';
import { AIChatPanel } from '@/components/ai-chat-panel';
import { DEFAULT_SETTINGS } from '@/lib/reader-cache';

const settings = { ...DEFAULT_SETTINGS, providerMode: 'openai-compatible',
  baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', model: 'translation-test' };
const chatSettings = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', model: 'vision-test', visionConfirmed: true };
const renderedPages = [];
const pdfDoc = { getPage: async (number) => ({
  getViewport: ({scale}) => ({width: 400 * scale, height: 500 * scale}),
  getTextContent: async () => ({items: [{ str: 'Source text from page ' + number, transform: [12,0,0,12,20,450], width: 250, height: 12 }]}),
  render: () => { renderedPages.push(number); return { promise: Promise.resolve(), cancel() {} }; },
}) };
const calls = [];
let mode = 'success';
let aborted = false;
let copied = '';
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { copied = text; } } });
window.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({url: String(url), body});
  if (mode === 'delay') return new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
  if (mode === 'error') return new Response(JSON.stringify({error: {message: 'fixture auth failure'}}), { status: 401 });
  return new Response('data: ' + JSON.stringify({choices: [{delta: {content: body.model === 'vision-test' ? '解释完成' : '选段译文'}, finish_reason: 'stop'}]}) + '\\n\\ndata: [DONE]\\n\\n',
    { headers: {'content-type': 'text/event-stream'} });
};
function App() {
  const rootRef = useRef(null);
  const [question, setQuestion] = useState(null);
  const [page, setPage] = useState(1);
  return <><div id="outside">Outside selectable text</div>
    <div ref={rootRef} style={{width: 500, height: 360, overflow: 'auto'}}>
      <div className="pdf-text-layer" data-page-number="1" style={{height: 100}}><span id="first">First page passage.</span></div>
      <div className="pdf-text-layer" data-page-number="2" style={{height: 100}}><span id="second">Second page passage: 网上查一下相关资料</span></div>
    </div>
    <SelectionToolbar rootRef={rootRef} settings={settings} targetLanguage="日本語" onExplain={(selection) => {
      setPage(selection.pageNumber);
      setQuestion({id: Date.now(), fingerprint: 'fixture-doc', pageNumber: selection.pageNumber, text: selection.text});
    }} />
    <AIChatPanel pdfDoc={pdfDoc} fingerprint="fixture-doc" pageNumber={page} settings={chatSettings}
      selectionQuestion={question} onSelectionQuestionHandled={() => setQuestion(null)} onOpenSettings={() => {}} />
  </>;
}
createRoot(document.getElementById('root')).render(<App />);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(20); }
  throw new Error('Timeout: ' + label + ' ' + document.body.textContent.slice(-700));
}
const popup = () => document.querySelector('[aria-label="第 2 页选段操作"]');
function select(id) {
  const range = document.createRange(); range.selectNodeContents(document.getElementById(id));
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}
function click(text) {
  const button = [...popup().querySelectorAll('button')].find((node) => node.textContent === text);
  if (!button) throw new Error('Missing toolbar button: ' + text);
  button.click();
}
function check(value, message) { if (!value) throw new Error(message); }
window.runSelectionRegression = async () => {
  await waitFor('fixture', () => document.getElementById('second'));
  select('outside'); await sleep(50); check(!popup(), 'outside selection must be ignored');
  const cross = document.createRange(); cross.setStart(document.getElementById('first').firstChild, 0);
  cross.setEnd(document.getElementById('second').firstChild, 10);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(cross);
  document.dispatchEvent(new Event('selectionchange')); await sleep(50);
  check(!popup(), 'cross-page range must be ignored');
  select('second'); await waitFor('second-page toolbar', popup);
  click('复制'); await waitFor('copy', () => copied.includes('Second page'));
  click('翻译'); await waitFor('translation', () => document.querySelector('[aria-label="选段译文"]')?.textContent === '选段译文');
  check(JSON.stringify(calls[0].body).includes('日本語'), 'selected target language missing');
  check(JSON.stringify(calls[0].body).includes('Second page'), 'selected text missing');
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  await waitFor('escape dismissal', () => !popup());
  window.dispatchEvent(new Event('scroll')); await sleep(30); check(!popup(), 'escape must not reopen on scroll');
  select('second'); await waitFor('reopen', popup);
  mode = 'error'; click('翻译'); await waitFor('classified error', () => popup()?.textContent.includes('[auth]'));
  check(popup().textContent.includes('fixture auth failure'), 'raw provider error missing');
  mode = 'delay'; click('翻译'); await waitFor('pending request', () => calls.length === 3);
  click('关闭'); await waitFor('abort dismissed translation', () => aborted && !popup());
  mode = 'success'; select('second'); await waitFor('explain selection', popup); click('解释');
  await waitFor('visual explanation', () => document.body.textContent.includes('解释完成'));
  const chat = calls.filter((call) => call.body.model === 'vision-test');
  check(chat.length === 1, 'explanation must be sent once');
  const payload = JSON.stringify(chat[0].body);
  check(payload.includes('reference-page') && payload.includes('Source text from page 2'), 'wrong page context');
  check(payload.includes('image_url') && renderedPages.includes(2), 'missing selected-page visual context');
  check(payload.includes('Second page passage'), 'missing selected quote');
  check(calls.every((call) => !call.url.includes('web_search')), 'quoted search instruction triggered a tool');
  select('second'); await waitFor('outside dismissal setup', popup);
  document.getElementById('outside').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
  await waitFor('outside dismissal', () => !popup());
  return {calls: calls.length, selectedPage: 2, visualPage: renderedPages.at(-1)};
};
`;

void test('real DOM selection translates, copies, cancels and explains the selected second page', {
  skip: process.platform === 'linux' && !process.env.DISPLAY && !existsSync('/usr/bin/xvfb-run')
    ? 'Requires a display or Xvfb for Chromium interaction tests' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-selection-'));
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
        const result = await win.webContents.executeJavaScript('window.runSelectionRegression()', true);
        console.log('SELECTION_OK ' + JSON.stringify(result)); win.destroy(); app.exit(0);
      } catch (error) { console.error(error); win.destroy(); app.exit(1); }
    });
  `);
  try {
    const electron = require('electron') as string;
    const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
    const args = ['--no-sandbox', '--disable-gpu', `--user-data-dir=${directory}/profile`, main];
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
    assert.match(output, /SELECTION_OK .*"selectedPage":2/);
    const source = await readFile(path.join(root, 'app/page.tsx'), 'utf8');
    assert.match(source, /setTranslationPage\(selection.pageNumber\)/);
    assert.match(source, /selectionQuestion=\{selectionQuestion\}/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
