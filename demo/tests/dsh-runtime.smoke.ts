// Opt-in installed-runtime probe: fake keys only, no model request, no course data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildDshPatch,
  dshLaunchOptions,
  DSH_RUNTIME_VERSION,
  validateDshRequest,
} from '../electron/dsh-policy.ts';

const smokeFixtures = [
  {
    label: 'official DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    provider: 'deepseek-official',
  },
  {
    label: 'official Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6v',
    provider: 'yeyu-zhipu',
  },
] as const;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function configRows(config: unknown): JsonRecord[] {
  assert.ok(Array.isArray(config), 'DSH config dump must be an array');
  return config
    .map(asRecord)
    .filter((row): row is JsonRecord => row !== undefined);
}

function requiredRow(rows: JsonRecord[], id: string): JsonRecord {
  const row = rows.find((candidate) => candidate.id === id);
  assert.ok(row, `missing DSH config row: ${id}`);
  return row;
}

function enabledRows(rows: JsonRecord[]): JsonRecord[] {
  return rows.filter((row) => row.disabled !== true);
}

function smokeRequest(fixture: (typeof smokeFixtures)[number]) {
  return validateDshRequest({
    requestId: `dsh-smoke-${fixture.provider}`,
    baseUrl: fixture.baseUrl,
    apiKey: 'fake-never-sent',
    model: fixture.model,
    thinking: 'disabled',
    maxTokens: 128,
    messages: [{ role: 'user', content: 'Return plain text.' }],
  });
}

function assertSafeConfig(
  config: unknown,
  fixture: (typeof smokeFixtures)[number],
) {
  const rows = configRows(config);
  const enabled = enabledRows(rows);
  const forbidden = enabled.filter((row) => {
    const identity = `${typeof row.id === 'string' ? row.id : ''} ${typeof row.name === 'string' ? row.name : ''}`;
    return /persistent-(?:bash|pwsh)|terminal|pty|subprocess|mcp|filetools|filesystem/i.test(
      identity,
    );
  });
  assert.deepEqual(
    forbidden,
    [],
    `${fixture.label} enabled shell/filesystem/MCP rows: ${JSON.stringify(forbidden)}`,
  );
  assert.equal(
    asRecord(requiredRow(enabled, 'sandbox-policy').config)?.mode,
    'read-only',
  );
  assert.equal(
    requiredRow(enabled, 'attachment-local').name,
    '@deepseek-ai/dsh-attachment-local',
  );

  if (fixture.provider !== 'yeyu-zhipu') return;
  assert.equal(requiredRow(rows, 'llm-deepseek').disabled, true);
  const adapter = requiredRow(enabled, 'yeyu-zhipu');
  assert.equal(adapter.name, '@deepseek-ai/dsh-llm-pi-ai');
  const adapterConfig = asRecord(adapter.config);
  const provider = asRecord(asRecord(adapterConfig?.providers)?.['yeyu-zhipu']);
  assert.equal(provider?.api, 'openai-completions');
  assert.equal(provider?.baseURL, 'https://open.bigmodel.cn/api/paas/v4');
  const compat = asRecord(provider?.compat);
  assert.equal(compat?.thinkingFormat, 'zai');
  assert.equal(compat?.supportsReasoningEffort, false);
  const models = provider?.models;
  assert.ok(Array.isArray(models));
  const model = asRecord(
    models.find((entry) => asRecord(entry)?.id === fixture.model),
  );
  assert.ok(model, `missing GLM model row: ${fixture.model}`);
  assert.deepEqual(asRecord(model.reasoningEfforts), {
    off: null,
    high: 'high',
  });
}

for (const fixture of smokeFixtures) {
  void test(
    `installed DSH composes a safe ${fixture.label} policy and completes SDK handshake`,
    { timeout: 20000 },
    async () => {
      const runtime = path.join(
        homedir(),
        '.local',
        'opt',
        `yeyu-dsh-runtime-${DSH_RUNTIME_VERSION}`,
      );
      const job = await mkdtemp(path.join(tmpdir(), 'yeyu-dsh-smoke-'));
      let client: { close(): Promise<void> } | undefined;
      try {
        const request = smokeRequest(fixture);
        const patch = path.join(job, 'policy.json');
        await writeFile(
          patch,
          JSON.stringify(buildDshPatch('Return plain text.', request)),
          { mode: 0o600 },
        );
        const env = {
          NODE_ENV: 'test' as const,
          PATH: process.env.PATH ?? '',
          DSH_HOME: path.join(job, 'home'),
          DEEPSEEK_API_KEY: 'fake-never-sent',
          YEYU_PROVIDER_KEY: 'fake-never-sent',
        };
        const yaml = await import(
          pathToFileURL(path.join(runtime, 'node_modules/yaml/dist/index.js'))
            .href
        );
        const result = spawnSync(
          path.join(
            runtime,
            process.platform === 'win32' ? 'node.exe' : 'node',
          ),
          [
            path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
            '--profile',
            'sdk-minimal',
            '--patch',
            patch,
            '--dump-config',
          ],
          { env, encoding: 'utf8', timeout: 10000 },
        );
        assert.equal(result.status, 0, result.stderr);
        const config = yaml.parse(result.stdout, {
          customTags: [
            { tag: 'tag:yaml.org,2002:js', resolve: (s: string) => s },
          ],
        });
        assertSafeConfig(config, fixture);

        const sdk = await import(
          pathToFileURL(
            path.join(
              runtime,
              'node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js',
            ),
          ).href
        );
        const options = dshLaunchOptions(patch, job, env);
        const harness = new sdk.HarnessClient(options);
        client = harness;
        assert.equal(harness.options.profile, 'sdk-minimal');
        assert.deepEqual(harness.options.patches, [patch]);
        harness.start();
        const hello = await harness.initialize({
          cwd: job,
          provider: fixture.provider,
          model: fixture.model,
          maxTokens: 128,
          reasoningEffort: 'off',
        });
        assert.equal(hello.serverInfo.name, 'deepseek-harness-sdk-runtime');
      } finally {
        await client?.close();
        await rm(job, { recursive: true, force: true });
      }
    },
  );
}
