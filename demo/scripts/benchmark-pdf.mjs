// Opt-in in-memory model benchmark. Credentials remain inside the running
// desktop renderer; every cache is private to the benchmark. Results contain
// timings and counts only, never PDF text, prompts, completions, or secrets.
// This is a memory/model benchmark, not a production end-to-end import:
// external upload network, durable filesystem artifacts, actual background
// scheduling, and candidate review publication are out of scope.
// node scripts/benchmark-pdf.mjs <course-directory> <pdf-name> [report-path]
//   [--bundle <frozen-iife>] [--source-revision <hex>]
// Exit codes: 0 = complete within target, 1 = failed/incomplete, 2 = complete but over target.
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BENCHMARK_ALREADY_RUNNING,
  BENCHMARK_DEBUG_PORT,
  BENCHMARK_REPORT_MISSING,
  parseBenchmarkCliArgs,
  resolveBenchmarkBundle,
  selectBenchmarkTarget,
  summarizeProgress,
} from './benchmark-pdf-report.mjs';

const options = parseBenchmarkCliArgs(process.argv.slice(2));
const targets = await (await fetch(`http://127.0.0.1:${BENCHMARK_DEBUG_PORT}/json/list`)).json();
const target = selectBenchmarkTarget(targets);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
async function evaluate(expression) {
  const id = ++sequence;
  const result = new Promise(resolve => pending.set(id, resolve));
  socket.send(JSON.stringify({id, method:'Runtime.evaluate', params:{expression, returnByValue:true, awaitPromise:true}}));
  const message = await result;
  if (message.error || message.result.exceptionDetails) throw new Error('Benchmark evaluation failed (credentials/content suppressed).');
  return message.result.result.value;
}
try {
  if (await evaluate('Boolean(window.__yeyuPdfModelBenchmark && !window.__yeyuPdfModelBenchmark.done)')) throw new Error(BENCHMARK_ALREADY_RUNNING);
  // An explicit frozen bundle is evaluated verbatim; building stays available
  // when --bundle is omitted. No loaded setting/model/backend is replaced.
  const bundle = await resolveBenchmarkBundle({
    bundlePath: options.bundlePath,
    readBundle: path => readFile(path, 'utf8'),
    buildBundle: () => build({entryPoints:['scripts/benchmark-pdf-runner.ts'], bundle:true, platform:'browser', format:'iife', write:false, logLevel:'silent'}),
  });
  // The hash identifies actual executable provider+harness code; a declared
  // source revision alone does not identify dirty changes or host transport.
  const executionIdentity = {
    bundleSha256: createHash('sha256').update(bundle.source).digest('hex'),
    bundleSource: bundle.built ? 'built-current-working-tree' : 'frozen',
    transportLabel: options.transportLabel ?? 'unspecified',
    transportLabelVerifiedByCli: false,
  };
  await evaluate(bundle.source);
  await evaluate(`window.__startYeyuPdfModelBenchmark(${JSON.stringify({course: options.course, fileName: options.fileName, ...(options.sourceRevision ? {sourceRevision: options.sourceRevision} : {}), ...(options.privateQualityPath ? {capturePrivateQuality:true} : {}), ...(options.existingPdf ? {existingPdf:options.existingPdf} : {})})}); true`);
  for (;;) {
    const report = await evaluate('window.__yeyuPdfModelBenchmark');
    if (!report || typeof report !== 'object') throw new Error(BENCHMARK_REPORT_MISSING);
    if (report.done) {
      report.executionIdentity = executionIdentity;
      if (options.reportPath) await writeFile(options.reportPath, JSON.stringify(report, null, 2) + '\n');
      if (options.privateQualityPath) {
        const privateQuality = await evaluate('window.__yeyuPdfModelBenchmarkPrivate');
        await writeFile(options.privateQualityPath, JSON.stringify(privateQuality) + '\n', {mode:0o600,flag:'wx'});
        await evaluate('window.__yeyuPdfModelBenchmarkPrivate = undefined; true');
      }
      // Incomplete is always a failure, never a success.
      process.exitCode = report.error ? 1 : report.complete ? (report.targetMet ? 0 : 2) : 1;
      break;
    }
    console.log(JSON.stringify(summarizeProgress(report, Date.now() - Date.parse(report.startedAt))));
    await delay(15000);
  }
} finally { socket.close(); }
