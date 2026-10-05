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
import { dshPrompt } from './dsh-prompt.ts';
import { dshWebSearch } from './dsh-search.ts';
import { DshError, classifyDshProviderError } from './dsh-errors.ts';

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
    if (input.length > 17_000_000) throw new Error('request');
  }
  const request = validateDshRequest(JSON.parse(input));
  if (request.operation === 'web-search') {
    send({ type: 'ready' });
    const content = await dshWebSearch(
      request.apiKey,
      request.messages[0].content as string,
    );
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(
        JSON.stringify({ type: 'result', content, finishReason: 'stop' }) +
          '\n',
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    process.exit(0);
  }
  const packageRoot = path.join(runtimeRoot, 'node_modules', '@deepseek-ai');
  for (const [name, version] of [
    ['dsh', DSH_RUNTIME_VERSION],
    ['dsh-sdk-client', DSH_CLIENT_VERSION],
    ['dsh-llm-pi-ai', DSH_RUNTIME_VERSION],
    ['dsh-attachment-local', DSH_RUNTIME_VERSION],
  ]) {
    let metadata;
    try { metadata = JSON.parse(await readFile(path.join(packageRoot, name, 'package.json'), 'utf8')); } catch { throw new DshError('runtime_missing'); }
    if (metadata.version !== version) throw new DshError('runtime_version');
  }
  const sdk = await import(
    pathToFileURL(path.join(packageRoot, 'dsh-sdk-client', 'lib', 'index.js'))
      .href
  );
  const patchPath = path.join(taskRoot, 'policy.json');
  const { system, blocks } = dshPrompt(request);
  await writeFile(patchPath, JSON.stringify(buildDshPatch(system, request)), {
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
    YEYU_PROVIDER_KEY: request.apiKey,
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
    provider:
      new URL(request.baseUrl).hostname === 'open.bigmodel.cn'
        ? 'yeyu-zhipu'
        : 'deepseek-official',
    model: request.model,
    maxTokens: request.maxTokens,
    reasoningEffort: request.thinking === 'disabled' ? 'off' : 'high',
  });
  if (identity.serverInfo.name !== 'deepseek-harness-sdk-runtime')
    throw new DshError('runtime_version');
  send({ type: 'ready' });
  const sessionId = `yeyu-${randomUUID()}`;
  const subscription = runtime.subscribeSessionTree(sessionId);
  try {
    const messageId = await runtime.prompt(sessionId, blocks);
    const collector = new DshEventCollector(sessionId, messageId);
    let previous = '';
    let firstEvent = true;
    while (!collector.done) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // SDK notifications do not promise token-level activity. The pinned
        // runtime can publish the durable assistant message only after its
        // stream finishes. After startup, let the adapter enforce real network
        // idle limits and the manager enforce the total deadline/cancellation.
        collector.observe(firstEvent
          ? await Promise.race([subscription.next(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DshError('timeout')), request.connectionTimeoutMs ?? 30_000); })])
          : await subscription.next());
      } finally { if (timer) clearTimeout(timer); }
      firstEvent = false;
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
} catch (error) {
  await shutdown();
  send({ type: 'error', code: classifyDshProviderError(error).code });
  process.exitCode = 1;
}
