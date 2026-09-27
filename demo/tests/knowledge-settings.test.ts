import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CHAT_SETTINGS } from '../lib/chat-cache.ts';
import {
  DEFAULT_KNOWLEDGE_SETTINGS,
  knowledgeSettingsConfigured,
  loadKnowledgeSettings,
  saveKnowledgeSettings,
  validateKnowledgeSettings,
  type KnowledgeSettings,
} from '../lib/knowledge-settings.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const configured: KnowledgeSettings = {
  baseUrl: 'https://kb.example.com/v1',
  apiKey: 'kb-key',
  model: 'knowledge-model-x',
  generationMode: 'fast',
};

void test('validation requires http(s) url, api key, and model', () => {
  assert.equal(validateKnowledgeSettings(configured), null);
  assert.match(
    validateKnowledgeSettings({ ...configured, baseUrl: 'not a url' }) ?? '',
    /接口地址/,
  );
  assert.match(
    validateKnowledgeSettings({ ...configured, baseUrl: 'ftp://x.com/v1' })!,
    /接口地址/,
  );
  assert.match(
    validateKnowledgeSettings({ ...configured, apiKey: '  ' })!,
    /API Key/,
  );
  assert.match(validateKnowledgeSettings({ ...configured, model: '' })!, /模型/);
  assert.equal(knowledgeSettingsConfigured(configured), true);
  assert.equal(knowledgeSettingsConfigured({ ...configured, apiKey: '' }), false);
});

void test('load returns defaults when nothing is stored', () => {
  const storage = memoryStorage();
  assert.deepEqual(loadKnowledgeSettings(storage), DEFAULT_KNOWLEDGE_SETTINGS);
});

void test('load migrates from saved AI chat settings for existing users', () => {
  const storage = memoryStorage({
    'pdf-reader-chat-settings': JSON.stringify({
      baseUrl: 'https://chat.example.com/v1',
      apiKey: 'chat-key',
      model: 'vision-model',
      visionConfirmed: true,
    }),
  });
  assert.deepEqual(loadKnowledgeSettings(storage), {
    baseUrl: 'https://chat.example.com/v1',
    apiKey: 'chat-key',
    model: 'vision-model',
    generationMode: 'fast',
  });
});

void test('old independent settings default to fast generation mode', () => {
  const storage = memoryStorage({
    'pdf-reader-knowledge-settings': JSON.stringify({
      baseUrl: configured.baseUrl,
      apiKey: configured.apiKey,
      model: configured.model,
    }),
  });
  assert.deepEqual(loadKnowledgeSettings(storage), configured);
});

void test('saved knowledge settings win over the chat migration fallback', () => {
  const storage = memoryStorage({
    'pdf-reader-chat-settings': JSON.stringify({
      ...DEFAULT_CHAT_SETTINGS,
      apiKey: 'chat-key',
    }),
    'pdf-reader-knowledge-settings': JSON.stringify(configured),
  });
  assert.deepEqual(loadKnowledgeSettings(storage), configured);
});

void test('corrupt knowledge settings fall back to chat settings instead of crashing', () => {
  const storage = memoryStorage({
    'pdf-reader-chat-settings': JSON.stringify({
      baseUrl: 'https://chat.example.com/v1',
      apiKey: 'chat-key',
      model: 'vision-model',
    }),
    'pdf-reader-knowledge-settings': '{not json',
  });
  assert.deepEqual(loadKnowledgeSettings(storage), {
    baseUrl: 'https://chat.example.com/v1',
    apiKey: 'chat-key',
    model: 'vision-model',
    generationMode: 'fast',
  });
});

void test('save then load round-trips through storage', () => {
  const storage = memoryStorage();
  const deepSettings: KnowledgeSettings = {
    ...configured,
    generationMode: 'deep',
  };
  saveKnowledgeSettings(deepSettings, storage);
  assert.deepEqual(loadKnowledgeSettings(storage), deepSettings);
});

void test('validation rejects unknown generation modes', () => {
  const invalidSettings = {
    ...configured,
    generationMode: 'balanced',
  } as unknown as KnowledgeSettings;
  assert.match(validateKnowledgeSettings(invalidSettings) ?? '', /生成模式/);
});

void test('partial stored settings merge over defaults', () => {
  const storage = memoryStorage({
    'pdf-reader-knowledge-settings': JSON.stringify({ model: 'custom-model' }),
  });
  const loaded = loadKnowledgeSettings(storage);
  assert.equal(loaded.model, 'custom-model');
  assert.equal(loaded.baseUrl, DEFAULT_KNOWLEDGE_SETTINGS.baseUrl);
  assert.equal(loaded.generationMode, 'fast');
});
