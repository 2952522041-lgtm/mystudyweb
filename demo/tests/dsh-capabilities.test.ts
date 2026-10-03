import assert from 'node:assert/strict';
import test from 'node:test';
import { assessDshSettings } from '../lib/agent-settings.ts';
import { TRANSLATION_PRESETS } from '../lib/reader-cache.ts';
import { dshConfigurationIssue } from '../lib/dsh-capabilities.ts';
import { buildDshPatch, validateDshRequest } from '../electron/dsh-policy.ts';
import { DshError, safeDshError, classifyDshProviderError } from '../lib/dsh-errors.ts';

const config = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'secret' };
const request = { ...config, requestId: 'capabilities', messages: [{ role: 'user' as const, content: 'private' }], maxTokens: 128, thinking: 'disabled' as const };

void test('every translation preset is admitted without replacing its model or key', () => {
  for (const preset of Object.values(TRANSLATION_PRESETS)) {
    assert.equal(dshConfigurationIssue({ ...preset, apiKey: 'key' }), null);
    assert.equal(validateDshRequest({ ...request, ...preset }).model, preset.model);
  }
  const patch = buildDshPatch('system', request);
  const adapter = patch.find(entry => entry.id === 'llm-deepseek' && 'config' in entry);
  assert.ok(adapter && 'config' in adapter && adapter.config && 'models' in adapter.config);
  assert.ok(adapter.config.models?.some(model => model.id === config.model));
});

void test('DSH scope validates only routed functions, with image and key field guidance', () => {
  const configs = { translation: { ...config, providerMode: 'openai-compatible' }, knowledge: config, chat: { ...config, model: 'gpt-api-only' } };
  const limited = assessDshSettings({ backend: 'dsh', dshDocumentChat: true }, configs);
  assert.equal(limited.some(row => row.issue), false);
  assert.equal(limited.find(row => row.task === 'page-chat')?.backend, 'api');
  const all = assessDshSettings({ backend: 'dsh', dshDocumentChat: true, allAi: true }, { ...configs, chat: config });
  assert.equal(all.find(row => row.task === 'ocr')?.issue?.field, 'model');
  assert.equal(dshConfigurationIssue({ ...config, apiKey: '' })?.field, 'api-key');
  assert.equal(dshConfigurationIssue({ ...config, baseUrl: 'https://api.deepseek.com.evil.com' })?.field, 'base-url');
});

void test('unsupported SDK options are rejected and timeout/task metadata is projected', () => {
  for (const option of [{ temperature: 0.1 }, { responseFormat: 'json_object' }]) {
    assert.throws(() => validateDshRequest({ ...request, ...option }), /unsupported_parameter/);
  }
  const options = { task: 'background' as const, timeoutMs: 120_000, connectionTimeoutMs: 20_000, streamStallTimeoutMs: 10_000 };
  assert.deepEqual(validateDshRequest({ ...request, ...options }), { ...request, ...options });
  for (const timeoutMs of [-1, 0, Infinity, 600_001, '3000']) assert.throws(() => validateDshRequest({ ...request, timeoutMs }));
  assert.throws(() => validateDshRequest({ ...request, task: 'shell' }));
});

void test('known errors remain actionable while hostile text and credentials are discarded', () => {
  assert.equal(safeDshError(new Error('IPC error [DSH:authentication] private-key private-prompt')).code, 'authentication');
  assert.equal(safeDshError(new Error('[DSH:evil] private-key')).code, 'incomplete');
  assert.equal(safeDshError(new DshError('runtime_version')).code, 'runtime_version');
  for (const [status, code] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate_limit'], [500, 'incomplete']] as const) {
    const error = classifyDshProviderError({ status, message: 'private-key private-prompt' });
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /private/);
  }
  assert.equal(classifyDshProviderError({ cause: { code: 'ECONNRESET' } }).code, 'network');
});
