// Opt-in installed-runtime probe: no real API key, no model request, no course data.
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
} from '../electron/dsh-policy.ts';

void test(
  'installed DSH composes a tool-free policy and completes SDK handshake',
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
      const patch = path.join(job, 'policy.json');
      await writeFile(
        patch,
        JSON.stringify(buildDshPatch('Return plain text.')),
        { mode: 0o600 },
      );
    const env = {
        NODE_ENV: 'test' as const,
        PATH: process.env.PATH ?? '',
        DSH_HOME: path.join(job, 'home'),
        DEEPSEEK_API_KEY: 'fake-never-sent',
      };
      const yaml = await import(
        pathToFileURL(path.join(runtime, 'node_modules/yaml/dist/index.js'))
          .href
      );
      const result = spawnSync(
        path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'),
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
      assert.equal(result.status, 0);
      const config = yaml.parse(result.stdout, {
        customTags: [
          { tag: 'tag:yaml.org,2002:js', resolve: (s: string) => s },
        ],
      });
      const enabled = config.filter((x: { disabled?: boolean }) => !x.disabled);
      assert.deepEqual(
        enabled.filter((x: { name: string }) =>
          /tool-|terminal|subprocess|mcp-resources/.test(x.name),
        ),
        [],
      );
      assert.equal(
        enabled.find((x: { id: string }) => x.id === 'sandbox-policy').config
          .mode,
        'read-only',
      );
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
        provider: 'deepseek-official',
        model: 'deepseek-flash',
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
