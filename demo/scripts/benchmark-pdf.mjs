// Opt-in real-provider benchmark. Credentials remain inside the running desktop
// renderer; existing courses and caches are read-only. Results contain timings only.
// node scripts/benchmark-pdf.mjs <course-directory> <pdf-name> [report-path]
// Exit codes: 0 = complete within 180s, 1 = failed, 2 = complete but over target.
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [course, fileName, reportPath] = process.argv.slice(2);
if (!course || !fileName) throw new Error('Usage: benchmark-pdf.mjs <course-directory> <pdf-name> [report-path]');
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const target = targets.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:47831/'));
if (!target) throw new Error('Start the desktop app with loopback debugging port 9223 first.');
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
  if (await evaluate('Boolean(window.__pdfBenchmark && !window.__pdfBenchmark.done)')) throw new Error('A benchmark is already running.');
  const bundle = await build({entryPoints:['scripts/benchmark-pdf-runner.ts'], bundle:true, platform:'browser', format:'iife', write:false, logLevel:'silent'});
  await evaluate(bundle.outputFiles[0].text);
  await evaluate(`window.__startPdfBenchmark(${JSON.stringify({course,fileName})}); true`);
  for (;;) {
    const report = await evaluate('window.__pdfBenchmark');
    console.log(JSON.stringify(report.done ? report : {stage:report.stage,elapsedMs:Date.now()-Date.parse(report.startedAt),requests:report.requests.map(r=>({startMs:r.startMs,totalMs:r.totalMs,outputChars:r.outputChars}))}));
    if (report.done) {
      if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      process.exitCode = report.error ? 1 : report.targetMet ? 0 : 2;
      break;
    }
    await delay(15000);
  }
} finally { socket.close(); }
