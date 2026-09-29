import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_AGENT_SETTINGS,
  loadAgentSettings,
  readSelectedAgentBackend,
  saveAgentSettings,
  useDshForTask,
  type AgentSettings,
} from '../lib/agent-settings.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function replaceGlobalLocalStorage(value: Storage | undefined): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, 'localStorage', descriptor);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  };
}

void test('agent settings default to API without browser storage', () => {
  const restore = replaceGlobalLocalStorage(undefined);
  try {
    assert.deepEqual(loadAgentSettings(), DEFAULT_AGENT_SETTINGS);
    assert.equal(readSelectedAgentBackend(), 'api');
  } finally {
    restore();
  }
});

void test('load accepts only the persisted API and DSH backends', () => {
  const valid = memoryStorage({
    'yeyu-agent-settings': JSON.stringify({ backend: 'dsh' }),
  });
  assert.deepEqual(loadAgentSettings(valid), {
    backend: 'dsh',
    dshDocumentChat: false,
  });
  assert.deepEqual(
    loadAgentSettings(
      memoryStorage({
        'yeyu-agent-settings': JSON.stringify({
          backend: 'dsh',
          dshDocumentChat: true,
        }),
      }),
    ),
    { backend: 'dsh', dshDocumentChat: true },
  );

  for (const raw of [
    '{not json',
    JSON.stringify(null),
    JSON.stringify({}),
    JSON.stringify({ backend: 'harness' }),
    JSON.stringify({ backend: '' }),
    JSON.stringify({ backend: 'dsh', dshDocumentChat: 'yes' }),
    JSON.stringify({ backend: 'dsh', dshDocumentChat: false, allAi: 'yes' }),
  ]) {
    assert.deepEqual(
      loadAgentSettings(memoryStorage({ 'yeyu-agent-settings': raw })),
      DEFAULT_AGENT_SETTINGS,
    );
  }
});

void test('storage failures while loading safely fall back to API', () => {
  assert.deepEqual(
    loadAgentSettings({
      getItem() {
        throw new Error('storage unavailable');
      },
    }),
    DEFAULT_AGENT_SETTINGS,
  );
});

void test('save writes the exact storage key and round-trips DSH', () => {
  const storage = memoryStorage();
  saveAgentSettings({ backend: 'dsh', dshDocumentChat: true }, storage);
  assert.equal(
    storage.data.get('yeyu-agent-settings'),
    JSON.stringify({ backend: 'dsh', dshDocumentChat: true }),
  );
  assert.deepEqual(loadAgentSettings(storage), {
    backend: 'dsh',
    dshDocumentChat: true,
  });
});

void test('save rejects every backend outside the strict union', () => {
  const storage = memoryStorage();
  for (const backend of ['harness', '', 'API', undefined]) {
    assert.throws(
      () =>
        saveAgentSettings(
          { backend, dshDocumentChat: false } as unknown as AgentSettings,
          storage,
        ),
      /either "api" or "dsh"/,
    );
  }
  assert.equal(storage.data.has('yeyu-agent-settings'), false);
});

void test('save rejects a non-boolean whole-document DSH opt-in', () => {
  const storage = memoryStorage();
  assert.throws(
    () =>
      saveAgentSettings(
        { backend: 'dsh', dshDocumentChat: 'yes' } as unknown as AgentSettings,
        storage,
      ),
    /dshDocumentChat must be boolean/,
  );
  assert.equal(storage.data.has('yeyu-agent-settings'), false);
});

void test('allAi expands DSH routing to every AI task without changing API mode', () => {
  const storage = memoryStorage();
  const restore = replaceGlobalLocalStorage(storage as unknown as Storage);
  const tasks = [
    'knowledge',
    'document-chat',
    'page-chat',
    'translation',
    'ocr',
    'web-search',
  ] as const;
  try {
    storage.setItem(
      'yeyu-agent-settings',
      JSON.stringify({ backend: 'api', dshDocumentChat: true, allAi: true }),
    );
    for (const task of tasks) assert.equal(useDshForTask(task), false, task);

    storage.setItem(
      'yeyu-agent-settings',
      JSON.stringify({ backend: 'dsh', dshDocumentChat: false }),
    );
    assert.equal(useDshForTask('knowledge'), true);
    assert.equal(useDshForTask('document-chat'), false);
    for (const task of [
      'page-chat',
      'translation',
      'ocr',
      'web-search',
    ] as const) {
      assert.equal(useDshForTask(task), false, task);
    }

    storage.setItem(
      'yeyu-agent-settings',
      JSON.stringify({ backend: 'dsh', dshDocumentChat: true }),
    );
    assert.equal(useDshForTask('knowledge'), true);
    assert.equal(useDshForTask('document-chat'), true);
    for (const task of [
      'page-chat',
      'translation',
      'ocr',
      'web-search',
    ] as const) {
      assert.equal(useDshForTask(task), false, task);
    }

    storage.setItem(
      'yeyu-agent-settings',
      JSON.stringify({ backend: 'dsh', dshDocumentChat: false, allAi: true }),
    );
    for (const task of tasks) assert.equal(useDshForTask(task), true, task);
  } finally {
    restore();
  }
});

void test('readSelectedAgentBackend reads global browser storage and falls back safely', () => {
  const storage = memoryStorage({
    'yeyu-agent-settings': JSON.stringify({
      backend: 'dsh',
      dshDocumentChat: false,
    }),
  });
  const restore = replaceGlobalLocalStorage(storage as unknown as Storage);
  try {
    assert.equal(readSelectedAgentBackend(), 'dsh');
    storage.setItem(
      'yeyu-agent-settings',
      JSON.stringify({ backend: 'unknown' }),
    );
    assert.equal(readSelectedAgentBackend(), 'api');
  } finally {
    restore();
  }
});

const dialogSource = await readFile(
  new URL('../components/reader-settings-dialog.tsx', import.meta.url),
  'utf8',
);

void test('settings dialog keeps backend selection outside the three service tabs', () => {
  assert.match(dialogSource, /loadAgentSettings\(\)/);
  assert.match(dialogSource, /saveAgentSettings\(agentSettingsDraft\)/);
  assert.match(dialogSource, /AI 执行后端/);
  assert.match(dialogSource, /value="api">API 直接调用/);
  assert.match(dialogSource, /value="dsh">[\s\S]*DeepSeek Harness/);
  assert.match(
    dialogSource,
    /可统一管理整理、翻译、OCR 和答疑；每项继续使用对应的模型配置。/,
  );
  assert.match(dialogSource, /DSH 支持已接入的官方 DeepSeek \/ 智谱模型/);
  assert.match(
    dialogSource,
    /整份文档问答使用知识库的 DeepSeek 配置（页面图片问答仍用原配置）/,
  );
  assert.match(dialogSource, /agent-dsh-document-chat/);
  assert.match(dialogSource, /必须安装页语托管的 DSH 运行时/);
  assert.match(dialogSource, /本设置页不检测运行时状态/);

  const sectionIndex = dialogSource.indexOf(
    'aria-labelledby="agent-backend-heading"',
  );
  const tabsIndex = dialogSource.indexOf('<Tabs');
  assert.ok(sectionIndex >= 0 && sectionIndex < tabsIndex);
});

void test('backend is persisted only after the existing settings validations', () => {
  const saveBody = dialogSource.slice(
    dialogSource.indexOf('  const save = () => {'),
    dialogSource.indexOf('  const chooseTranslationPreset'),
  );
  assert.ok(
    saveBody.indexOf('validateReaderSettings') <
      saveBody.indexOf('saveAgentSettings'),
  );
  assert.ok(
    saveBody.indexOf('validateChatSettings') <
      saveBody.indexOf('saveAgentSettings'),
  );
  assert.ok(
    saveBody.indexOf('validateKnowledgeSettings') <
      saveBody.indexOf('saveAgentSettings'),
  );
  assert.doesNotMatch(saveBody, /onClose\(\)[\s\S]*saveAgentSettings/);
});
