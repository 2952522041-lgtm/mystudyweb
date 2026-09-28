// Bundled to an external Node worker; the SDK owns and reaps its DSH subprocess.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  buildDshPatch,
  dshLaunchOptions,
  validateDshRequest,
  DSH_RUNTIME_VERSION,
  DSH_CLIENT_VERSION,
} from './dsh-policy.ts';
import { DshEventCollector } from './dsh-events.ts';

const [runtimeRoot, taskRoot] = process.argv.slice(2);
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n');
let client: { close(): Promise<void> } | undefined;
let closing: Promise<void> | undefined;
async function shutdown() {
  closing ??= client?.close().catch(() => undefined) ?? Promise.resolve();
  await closing;
}
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(1));
});
process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(1));
});

try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_100_000) throw new Error('request');
  }
  const request = validateDshRequest(JSON.parse(input));
  const packageRoot = path.join(runtimeRoot, 'node_modules', '@deepseek-ai');
  for (const [name, version] of [
    ['dsh', DSH_RUNTIME_VERSION],
    ['dsh-sdk-client', DSH_CLIENT_VERSION],
  ]) {
    const metadata = JSON.parse(
      await readFile(path.join(packageRoot, name, 'package.json'), 'utf8'),
    );
    if (metadata.version !== version) throw new Error('runtime version');
  }
  const sdk = await import(
    pathToFileURL(path.join(packageRoot, 'dsh-sdk-client', 'lib', 'index.js'))
      .href
  );
  const patchPath = path.join(taskRoot, 'policy.json');
  const system = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  await writeFile(patchPath, JSON.stringify(buildDshPatch(system)), {
    mode: 0o600,
  });
  await mkdir(path.join(taskRoot, 'workspace'), {
    recursive: true,
    mode: 0o700,
  });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    DSH_HOME: path.join(taskRoot, 'home'),
    DEEPSEEK_API_KEY: request.apiKey,
    DSH_MAX_TOKENS_AS_SUCCESS: 'false',
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const runtime = new sdk.HarnessClient(
    dshLaunchOptions(patchPath, path.join(taskRoot, 'workspace'), env),
  );
  client = runtime;
  runtime.start();
  const identity = await runtime.initialize({
    cwd: path.join(taskRoot, 'workspace'),
    provider: 'deepseek-official',
    model: request.model,
    maxTokens: request.maxTokens,
    reasoningEffort: request.thinking === 'disabled' ? 'off' : 'high',
  });
  if (identity.serverInfo.name !== 'deepseek-harness-sdk-runtime')
    throw new Error('identity');
  const sessionId = `yeyu-${randomUUID()}`;
  const subscription = runtime.subscribeSessionTree(sessionId);
  try {
    const messageId = await runtime.prompt(sessionId, [
      {
        type: 'text',
        text: JSON.stringify({
          messages: request.messages.filter((m) => m.role !== 'system'),
        }),
      },
    ]);
    const collector = new DshEventCollector(sessionId, messageId);
    let previous = '';
    while (!collector.done) {
      collector.observe(await subscription.next());
      if (collector.content !== previous) {
        previous = collector.content;
        send({ type: 'progress', content: previous });
      }
    }
    const result = collector.result();
    // Close before announcing success so process/resource leaks cannot be hidden.
    await shutdown();
    send({ type: 'result', ...result });
  } finally {
    subscription.close();
  }
} catch {
  await shutdown();
  send({
    type: 'error',
    message:
      'DSH 任务未完整完成。请检查托管运行时、DeepSeek 配置或切回 API；未发布残缺成果。',
  });
  process.exitCode = 1;
}
