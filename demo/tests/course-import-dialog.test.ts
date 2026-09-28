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
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CourseImportDialog, DocumentProcessingStatus} from '@/components/course-import-dialog';
let calls = [], active = 0, maxActive = 0, attempts = {}, retries = 0, currentSignal;
const options = {generateSummary:true, generateMindmap:true, mergeIntoCourse:true, includeConversationInsights:true};
function App() {
  const [open, setOpen] = useState(true);
  const [processing, setProcessing] = useState({phase:'document', status:'queued', options, updatedAt:'2026-01-01T00:00:00.000Z'});
  window.reopen = () => setOpen(true);
  window.failStatus = () => setProcessing({...processing, status:'failed', error:'后台服务暂时不可用'});
  return <>
    <CourseImportDialog open={open} onOpenChange={setOpen}
      onImport={async (file, _options, progress, signal) => {
        calls.push(file.name); active++; maxActive = Math.max(maxActive, active);
        if (file.name === 'cancel-a.pdf') currentSignal = signal;
        progress('legacy AI wording should not leak into save progress', 40);
        await new Promise(resolve => setTimeout(resolve, file.name === 'cancel-a.pdf' ? 100 : 30));
        active--;
        const attempt = attempts[file.name] || 0; attempts[file.name] = attempt + 1;
        if(file.name === 'b.pdf' && attempt === 0) throw new Error('b 保存失败');
        progress('后台生成中', 100);
      }}
      onBatchStart={() => { window.batchStarts = (window.batchStarts || 0) + 1; }}
      onBatchEnd={() => { window.batchEnds = (window.batchEnds || 0) + 1; }} />
    <DocumentProcessingStatus processing={processing} onRetry={() => { retries++; }} />
  </>;
}
createRoot(document.getElementById('root')).render(<App />);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const dialog = () => document.querySelector('[role="dialog"]');
const button = (label) => [...(dialog()?.querySelectorAll('button') || [])].find(node => node.textContent.trim() === label);
const check = (value, message) => { if (!value) throw new Error(message); };
async function waitFor(label, predicate) {
  for(let i = 0; i < 250; i++) { if(predicate()) return; await sleep(20); }
  throw new Error('Timeout: ' + label + ' ' + document.body.textContent);
}
function choose(names) {
  const input = dialog().querySelector('input[type=file]');
  const transfer = new DataTransfer();
  for (const name of names) transfer.items.add(new File([name], name, {type:'application/pdf'}));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', {bubbles:true}));
}
window.runCourseImportDialogRegression = async () => {
  await waitFor('dialog', () => dialog());
  check(document.body.textContent.includes('无需配置 AI 也可以先保存 PDF'), 'reading-first guidance missing');
  choose(['a.pdf','b.pdf','c.pdf']);
  await waitFor('multiple selection', () => document.body.textContent.includes('已选择 3 份 PDF'));
  button('导入 PDF').click();
  await waitFor('partial failure', () => button('重试未完成项（1）'));
  check(JSON.stringify(calls) === JSON.stringify(['a.pdf','b.pdf','c.pdf']), 'files were not saved sequentially or all attempted: ' + JSON.stringify(calls));
  check(maxActive === 1, 'storage saves overlapped');
  check(document.body.textContent.includes('a.pdf') && document.body.textContent.includes('已保存，可阅读'), 'saved file result missing');
  check(document.body.textContent.includes('b 保存失败'), 'failed file error missing');
  check(window.batchStarts === 1 && window.batchEnds === 1, 'batch callbacks did not run once');
  button('重试未完成项（1）').click();
  await waitFor('successful retry closes', () => !dialog());
  check(JSON.stringify(calls) === JSON.stringify(['a.pdf','b.pdf','c.pdf','b.pdf']), 'retry repeated a saved file: ' + JSON.stringify(calls));
  check(window.batchStarts === 2 && window.batchEnds === 2, 'retry batch callbacks missing');

  window.reopen();
  await waitFor('reopened dialog', () => dialog());
  choose(['cancel-a.pdf','cancel-b.pdf','cancel-c.pdf']);
  await waitFor('cancel files selected', () => document.body.textContent.includes('已选择 3 份 PDF'));
  button('导入 PDF').click();
  await waitFor('cancel busy', () => button('取消剩余'));
  button('取消剩余').click();
  await waitFor('cancelled pending files', () => button('重试未完成项（2）'));
  check(JSON.stringify(calls) === JSON.stringify(['a.pdf','b.pdf','c.pdf','b.pdf','cancel-a.pdf']), 'cancel ran unsaved files: ' + JSON.stringify(calls));
  check(currentSignal?.aborted === true, 'cancel did not abort the current save attempt');
  check(document.body.textContent.includes('已取消，尚未保存'), 'cancelled file result missing');
  check(window.batchStarts === 3 && window.batchEnds === 3, 'cancel batch callbacks missing');

  const status = document.querySelector('section[aria-label="PDF 成果后台排队中"]');
  check(status?.textContent.includes('PDF 已保存，可直接阅读'), 'queued status lacks reading guidance');
  window.failStatus();
  await waitFor('failed status', () => document.querySelector('section[aria-label="PDF 成果后台生成失败"]'));
  const failedStatus = document.querySelector('section[aria-label="PDF 成果后台生成失败"]');
  check(failedStatus.textContent.includes('后台服务暂时不可用'), 'status error missing');
  check(!failedStatus.textContent.includes('取消'), 'status exposes forbidden cancel action');
  [...failedStatus.querySelectorAll('button')].find(node => node.textContent.trim() === '重试').click();
  check(retries === 1, 'status retry callback not wired');
  return {calls, maxActive, starts:window.batchStarts, ends:window.batchEnds, retries};
};
`;

void test('course import dialog saves a batch serially and retries only unfinished files', {
  skip:
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !existsSync('/usr/bin/xvfb-run')
      ? 'Requires a display or Xvfb for Chromium interaction tests'
      : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-course-import-dialog-'));
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
    response.end(`<html><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
        const win = new BrowserWindow({width: 1200, height: 900, show: true,
          webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
        try {
          await win.loadURL(${JSON.stringify(url)});
          const result = await win.webContents.executeJavaScript('window.runCourseImportDialogRegression()', true);
          console.log('DIALOG_OK ' + JSON.stringify(result)); win.destroy(); app.exit(0);
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
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let logs = '';
      child.stdout.on('data', (data: Buffer) => { logs += data; });
      child.stderr.on('data', (data: Buffer) => { logs += data; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(logs)); }, 30000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(logs); else reject(new Error(logs)); });
    });
    assert.match(output, /DIALOG_OK .*"maxActive":1/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
