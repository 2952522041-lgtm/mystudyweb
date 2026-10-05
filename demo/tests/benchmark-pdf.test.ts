import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BENCHMARK_SCOPE,
  createBenchmarkScopeMetadata,
  isBackgroundWorkerTarget,
  isSafeSourceRevision,
  parseBenchmarkCliArgs,
  projectUsage,
  resolveBenchmarkBundle,
  safeBenchmarkErrorLabel,
  sanitizeDiagnostic,
  selectBenchmarkTarget,
  summarizeProgress,
} from '../scripts/benchmark-pdf-report.mjs';

void test('CDP target selection picks the main page and rejects background-worker query pages', () => {
  const main = { type: 'page', url: 'http://127.0.0.1:47831/', webSocketDebuggerUrl: 'ws://main' };
  const queryWorker = { type: 'page', url: 'http://127.0.0.1:47831/?backgroundWorker=1', webSocketDebuggerUrl: 'ws://query' };
  const pathWorker = { type: 'page', url: 'http://127.0.0.1:47831/background/worker.html', webSocketDebuggerUrl: 'ws://path' };
  const hashWorker = { type: 'page', url: 'http://127.0.0.1:47831/#worker', webSocketDebuggerUrl: 'ws://hash' };
  const shareView = { type: 'page', url: 'http://127.0.0.1:47831/?yeyu-share=1', webSocketDebuggerUrl: 'ws://share' };
  const otherOrigin = { type: 'page', url: 'http://127.0.0.1:49999/', webSocketDebuggerUrl: 'ws://other' };
  const browserTarget = { type: 'browser', url: 'http://127.0.0.1:47831/', webSocketDebuggerUrl: 'ws://browser' };
  const backgroundPage = { type: 'background_page', url: 'http://127.0.0.1:47831/' };

  assert.equal(
    selectBenchmarkTarget([queryWorker, main, shareView, pathWorker, hashWorker, otherOrigin, browserTarget, backgroundPage]),
    main,
  );
  assert.equal(isBackgroundWorkerTarget(queryWorker), true);
  assert.equal(isBackgroundWorkerTarget(pathWorker), true);
  assert.equal(isBackgroundWorkerTarget(hashWorker), true);
  assert.equal(isBackgroundWorkerTarget(shareView), true);
  assert.equal(isBackgroundWorkerTarget(main), false);

  assert.throws(() => selectBenchmarkTarget([queryWorker, shareView, otherOrigin, browserTarget, backgroundPage]), /No suitable benchmark target/);
  assert.throws(() => selectBenchmarkTarget([]), /No suitable benchmark target/);
  assert.throws(() => selectBenchmarkTarget(undefined), /No suitable benchmark target/);
  // Two candidate main pages are ambiguous and must be rejected, not guessed.
  assert.throws(() => selectBenchmarkTarget([main, { ...main }]), /No suitable benchmark target/);
});

void test('diagnostics are allowlisted and arbitrary secret/body fields are dropped', () => {
  const diagnostic = sanitizeDiagnostic(
    {
      layer: 'document',
      action: 'request-timing',
      identity: '文档综合 doc-0123456789abcdef/round-1/batch-2',
      inputBytes: 120,
      outputBytes: 34,
      detail: 'SECRET detail sk-live-key prompt text',
      affected: [{ sources: [{ fileName: 'secret.pdf' }], bytes: 1, preview: 'SECRET preview' }],
      errors: [{ message: 'SECRET error' }],
      apiKey: 'sk-live-key',
      baseUrl: 'https://secret.example/v1',
      body: { prompt: 'SECRET prompt' },
      arbitrary: { nested: 'SECRET nested' },
      timing: {
        headersMs: 11,
        firstContentMs: 22,
        totalMs: 33,
        outputChars: 44,
        status: 'success',
        queueMs: 1,
        startupMs: 2,
        executionMs: 3,
        retries: 4,
        detail: 'SECRET timing detail',
        affected: ['SECRET'],
        errors: ['SECRET'],
        body: 'SECRET body',
        arbitrary: 'SECRET arbitrary',
      },
    },
    999,
  );

  assert.deepEqual(diagnostic, {
    atMs: 999,
    layer: 'document',
    action: 'request-timing',
    identity: '文档综合 doc-0123456789abcdef/round-1/batch-2',
    inputBytes: 120,
    outputBytes: 34,
    timing: {
      headersMs: 11,
      firstContentMs: 22,
      totalMs: 33,
      outputChars: 44,
      queueMs: 1,
      startupMs: 2,
      executionMs: 3,
      retries: 4,
      status: 'success',
    },
  });
  const serialized = JSON.stringify(diagnostic);
  for (const leaked of ['SECRET', 'sk-live-key', 'secret.example', 'detail', 'affected', 'errors', 'apiKey', 'baseUrl', 'body', 'arbitrary']) {
    assert.equal(serialized.includes(leaked), false, `leaked ${leaked}`);
  }
});

void test('invalid or injected diagnostic values never reach the report', () => {
  const diagnostic = sanitizeDiagnostic(
    {
      layer: 5,
      action: {},
      identity: 'x'.repeat(200),
      inputBytes: Number.NaN,
      timing: { totalMs: 'soon', status: 'weird', extra: 'SECRET' },
    },
    undefined,
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.layer, undefined);
  assert.equal(diagnostic.action, undefined);
  assert.equal(diagnostic.identity, undefined);
  assert.equal(diagnostic.inputBytes, undefined);
  assert.equal(diagnostic.atMs, 0);
  assert.equal(diagnostic.timing, undefined);
  assert.equal(JSON.stringify(diagnostic).includes('SECRET'), false);
  assert.deepEqual(sanitizeDiagnostic({layer:'SECRET',action:'SECRET',identity:'PRIVATE BODY sk-fixture'},0), {atMs:0});
});

void test('usage projection keeps only known numeric token counters', () => {
  const usage = projectUsage({
    prompt_tokens: 11,
    completion_tokens: 22,
    total_tokens: 33,
    prompt_tokens_details: { cached_tokens: 7, secret: 'sk-usage' },
    completion_tokens_details: { reasoning_tokens: 4, secret: 'sk-usage' },
    secret: 'sk-usage',
    body: { prompt: 'SECRET' },
    model: 'should-not-copy',
  });
  assert.deepEqual(usage, {
    prompt_tokens: 11,
    completion_tokens: 22,
    total_tokens: 33,
    cached_tokens: 7,
    reasoning_tokens: 4,
  });
  assert.equal(JSON.stringify(usage).includes('sk-usage'), false);
  assert.equal(projectUsage({ secret: 'sk-usage' }), undefined);
  assert.equal(projectUsage({ prompt_tokens: Number.NaN, total_tokens: 'x' }), undefined);
});

void test('rejection classification retains a fixed category without source prose', () => {
  const result = sanitizeDiagnostic({action:'rejected', detail:'中间归并未满足预算 SECRET section contents sk-private'}, 7);
  assert.equal(result?.failureCategory, 'reduction-budget');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('sk-private'), false);
});

void test('scope metadata is memory/model only and leaks no credentials', () => {
  const metadata = createBenchmarkScopeMetadata({
    model: 'gpt-test',
    generationMode: 'deep',
    backend: 'dsh',
    sourceRevision: 'a1b2c3d4',
  });
  assert.equal(metadata.scope.kind, 'memory-model-benchmark');
  assert.equal(metadata.scope.productionEndToEnd, false);
  assert.equal(metadata.scope.preservesProviderPipeline, true);
  assert.deepEqual(metadata.scope.excludes, [...BENCHMARK_SCOPE.excludes]);
  assert.equal(metadata.model, 'gpt-test');
  assert.equal(metadata.generationMode, 'deep');
  assert.equal(metadata.backend, 'dsh');
  assert.equal(metadata.sourceRevision, 'a1b2c3d4');
  assert.equal(metadata.cacheState.application, 'fresh-per-run-digest-layer-pdf-text-ocr');
  assert.equal(metadata.cacheState.provider, 'uncontrolled');
  assert.equal(metadata.cacheState.osFileCache, 'uncontrolled');
  assert.equal(metadata.cacheState.existingCourseDigest, 'none');
  assert.equal(createBenchmarkScopeMetadata({existingPdf:'previous.pdf'}).cacheState.existingCourseDigest, 'preloaded-read-only');

  const serialized = JSON.stringify(metadata);
  for (const forbidden of ['apiKey', 'baseUrl', 'settings', 'profile', 'sk-', 'authorization']) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }

  assert.equal(isSafeSourceRevision('a1b2c3d4'), true);
  assert.equal(isSafeSourceRevision('not a hex value'), false);
  assert.equal(isSafeSourceRevision('abc'), false);
  assert.equal(Object.hasOwn(createBenchmarkScopeMetadata({ sourceRevision: 'not a hex value' }), 'sourceRevision'), false);
  assert.equal(createBenchmarkScopeMetadata({ generationMode: 'wild', backend: 'other' }).generationMode, 'fast');
  assert.equal(createBenchmarkScopeMetadata({ generationMode: 'wild', backend: 'other' }).backend, 'api');
});

void test('errors are reduced to fixed safe labels, never raw messages', () => {
  const secret = Object.assign(new Error('SECRET sk-live-key prompt body'), { code: 'context_overflow' });
  assert.equal(safeBenchmarkErrorLabel(secret), 'provider_context_overflow');
  assert.equal(safeBenchmarkErrorLabel(Object.assign(new Error('SECRET'), { code: 'incomplete_artifacts' })), 'incomplete_artifacts');
  assert.equal(safeBenchmarkErrorLabel(Object.assign(new Error('SECRET'), { code: 'not-a-real-code' })), 'benchmark_failed');
  assert.equal(safeBenchmarkErrorLabel(new Error('SECRET')), 'benchmark_failed');
  assert.equal(safeBenchmarkErrorLabel(undefined), 'benchmark_failed');
  assert.equal(safeBenchmarkErrorLabel(secret).includes('SECRET'), false);
  assert.equal(safeBenchmarkErrorLabel({code:'timeout',message:'SECRET'}),'provider_timeout');
  assert.equal(safeBenchmarkErrorLabel({code:'queue_timeout',message:'SECRET'}),'provider_queue_timeout');
});

void test('progress summary exposes model/backend and safe timing counts only', () => {
  const summary = summarizeProgress(
    {
      stage: 'document',
      model: 'gpt-test',
      backend: 'dsh',
      requests: [
        { status: 'success', totalMs: 120, prompt: 'SECRET' },
        { status: 'failure', totalMs: 30 },
        { status: 'pending' },
      ],
    },
    4567,
  );
  assert.equal(summary.stage, 'document');
  assert.equal(summary.model, 'gpt-test');
  assert.equal(summary.backend, 'dsh');
  assert.equal(summary.elapsedMs, 4567);
  assert.deepEqual(summary.requests, { requested: 3, measured: 2, success: 1, failure: 1, cancelled: 0, pending: 1 });
  assert.deepEqual(summary.timings, { maxTotalMs: 120, sumTotalMs: 150 });
  assert.equal(JSON.stringify(summary).includes('SECRET'), false);
});

void test('DSH progress uses provider diagnostics when fetch is never called', () => {
  const summary = summarizeProgress({ backend: 'dsh', requests: [], diagnostics: [
    {action: 'request'}, {action: 'request'}, {action: 'request'},
    {action: 'request-timing', timing: {status: 'success', totalMs: 42, outputChars: 80}},
    {action: 'request-timing', timing: {status: 'failure', totalMs: 12, body: 'SECRET'}},
  ]}, 99);
  assert.deepEqual(summary.requests, {requested:3, measured:2, success:1, failure:1, cancelled:0, pending:1});
  assert.deepEqual(summary.timings, {maxTotalMs:42, sumTotalMs:54});
  assert.equal(JSON.stringify(summary).includes('SECRET'), false);
  assert.deepEqual(sanitizeDiagnostic({action:'request-timing', timing:{headersMs:null, firstContentMs:null}}, 0)?.timing, {headersMs:null,firstContentMs:null});
});

void test('CLI keeps positionals and supports the frozen-bundle/source-revision seam', () => {
  const parsed = parseBenchmarkCliArgs(['--bundle', '/frozen/iife.js', '--source-revision', 'a1b2c3d4', 'course-dir', 'file.pdf', 'report.json']);
  assert.deepEqual(parsed, {
    course: 'course-dir',
    fileName: 'file.pdf',
    reportPath: 'report.json',
    bundlePath: '/frozen/iife.js',
    sourceRevision: 'a1b2c3d4',
  });

  const buildMode = parseBenchmarkCliArgs(['course-dir', 'file.pdf']);
  assert.deepEqual(buildMode, { course: 'course-dir', fileName: 'file.pdf' });
  assert.equal(buildMode.bundlePath, undefined);

  const inline = parseBenchmarkCliArgs(['course-dir', 'file.pdf', '--bundle=/frozen.js', '--source-revision=deadbeef']);
  assert.equal(inline.bundlePath, '/frozen.js');
  assert.equal(inline.sourceRevision, 'deadbeef');

  assert.throws(() => parseBenchmarkCliArgs(['--source-revision', 'not a hex value', 'course-dir', 'file.pdf']), /--source-revision/);
  assert.throws(() => parseBenchmarkCliArgs(['--unknown', 'course-dir', 'file.pdf']), /Unknown benchmark option/);
  assert.throws(() => parseBenchmarkCliArgs(['course-dir']), /Usage/);
});

void test('private quality capture requires a separate explicit CLI destination', () => {
  assert.equal(parseBenchmarkCliArgs(['course','file.pdf']).privateQualityPath, undefined);
  const parsed=parseBenchmarkCliArgs(['course','file.pdf','safe-report.json','--private-quality-path','/tmp/private.json']);
  assert.equal(parsed.reportPath, 'safe-report.json');
  assert.equal(parsed.privateQualityPath, '/tmp/private.json');
  assert.throws(() => parseBenchmarkCliArgs(['course','file.pdf','--private-quality-path=']), /Usage/);
  assert.equal(parseBenchmarkCliArgs(['course','new.pdf','--existing-pdf','previous.pdf']).existingPdf, 'previous.pdf');
  assert.throws(() => parseBenchmarkCliArgs(['course','new.pdf','--existing-pdf=']), /Usage/);
  assert.equal(parseBenchmarkCliArgs(['course','file.pdf','--transport-label','dsh-notification-idle-fixed']).transportLabel, 'dsh-notification-idle-fixed');
  assert.throws(() => parseBenchmarkCliArgs(['course','file.pdf','--transport-label=PRIVATE BODY']), /transport-label/);
});

void test('frozen bundle is used verbatim without building or network', async () => {
  const reads: string[] = [];
  let buildCalls = 0;
  const frozen = await resolveBenchmarkBundle({
    bundlePath: '/frozen/iife.js',
    readBundle: async (path: string) => {
      reads.push(path);
      return 'window.__yeyuPdfModelBenchmark={};';
    },
    buildBundle: async () => {
      buildCalls += 1;
      return { outputFiles: [{ text: 'built' }] };
    },
  });
  assert.deepEqual(frozen, { source: 'window.__yeyuPdfModelBenchmark={};', built: false });
  assert.deepEqual(reads, ['/frozen/iife.js']);
  assert.equal(buildCalls, 0);

  const built = await resolveBenchmarkBundle({
    buildBundle: async () => ({ outputFiles: [{ text: 'built-source' }] }),
  });
  assert.deepEqual(built, { source: 'built-source', built: true });

  await assert.rejects(
    resolveBenchmarkBundle({ bundlePath: '/empty.js', readBundle: async () => '   ' }),
    /Frozen benchmark bundle is empty/,
  );
});

const runnerPath = fileURLToPath(new URL('../scripts/benchmark-pdf-runner.ts', import.meta.url));
const cliPath = fileURLToPath(new URL('../scripts/benchmark-pdf.mjs', import.meta.url));

void test('runner wires independent memory caches and the isolated text cache seam', async () => {
  const source = await readFile(runnerPath, 'utf8');
  assert.match(source, /createPdfTextCache\(\{\s*store:\s*createMemoryStore\(\)\s*\}\)/);
  assert.match(source, /const textCache = createPdfTextCache/);
  assert.match(source, /extractPdfPages\(file,\{[^}]*textCache/);
  assert.match(source, /createKnowledgeDigestCache\(createMemoryStore\(\)\)/);
  assert.match(source, /createOcrService\(createMemoryStore\(\)\)/);
  assert.match(source, /createKnowledgeProviderForSettings\(settings, measuredFetch, digestCache, layerCache\)/);
  // Exactly one isolated OCR cache per benchmark run.
  assert.equal(source.match(/createOcrService\(/g)?.length, 1);
  // No shared application cache is touched or cleared.
  assert.equal(source.includes('pdfTextCache'), false);
  assert.equal(source.includes('.clear('), false);
  assert.equal(source.includes('createIndexedDBStore'), false);
});

void test('runner uses distinct namespaced globals and reports only safe metadata', async () => {
  const source = await readFile(runnerPath, 'utf8');
  assert.match(source, /window\.__startYeyuPdfModelBenchmark/);
  assert.match(source, /window\.__yeyuPdfModelBenchmark/);
  assert.equal(source.includes('__startPdfBenchmark'), false);
  assert.equal(source.includes('__pdfBenchmark'), false);
  assert.match(source, /createBenchmarkScopeMetadata/);
  assert.match(source, /safeBenchmarkErrorLabel/);
  assert.doesNotMatch(source, /report\.error\s*=.*error\.message/);
  assert.match(source, /input\.capturePrivateQuality/);
  assert.match(source, /privateQuality\.validationError=/);
  assert.match(source, /sanitizeDiagnostic/);
  assert.match(source, /projectUsage/);
});

void test('CLI selects the shared target helper and reports incomplete as failure', async () => {
  const source = await readFile(cliPath, 'utf8');
  assert.match(source, /selectBenchmarkTarget/);
  assert.match(source, /summarizeProgress/);
  assert.match(source, /resolveBenchmarkBundle/);
  assert.match(source, /report\.error \? 1 : report\.complete \? \(report\.targetMet \? 0 : 2\) : 1/);
  assert.equal(source.includes('item.url.startsWith'), false);
  assert.match(source, /createHash\('sha256'\)\.update\(bundle\.source\)/);
  assert.match(source, /report\.executionIdentity = executionIdentity/);
  assert.match(source, /transportLabelVerifiedByCli: false/);
});

void test('runner bundles for the browser with the namespaced globals (esbuild write:false)', async () => {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [runnerPath],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent',
  });
  const text = result.outputFiles[0].text;
  assert.match(text, /__startYeyuPdfModelBenchmark/);
  assert.match(text, /__yeyuPdfModelBenchmark/);
  assert.equal(text.includes('__startPdfBenchmark'), false);
  assert.equal(text.includes('__pdfBenchmark'), false);
});

void test('runner keeps opted-in quality bodies separate from the safe report with mocked AI', async () => {
  const { build } = await import('esbuild');
  const { runInNewContext } = await import('node:vm');
  const stubs: Record<string,string> = {
    'knowledge/ai-knowledge-provider.ts': `export const createKnowledgeDigestCache=x=>x; export const createKnowledgeProviderForSettings=()=>({analyzeDocument:async input=>{if(globalThis.benchmarkScenario==='failure')throw Object.assign(new Error('PRIVATE BODY'),{code:'invalid_output'});if(globalThis.benchmarkScenario==='late-abort')globalThis.abortBenchmark();input.onDiagnostic({layer:'document',action:'request-timing',identity:'doc/final',inputBytes:50,detail:'PRIVATE BODY',timing:{totalMs:5,status:'success',outputChars:10,apiKey:'sk-fixture'}});return {concepts:globalThis.benchmarkScenario==='empty'?[]:[{label:'PRIVATE BODY'}],sections:[{summary:'PRIVATE BODY'}]};},synthesizeCourseKnowledge:async input=>{if(input.digests.length!==2)throw new Error('wrong digest count');return {nodes:[{label:'PRIVATE BODY'}]};}});`,
    'knowledge/document-digest.ts': `export const inspectPdf=async()=>({fingerprint:'abc',pageCount:1});export const extractPdfPages=async(_file,options)=>{if(!options.textCache)throw new Error('missing private text cache');return {fingerprint:'abc',pages:['PRIVATE BODY']};};`,
    'knowledge-settings.ts': `export const loadKnowledgeSettings=()=>({model:'test-model',generationMode:'fast',apiKey:'sk-fixture'});`,
    'reader-cache.ts': `export const createMemoryStore=()=>({});`,
    'pdf-text-cache.ts': `export const createPdfTextCache=options=>options.store;`,
    'course-storage/memory-course-storage.ts': `export class MemoryCourseStorage{digests={};async importDocument(_file,digest){this.digests[digest.documentId]=digest;return {bundle:{manifest:{id:'course',name:'course',revision:1},digests:this.digests}};}async initialize(){return {manifest:{id:'course',name:'course',revision:0}};}async savePdf(){return {document:{id:'doc'},bundle:{manifest:{revision:1}}};}async updateDocumentArtifacts(_id,_revision,digest){return {manifest:{revision:2},digests:{...this.digests,doc:digest}};}async stageCourseReview(){return {manifest:{pendingReview:{id:'review'},documents:[{id:'doc',hasSummary:true,hasMindmap:true,includedInCourse:false}]}};}}`,
    'ocr.ts': `export const createOcrProviderForSettings=()=>({});export const createOcrService=x=>x;export const resolvePageOcr=async()=>{throw new Error('unexpected OCR')};`,
    'chat-cache.ts': `export const loadChatSettings=()=>({});`,
    'knowledge/single-document-course.ts': `export const courseKnowledgeFromSingleDigest=digests=>digests.length===1?({nodes:[{label:'PRIVATE BODY'}]}):undefined;`,
    'agent-settings.ts': `export const readSelectedAgentBackend=()=> 'dsh';`,
  };
  const result=await build({entryPoints:[runnerPath],bundle:true,platform:'browser',format:'iife',write:false,logLevel:'silent',plugins:[{
    name:'mock-benchmark-library',setup(builder){
      builder.onResolve({filter:/^\.\.\/lib\//},args=>({path:args.path.slice('../lib/'.length),namespace:'benchmark-mock'}));
      builder.onLoad({filter:/.*/,namespace:'benchmark-mock'},args=>({contents:stubs[args.path]??'throw new Error("unexpected import")',loader:'js'}));
    },
  }]});
  type MockWindow = {yeyuDesktop:{readFile:(course:string,path:string[])=>Promise<Uint8Array>};__startYeyuPdfModelBenchmark?:(input:Record<string,unknown>)=>void;__yeyuPdfModelBenchmark?:{done:boolean;complete:boolean;targetMet:boolean;error?:string;backend:string;courseDocumentCount:number;result?:{candidateStaged:boolean}};__yeyuPdfModelBenchmarkPrivate?:{pages?:string[];digest?:unknown}};
  for(const scenario of [{enabled:false,mode:'success'},{enabled:true,mode:'success'},{enabled:false,mode:'failure'},{enabled:false,mode:'empty'},{enabled:false,mode:'late-abort'}]){
    const {enabled,mode}=scenario;
    const window:MockWindow={yeyuDesktop:{readFile:async(_course,path)=>{
      if(path[0]==='course.json')return new TextEncoder().encode(JSON.stringify({documents:[{id:'previous',fileName:'previous.pdf',storedFileName:'previous.pdf'}]}));
      if(path[0]==='Documents')return new TextEncoder().encode(JSON.stringify({documentId:'previous',fingerprint:'abc',sections:[{summary:'PRIVATE EXISTING'}]}));
      return new Uint8Array([1,2]);
    }}};
    let abortBenchmark:(()=>void)|undefined;
    runInNewContext(result.outputFiles[0].text,{window,performance,setTimeout:(callback:()=>void,ms:number)=>{if(ms===720_000)abortBenchmark=callback;return setTimeout(callback,ms);},clearTimeout,File,Uint8Array,structuredClone,TextDecoder,TransformStream,Response,AbortController,benchmarkScenario:mode,abortBenchmark:()=>abortBenchmark?.()});
    window.__startYeyuPdfModelBenchmark!({course:'course',fileName:'fixture.pdf',capturePrivateQuality:enabled,...(enabled?{existingPdf:'previous.pdf'}:{})});
    for(let attempt=0;!window.__yeyuPdfModelBenchmark?.done&&attempt<50;attempt++)await new Promise(resolve=>setTimeout(resolve,1));
    assert.equal(window.__yeyuPdfModelBenchmark?.done,true);
    assert.equal(window.__yeyuPdfModelBenchmark?.complete,mode==='success');
    assert.equal(window.__yeyuPdfModelBenchmark?.targetMet,mode==='success');
    assert.equal(window.__yeyuPdfModelBenchmark?.backend,'dsh');
    if(mode==='success'){
      assert.equal(window.__yeyuPdfModelBenchmark?.result?.candidateStaged,true);
      assert.equal(window.__yeyuPdfModelBenchmark?.courseDocumentCount,enabled?2:1);
    }else assert.equal(window.__yeyuPdfModelBenchmark?.error,mode==='failure'?'provider_invalid_output':mode==='empty'?'incomplete_artifacts':'deadline_exceeded');
    assert.equal(JSON.stringify(window.__yeyuPdfModelBenchmark).includes('PRIVATE BODY'),false);
    assert.equal(JSON.stringify(window.__yeyuPdfModelBenchmark).includes('sk-fixture'),false);
    if(enabled){assert.equal(window.__yeyuPdfModelBenchmarkPrivate?.pages?.[0],'PRIVATE BODY');assert.ok(window.__yeyuPdfModelBenchmarkPrivate?.digest);}
    else assert.equal(window.__yeyuPdfModelBenchmarkPrivate,undefined);
  }
});
