import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';

import {
  isSettingsSnapshotDirty,
  settingsSnapshotsEqual,
  type SettingsSnapshot,
} from '../lib/settings-dirty.ts';

const target = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(target, 'package.json'));

const baseTranslation = {
  providerMode: 'mock' as const,
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  apiKeys: {},
  model: 'glm-4.7-flashx',
  disableThinking: true,
};

void test('settings dirty helper: normalized optional fields and all four drafts', () => {
  const baseline: SettingsSnapshot = {
    translation: baseTranslation,
    chat: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-existing',
      model: 'gpt-4.1-mini',
      visionConfirmed: true,
    },
    knowledge: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4.1-mini',
    },
    agent: { backend: 'api', dshDocumentChat: false },
  };

  assert.equal(settingsSnapshotsEqual(baseline, baseline), true);
  assert.equal(isSettingsSnapshotDirty(baseline, baseline), false);
  // An unspecified generationMode is the same as the normalized default fast.
  assert.equal(
    isSettingsSnapshotDirty(baseline, {
      ...baseline,
      knowledge: { ...baseline.knowledge, generationMode: 'fast' },
    }),
    false,
  );
  assert.equal(
    isSettingsSnapshotDirty(baseline, {
      ...baseline,
      knowledge: { ...baseline.knowledge, generationMode: 'deep' },
    }),
    true,
  );
  // Each of the four drafts participates independently.
  assert.equal(
    isSettingsSnapshotDirty(baseline, {
      ...baseline,
      translation: { ...baseline.translation, model: 'changed' },
    }),
    true,
  );
  assert.equal(
    isSettingsSnapshotDirty(baseline, {
      ...baseline,
      chat: { ...baseline.chat, baseUrl: 'https://api.example.com/v1' },
    }),
    true,
  );
  assert.equal(
    isSettingsSnapshotDirty(baseline, {
      ...baseline,
      agent: { ...baseline.agent, backend: 'dsh' },
    }),
    true,
  );
  // apiKeys is compared by content, not object identity or key order.
  assert.equal(
    isSettingsSnapshotDirty(baseline, {
      ...baseline,
      translation: {
        ...baseline.translation,
        apiKeys: { custom: 'a', deepseek: 'b' },
      },
    }),
    true,
  );
  assert.equal(
    settingsSnapshotsEqual(
      {
        ...baseline,
        translation: {
          ...baseline.translation,
          apiKeys: { custom: '1', glmFast: '2' },
        },
      },
      {
        ...baseline,
        translation: {
          ...baseline.translation,
          apiKeys: { glmFast: '2', custom: '1' },
        },
      },
    ),
    true,
  );
});

void test('real Electron: unsaved settings close protection for every close route', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'yeyu-settings-close-'),
  );
  const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReaderSettingsDialog } from './components/reader-settings-dialog.tsx';

var translationBase = { providerMode: 'mock', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', apiKeys: {}, model: 'glm-4.7-flashx', disableThinking: true };
var chatBase = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-existing', model: 'gpt-4.1-mini', visionConfirmed: true };
var knowledgeBase = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4.1-mini', generationMode: 'fast' };

var originalSetItem = Storage.prototype.setItem;
var spyState = { onClose: 0, onSave: [], writes: [] };
Storage.prototype.setItem = function (key, value) {
  spyState.writes.push({ key: String(key), value: String(value) });
  return originalSetItem.call(this, key, value);
};

var root = null;
var container = null;
var sleep = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };

window.mount = function (options) {
  options = options || {};
  if (root) { root.unmount(); root = null; }
  if (container) { container.remove(); container = null; }
  localStorage.clear();
  if (options.agent) localStorage.setItem('yeyu-agent-settings', JSON.stringify(options.agent));
  spyState = { onClose: 0, onSave: [], writes: [] };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(React.createElement(ReaderSettingsDialog, {
    initialTab: options.initialTab || 'translation',
    translationSettings: options.translation || translationBase,
    chatSettings: options.chat || chatBase,
    knowledgeSettings: options.knowledge || knowledgeBase,
    onClose: function () { spyState.onClose += 1; },
    onSave: function (translation, chat, knowledge) {
      spyState.onSave.push({ translation: translation, chat: chat, knowledge: knowledge });
    },
  }));
  return true;
};

var query = function (selector) { return document.querySelector(selector); };
var buttonByText = function (text) {
  return Array.prototype.slice.call(document.querySelectorAll('button')).find(function (node) {
    return node.textContent.trim() === text;
  });
};
var confirmRegion = function () { return query('[role="alertdialog"]'); };

window.waitFor = function (label, predicate) {
  return (async function () {
    for (var i = 0; i < 300; i += 1) {
      if (predicate()) return true;
      await sleep(10);
    }
    throw new Error('timeout waiting for ' + label + ' | ' + document.body.innerText.slice(0, 600));
  })();
};
window.waitMounted = function (selector) {
  return window.waitFor('mounted ' + selector, function () { return Boolean(query(selector)); });
};
window.waitConfirm = function (visible) {
  return window.waitFor('confirm ' + visible, function () { return Boolean(confirmRegion()) === visible; });
};
window.waitClose = function (count) {
  return window.waitFor('onClose ' + count, function () { return spyState.onClose === count; });
};
window.waitSave = function (count) {
  return window.waitFor('onSave ' + count, function () { return spyState.onSave.length === count; });
};
window.waitActiveError = function () {
  return window.waitFor('focused error', function () {
    var alert = query('[role="alert"]');
    return Boolean(alert) && document.activeElement === alert;
  });
};

window.changeValue = function (selector, value) {
  var element = query(selector);
  if (!element) throw new Error('missing ' + selector);
  var prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  var descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  descriptor.set.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};

window.clickText = function (text) {
  var region = confirmRegion();
  var target = region
    ? Array.prototype.slice.call(region.querySelectorAll('button')).find(function (node) {
        return node.textContent.trim() === text;
      })
    : null;
  if (!target) target = buttonByText(text);
  if (!target) throw new Error('missing button ' + text + ' | ' + document.body.innerText.slice(0, 500));
  target.click();
  return true;
};
window.cancel = function () { return window.clickText('取消'); };
window.clickX = function () {
  var element = query('[data-slot="dialog-close"]');
  if (!element) throw new Error('missing dialog close button');
  element.click();
  return true;
};
window.clickOutside = function () {
  var element = query('[data-slot="dialog-overlay"]');
  if (!element) throw new Error('missing dialog overlay');
  element.click();
  return true;
};

window.expect = function (condition, message) {
  if (!condition) throw new Error(message);
  return true;
};
window.expectValue = function (selector, value) {
  var element = query(selector);
  if (!element) throw new Error('missing ' + selector);
  if (element.value !== value) throw new Error(selector + ' = ' + element.value + ' expected ' + value);
  return true;
};
window.expectCounts = function (onClose, onSave) {
  if (spyState.onClose !== onClose || spyState.onSave.length !== onSave) {
    throw new Error('counts onClose=' + spyState.onClose + ' onSave=' + spyState.onSave.length + ' expected ' + onClose + '/' + onSave);
  }
  return true;
};
window.expectWrites = function (count) {
  if (spyState.writes.length !== count) {
    throw new Error('writes=' + spyState.writes.length + ' expected ' + count + ' ' + JSON.stringify(spyState.writes));
  }
  return true;
};
window.confirmLabels = function () {
  var region = confirmRegion();
  if (!region) throw new Error('no confirm region');
  return region.innerText;
};
window.savedChatBaseUrl = function () {
  if (!spyState.onSave.length) throw new Error('no onSave recorded');
  return spyState.onSave[spyState.onSave.length - 1].chat.baseUrl;
};
window.savedChatApiKey = function () {
  if (!spyState.onSave.length) throw new Error('no onSave recorded');
  return spyState.onSave[spyState.onSave.length - 1].chat.apiKey;
};
window.firstWriteKey = function () {
  if (!spyState.writes.length) throw new Error('no writes recorded');
  return spyState.writes[0].key;
};
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
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
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
    `const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const run = (win, script) => { console.log('RUN ' + script.slice(0, 90)); return win.webContents.executeJavaScript(script, true); };
const key = (win, keyCode) => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
};
const scenario = async (win) => {
  // 1. Opening with an unspecified generationMode (normalized to fast) is unchanged.
  await run(win, 'window.mount({ knowledge: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4.1-mini" } })');
  await run(win, 'window.waitMounted("#agent-backend")');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitClose(1)');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.expectWrites(0)');
  await run(win, 'window.expectCounts(1, 0)');

  // 2. Unchanged close routes: X, Escape, outside press.
  await run(win, 'window.mount({})');
  await run(win, 'window.waitMounted("#agent-backend")');
  await run(win, 'window.clickX()');
  await run(win, 'window.waitClose(1)');
  await run(win, 'window.expectWrites(0)');

  await run(win, 'window.mount({})');
  await run(win, 'window.waitMounted("#agent-backend")');
  key(win, 'Escape');
  await run(win, 'window.waitClose(1)');
  await run(win, 'window.expectWrites(0)');

  await run(win, 'window.mount({})');
  await run(win, 'window.waitMounted("#agent-backend")');
  await run(win, 'window.clickOutside()');
  await run(win, 'window.waitClose(1)');
  await run(win, 'window.expectWrites(0)');

  // 3. Dirty Cancel offers the inline prompt; discard closes without writes.
  await run(win, 'window.mount({ initialTab: "chat" })');
  await run(win, 'window.waitMounted("#chat-base-url")');
  await run(win, 'window.changeValue("#chat-base-url", "https://api.example.com/dirty")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.expect(window.confirmLabels().includes("保存并关闭"), "save-and-close label")');
  await run(win, 'window.expect(window.confirmLabels().includes("放弃修改"), "discard label")');
  await run(win, 'window.expect(window.confirmLabels().includes("继续编辑"), "continue label")');
  await run(win, 'window.expectCounts(0, 0)');
  await run(win, 'window.expectWrites(0)');
  await run(win, 'window.clickText("放弃修改")');
  await run(win, 'window.waitClose(1)');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.expectCounts(1, 0)');
  await run(win, 'window.expectWrites(0)');

  // 4. Continue editing preserves the drafts and keeps the dialog open.
  await run(win, 'window.mount({ initialTab: "chat" })');
  await run(win, 'window.waitMounted("#chat-base-url")');
  await run(win, 'window.changeValue("#chat-base-url", "https://api.example.com/keep")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.clickText("继续编辑")');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.expectValue("#chat-base-url", "https://api.example.com/keep")');
  await run(win, 'window.expectCounts(0, 0)');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.clickText("放弃修改")');
  await run(win, 'window.waitClose(1)');

  // 5. Reverting a value to the original clears dirty and closes directly.
  await run(win, 'window.mount({ initialTab: "knowledge" })');
  await run(win, 'window.waitMounted("#knowledge-model")');
  await run(win, 'window.changeValue("#knowledge-model", "temporary-model")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.clickText("继续编辑")');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.changeValue("#knowledge-model", "gpt-4.1-mini")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitClose(1)');
  await run(win, 'window.waitConfirm(false)');

  // 6. Knowledge generationMode round-trip from the normalized default.
  await run(win, 'window.mount({ initialTab: "knowledge", knowledge: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4.1-mini" } })');
  await run(win, 'window.waitMounted("#knowledge-generation-mode")');
  await run(win, 'window.changeValue("#knowledge-generation-mode", "deep")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.clickText("继续编辑")');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.changeValue("#knowledge-generation-mode", "fast")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitClose(1)');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.expectWrites(0)');

  // 7. All four drafts count as dirty.
  await run(win, 'window.mount({})');
  await run(win, 'window.waitMounted("#setting-provider")');
  await run(win, 'window.changeValue("#setting-provider", "openai-compatible")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.clickText("放弃修改")');
  await run(win, 'window.waitClose(1)');

  await run(win, 'window.mount({ initialTab: "chat" })');
  await run(win, 'window.waitMounted("#chat-base-url")');
  await run(win, 'window.changeValue("#chat-base-url", "https://api.example.com/chat-dirty")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.clickText("放弃修改")');
  await run(win, 'window.waitClose(1)');

  await run(win, 'window.mount({ initialTab: "knowledge" })');
  await run(win, 'window.waitMounted("#knowledge-model")');
  await run(win, 'window.changeValue("#knowledge-model", "changed-model")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.clickText("放弃修改")');
  await run(win, 'window.waitClose(1)');

  // 8. Backend-only agent change is dirty and never persists on discard.
  await run(win, 'window.mount({ agent: { backend: "api", dshDocumentChat: false } })');
  await run(win, 'window.waitMounted("#agent-backend")');
  await run(win, 'window.changeValue("#agent-backend", "dsh")');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.expectCounts(0, 0)');
  await run(win, 'window.expectWrites(0)');
  await run(win, 'window.clickText("放弃修改")');
  await run(win, 'window.waitClose(1)');
  await run(win, 'window.expectWrites(0)');

  // 9. Invalid normal save stays open, focuses the error and never calls onSave.
  await run(win, 'window.mount({ initialTab: "chat" })');
  await run(win, 'window.waitMounted("#chat-base-url")');
  await run(win, 'window.changeValue("#chat-base-url", "not a url")');
  await run(win, 'window.clickText("保存设置")');
  await run(win, 'window.waitActiveError()');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.expectCounts(0, 0)');
  await run(win, 'window.expectWrites(0)');

  // 10. Invalid Save-and-close also stays open and focuses the error.
  await run(win, 'window.mount({ initialTab: "chat" })');
  await run(win, 'window.waitMounted("#chat-base-url")');
  await run(win, 'window.changeValue("#chat-base-url", "not a url")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.clickText("保存并关闭")');
  await run(win, 'window.waitActiveError()');
  await run(win, 'window.expectCounts(0, 0)');
  await run(win, 'window.expectWrites(0)');

  // 11. A valid Save-and-close persists once, calls onSave and closes.
  await run(win, 'window.mount({ initialTab: "chat" })');
  await run(win, 'window.waitMounted("#chat-api-key")');
  await run(win, 'window.changeValue("#chat-api-key", "sk-updated")');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.expectWrites(0)');
  await run(win, 'window.clickText("保存并关闭")');
  await run(win, 'window.waitClose(1)');
  await run(win, 'window.waitSave(1)');
  await run(win, 'window.expectWrites(1)');
  await run(win, 'window.expect(window.savedChatApiKey() === "sk-updated", "saved chat api key")');
  await run(win, 'window.expect(window.firstWriteKey() === "yeyu-agent-settings", "only agent settings persisted")');

  // 12. Escape on dirty settings opens the prompt, a second Escape continues editing.
  await run(win, 'window.mount({ initialTab: "chat" })');
  await run(win, 'window.waitMounted("#chat-base-url")');
  await run(win, 'window.changeValue("#chat-base-url", "https://api.example.com/escape")');
  key(win, 'Escape');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.expectCounts(0, 0)');
  key(win, 'Escape');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.expectValue("#chat-base-url", "https://api.example.com/escape")');
  await run(win, 'window.expectCounts(0, 0)');
  await run(win, 'window.cancel()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.clickText("放弃修改")');
  await run(win, 'window.waitClose(1)');

  // 13. Dirty X and outside press both open the prompt.
  await run(win, 'window.mount({ initialTab: "chat" })');
  await run(win, 'window.waitMounted("#chat-base-url")');
  await run(win, 'window.changeValue("#chat-base-url", "https://api.example.com/x-outside")');
  await run(win, 'window.clickX()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.expectCounts(0, 0)');
  await run(win, 'window.clickText("继续编辑")');
  await run(win, 'window.waitConfirm(false)');
  await run(win, 'window.clickOutside()');
  await run(win, 'window.waitConfirm(true)');
  await run(win, 'window.clickText("放弃修改")');
  await run(win, 'window.waitClose(1)');
  await run(win, 'window.expectWrites(0)');
};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 820, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL(${JSON.stringify(url)});
    await scenario(win);
    console.log('SETTINGS_CLOSE_BROWSER_OK');
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    win.destroy();
    app.exit(1);
  }
});
`,
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
      child.stdout.on('data', (value) => {
        log += value;
      });
      child.stderr.on('data', (value) => {
        log += value;
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('browser timeout ' + log));
      }, 60000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(log);
        else reject(new Error(log));
      });
    });
    assert.match(output, /SETTINGS_CLOSE_BROWSER_OK/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
