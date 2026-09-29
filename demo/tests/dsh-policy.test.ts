import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDshPatch,
  dshLaunchOptions,
  validateDshRequest,
} from '../electron/dsh-policy.ts';

void test('pinned SDK receives its current launch API, never the ignored legacy command/args options', () => {
  const options = dshLaunchOptions(
    '/isolated/policy.json',
    '/isolated/workspace',
    { DSH_HOME: '/isolated/home' },
  );
  assert.equal(options.profile, 'sdk-minimal');
  assert.deepEqual(options.patches, ['/isolated/policy.json']);
  assert.equal(options.processCwd, '/isolated/workspace');
  assert.equal('args' in options, false);
  assert.equal('command' in options, false);
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'policy-1',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-policy-test',
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: '请回答。' }],
    maxTokens: 128,
    thinking: 'default',
    ...overrides,
  };
}

void test('accepts only the official DeepSeek addresses and model allowlist', () => {
  const officialAddresses = [
    'https://api.deepseek.com',
    'https://api.deepseek.com/',
    'https://api.deepseek.com/v1',
    'https://api.deepseek.com/v1/',
  ];
  const allowedModels = ['deepseek-flash', 'deepseek-v4-pro'];

  for (const baseUrl of officialAddresses) {
    for (const model of allowedModels) {
      const value = validateDshRequest(request({ baseUrl, model }));
      assert.equal(value.baseUrl, baseUrl);
      assert.equal(value.model, model);
    }
  }

  for (const baseUrl of [
    'http://api.deepseek.com/v1',
    'https://api.deepseek.com.evil.example/v1',
    'https://api.deepseek.com:8443/v1',
    'https://api.deepseek.com/v2',
    'https://api.deepseek.com/v1?redirect=https://evil.example',
  ]) {
    assert.throws(
      () => validateDshRequest(request({ baseUrl })),
      /DeepSeek 官方接口/,
    );
  }
  assert.throws(
    () => validateDshRequest(request({ model: 'deepseek-chat' })),
    /deepseek-flash \/ deepseek-v4-pro/,
  );
});

void test('projects unknown request fields into the text-only DSH boundary', () => {
  const projected = validateDshRequest(
    request({
      unknownField: 'must be dropped',
      tools: [{ type: 'shell', command: 'rm -rf /' }],
      path: '/tmp/private.pdf',
      metadata: { apiKey: 'do not copy' },
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'user' },
      ],
    }),
  );

  assert.deepEqual(projected, {
    requestId: 'policy-1',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-policy-test',
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ],
    maxTokens: 128,
    thinking: 'default',
  });
  assert.equal(Object.hasOwn(projected, 'tools'), false);
  assert.equal(Object.hasOwn(projected, 'path'), false);
  assert.equal(Object.hasOwn(projected, 'metadata'), false);
});

void test('builds a read-only profile with every tool-capability entry disabled', () => {
  const patch = buildDshPatch('trusted application system prompt');
  const disabledIds = patch
    .filter(
      (entry): entry is { id: string; disabled: true } =>
        'disabled' in entry && entry.disabled === true,
    )
    .map((entry) => entry.id)
    .sort();

  assert.deepEqual(
    disabledIds,
    [
      'deepseek-llm-api-extensions',
      'mcp-resources',
      'persistent-bash',
      'persistent-pwsh',
      'plugin-package-inventory-deepseek',
      'pty',
      'session-log-deepseek',
      'subprocess',
      'terminal-bash',
      'terminal-pwsh',
    ].sort(),
  );

  assert.equal(
    patch.some((entry) => 'tools' in entry),
    false,
  );
  assert.equal(
    patch.some((entry) => 'enabled' in entry),
    false,
  );
  assert.deepEqual(
    patch.find((entry) => entry.id === 'sdk-jsonrpc-server'),
    { id: 'sdk-jsonrpc-server', config: { maxTokensAsSuccess: false } },
  );
  const sandbox = patch.find((entry) => entry.id === 'sandbox-policy');
  assert.deepEqual(sandbox, {
    id: 'sandbox-policy',
    config: { mode: 'read-only' },
  });
  const systemPrompt = patch.find((entry) => entry.id === 'system-prompt');
  assert.ok(systemPrompt && 'config' in systemPrompt);
  if (systemPrompt?.config && typeof systemPrompt.config.personaPrefix==='string') {
    assert.equal(systemPrompt.config.includeHarnessIdentity, false);
    assert.equal(systemPrompt.config.includeRuntimeContext, false);
    assert.match(
      systemPrompt.config.personaPrefix,
      /trusted application system prompt/,
    );
  }
});
