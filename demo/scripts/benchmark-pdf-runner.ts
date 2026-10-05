// Opt-in in-memory model benchmark for the knowledge pipeline. Credentials
// remain inside the running desktop renderer; every cache is a private
// in-memory store and no PDF text, prompt, completion, or token value is
// reported. This is a memory/model benchmark, not a production end-to-end
// import: external upload network, durable filesystem artifacts, actual
// background scheduling, and candidate review publication are out of scope.
// node scripts/benchmark-pdf.mjs <course-directory> <pdf-name> [report-path]
//   [--bundle <frozen-iife>] [--source-revision <hex>]
// Exit codes: 0 = complete within target, 1 = failed/incomplete, 2 = complete but over target.
import { createKnowledgeProviderForSettings, createKnowledgeDigestCache } from '../lib/knowledge/ai-knowledge-provider.ts';
import { extractPdfPages, inspectPdf } from '../lib/knowledge/document-digest.ts';
import { loadKnowledgeSettings } from '../lib/knowledge-settings.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import { createPdfTextCache } from '../lib/pdf-text-cache.ts';
import { MemoryCourseStorage } from '../lib/course-storage/memory-course-storage.ts';
import { createOcrProviderForSettings, createOcrService, resolvePageOcr } from '../lib/ocr.ts';
import { loadChatSettings } from '../lib/chat-cache.ts';
import { courseKnowledgeFromSingleDigest } from '../lib/knowledge/single-document-course.ts';
import { readSelectedAgentBackend } from '../lib/agent-settings.ts';
import type { AiCourseKnowledge, CourseManifest, DocumentDigest } from '../lib/course-storage/types.ts';
import type { SynthesisDiagnostic } from '../lib/knowledge/hierarchical-synthesis.ts';
import {
  BENCHMARK_ABORT_MS,
  BENCHMARK_MAX_TARGET_MS,
  createBenchmarkScopeMetadata,
  projectUsage,
  safeBenchmarkErrorLabel,
  sanitizeDiagnostic,
} from './benchmark-pdf-report.mjs';

type SafeDiagnostic = NonNullable<ReturnType<typeof sanitizeDiagnostic>>;
interface RequestProbe {
  startMs: number;
  model?: string;
  thinking: string;
  maxTokens?: number;
  inputChars: number;
  outputChars: number;
  reasoningChars: number;
  status: 'pending' | 'success' | 'failure';
  headersMs?: number;
  httpStatus?: number;
  firstContentMs?: number;
  usage?: ReturnType<typeof projectUsage>;
  finishReason?: string;
  lastDataMs?: number;
  totalMs?: number;
}
interface BenchmarkReport extends ReturnType<typeof createBenchmarkScopeMetadata> {
  note: string;
  fileName: string;
  startedAt: string;
  done: boolean;
  complete: boolean;
  stage: string;
  stages: Array<{name: string; atMs: number}>;
  requests: RequestProbe[];
  requestTimings: NonNullable<SafeDiagnostic['timing']>[];
  timingSource: string;
  diagnostics: SafeDiagnostic[];
  fileBytes?: number;
  ocrPages?: number;
  pageCount?: number;
  textChars?: number;
  singleDocumentReused?: boolean;
  courseDocumentCount?: number;
  result?: {
    hasSummary: boolean;
    hasMindmap: boolean;
    includedInCourse: boolean;
    knowledgeState: 'candidate' | 'merged' | 'none';
    candidateStaged: boolean;
    merged: boolean;
    concepts: number;
    sections: number;
    knowledgeNodes: number;
  };
  error?: string;
  totalMs?: number;
  targetMs?: number;
  targetMet?: boolean;
}
interface PrivateQualityCapture {
  diagnostics: SynthesisDiagnostic[];
  pages?: string[];
  digest?: DocumentDigest;
  knowledge?: AiCourseKnowledge;
  validationError?: {name: string; message: string};
}

declare global {
  interface Window {
    __startYeyuPdfModelBenchmark: (input: {
      course: string;
      fileName: string;
      sourceRevision?: string;
      capturePrivateQuality?: boolean;
      existingPdf?: string;
    }) => void;
    __yeyuPdfModelBenchmark: BenchmarkReport;
    __yeyuPdfModelBenchmarkPrivate?: PrivateQualityCapture;
  }
}

function benchmarkFailure(code: string): Error {
  // Error messages are never reported: only the fixed safe label mapped from
  // this code reaches the report.
  return Object.assign(new Error('Benchmark step failed (details suppressed).'), { code });
}

window.__startYeyuPdfModelBenchmark = input => {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  // Loaded settings/model/backend are read once and never replaced or injected.
  const settings = loadKnowledgeSettings();
  const backend = readSelectedAgentBackend();
  // Explicit opt-in only. Never merge this object into the metadata report.
  const privateQuality: PrivateQualityCapture | undefined = input.capturePrivateQuality
    ? {diagnostics: []} : undefined;
  window.__yeyuPdfModelBenchmarkPrivate = privateQuality;
  const report: BenchmarkReport = window.__yeyuPdfModelBenchmark = {
    ...createBenchmarkScopeMetadata({
      model: settings.model,
      generationMode: settings.generationMode,
      backend,
      sourceRevision: input.sourceRevision,
      existingPdf: input.existingPdf,
    }),
    note: 'In-memory model benchmark only; not production end-to-end.',
    fileName: input.fileName,
    startedAt: new Date().toISOString(),
    done: false,
    complete: false,
    stage: 'read',
    stages: [],
    requests: [],
    requestTimings: [],
    timingSource: 'diagnostic.request-timing',
    diagnostics: [],
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BENCHMARK_ABORT_MS);
  // Measured fetch probe for the API backend. DSH requests never reach this
  // fetch; diagnostic.request-timing is authoritative for backend-inclusive
  // timings. Usage is projected onto known numeric counters only.
  const measuredFetch: typeof fetch = async (url, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      model?: string; thinking?: {type?: string}; max_tokens?: number; messages?: unknown;
    };
    const request: RequestProbe = {startMs:elapsed(), model:body.model, thinking:body.thinking?.type ?? 'default', maxTokens:body.max_tokens, inputChars:JSON.stringify(body.messages ?? []).length, outputChars:0, reasoningChars:0, status:'pending'};
    report.requests.push(request);
    let response: Response;
    try { response = await fetch(url, init); }
    catch (error) { request.status='failure'; request.totalMs=elapsed()-request.startMs; throw error; }
    request.headersMs = elapsed() - request.startMs;
    request.httpStatus = response.status;
    if (!response.ok) request.status = 'failure';
    if (!response.body) return response;
    const decoder = new TextDecoder();
    let buffer = '';
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, streamController) {
        buffer += decoder.decode(chunk, {stream:true});
        const lines = buffer.split('\n'); buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const data = JSON.parse(line.slice(5));
            const delta = data.choices?.[0]?.delta;
            if (delta?.content) { request.firstContentMs ??= elapsed() - request.startMs; request.outputChars += delta.content.length; }
            if (delta?.reasoning_content) request.reasoningChars += delta.reasoning_content.length;
            const usage = projectUsage(data.usage);
            if (usage) request.usage = usage;
            if (['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(data.choices?.[0]?.finish_reason)) request.finishReason = data.choices[0].finish_reason;
          } catch { /* SSE heartbeat or DONE */ }
        }
        request.lastDataMs = elapsed() - request.startMs;
        streamController.enqueue(chunk);
      },
      flush() { request.totalMs = elapsed() - request.startMs; request.status=response.ok?'success':'failure'; },
    }));
    return new Response(stream, {status:response.status,headers:response.headers});
  };
  const stage = (name:string) => { report.stage=name; report.stages.push({name, atMs:elapsed()}); };
  const diagnostic = (value:SynthesisDiagnostic) => {
    privateQuality?.diagnostics.push(structuredClone(value));
    const safe = sanitizeDiagnostic(value, elapsed());
    if (!safe) return;
    report.diagnostics.push(safe);
    if (safe.action === 'request-timing' && safe.timing) report.requestTimings.push(safe.timing);
  };
  void (async () => {
    try {
      const data = await window.yeyuDesktop!.readFile(input.course, ['PDFs',input.fileName]);
      const file = new File([Uint8Array.from(data).buffer], input.fileName, {type:'application/pdf'});
      report.fileBytes=file.size;
      // Independent per-run caches. The shared application digest, layer, text,
      // and OCR caches are never read from or cleared here.
      const digestCache = createKnowledgeDigestCache(createMemoryStore());
      const layerCache = createMemoryStore();
      const textCache = createPdfTextCache({store:createMemoryStore()});
      const ocrCache = createOcrService(createMemoryStore());
      const ocrProvider = createOcrProviderForSettings(loadChatSettings(), measuredFetch);
      const provider=createKnowledgeProviderForSettings(settings, measuredFetch, digestCache, layerCache);
      const storage=new MemoryCourseStorage();
      let initial=await storage.initialize('隔离性能测试');
      if (input.existingPdf) {
        stage('seed-existing-document');
        const manifest=JSON.parse(new TextDecoder().decode(await window.yeyuDesktop!.readFile(input.course,['course.json']))) as CourseManifest;
        const existing=manifest.documents.find(document=>document.fileName===input.existingPdf);
        if(!existing||existing.fileName===input.fileName)throw benchmarkFailure('invalid_input');
        const existingDigest=JSON.parse(new TextDecoder().decode(await window.yeyuDesktop!.readFile(input.course,['Documents',existing.id,'document.json']))) as DocumentDigest;
        const existingBytes=await window.yeyuDesktop!.readFile(input.course,['PDFs',existing.storedFileName]);
        const existingFile=new File([Uint8Array.from(existingBytes).buffer],existing.fileName,{type:'application/pdf'});
        const existingMetadata=await inspectPdf(existingFile,controller.signal);
        if(existingDigest.documentId!==existing.id||existingDigest.fingerprint!==existingMetadata.fingerprint)throw benchmarkFailure('invalid_input');
        initial=(await storage.importDocument(existingFile,existingDigest,{generateSummary:true,generateMindmap:true,mergeIntoCourse:true,includeConversationInsights:true},initial.manifest.revision)).bundle;
      }
      const metadata=await inspectPdf(file, controller.signal);
      const saved=await storage.savePdf(file,metadata,{generateSummary:true,generateMindmap:true,mergeIntoCourse:true,includeConversationInsights:true},initial.manifest.revision);
      stage('extract');
      report.ocrPages=0;
      const extracted=await extractPdfPages(file,{signal:controller.signal, textCache, recognizePage:async request => {
        report.ocrPages=(report.ocrPages ?? 0)+1;
        return (await resolvePageOcr({provider:ocrProvider,cache:ocrCache,request,signal:controller.signal})).result.text;
      }});
      report.pageCount=extracted.pages.length; report.textChars=extracted.pages.join('').length;
      if (privateQuality) privateQuality.pages=extracted.pages;
      stage('document');
      const digest=await provider.analyzeDocument({fingerprint:extracted.fingerprint,documentId:saved.document.id,fileName:input.fileName,pages:extracted.pages,signal:controller.signal,onDiagnostic:diagnostic});
      if (privateQuality) privateQuality.digest=digest;
      const ready=await storage.updateDocumentArtifacts(saved.document.id,saved.bundle.manifest.revision,digest);
      stage('course');
      const digests=Object.values(ready.digests);
      report.courseDocumentCount=digests.length;
      const reused=courseKnowledgeFromSingleDigest(digests,[]);
      report.singleDocumentReused=Boolean(reused);
      const knowledge=reused ?? await provider.synthesizeCourseKnowledge({courseId:initial.manifest.id,courseName:initial.manifest.name,digests,signal:controller.signal,onDiagnostic:diagnostic});
      if (controller.signal.aborted) throw benchmarkFailure('aborted');
      if (privateQuality) privateQuality.knowledge=knowledge;
      // Stage the baseline as a candidate to align with the production review
      // state without publishing it. Stores that cannot stage fall back to the
      // existing merge result.
      let bundle=ready;
      let artifactState:'candidate'|'merged'|'none'='none';
      if (typeof storage.stageCourseReview === 'function') {
        bundle=await storage.stageCourseReview([saved.document.id],ready.manifest.revision,knowledge);
        artifactState=bundle.manifest.pendingReview?'candidate':'none';
      } else {
        bundle=await storage.mergeDocuments([saved.document.id],ready.manifest.revision,knowledge);
        artifactState=bundle.manifest.documents.find(item=>item.id===saved.document.id)?.includedInCourse?'merged':'none';
      }
      const document=bundle.manifest.documents.find(item=>item.id===saved.document.id);
      report.result={
        hasSummary:document?.hasSummary===true,
        hasMindmap:document?.hasMindmap===true,
        includedInCourse:document?.includedInCourse===true,
        knowledgeState:artifactState,
        candidateStaged:artifactState==='candidate',
        merged:artifactState==='merged',
        concepts:digest.concepts.length,
        sections:digest.sections.length,
        knowledgeNodes:Array.isArray(knowledge.nodes)?knowledge.nodes.length:0,
      };
      const artifactsValidated=report.result.hasSummary&&report.result.hasMindmap&&report.result.concepts>0&&report.result.sections>0;
      const knowledgeValidated=(report.result.candidateStaged||report.result.merged)&&report.result.knowledgeNodes>0;
      if (!artifactsValidated||!knowledgeValidated) throw benchmarkFailure('incomplete_artifacts');
      if (controller.signal.aborted) throw benchmarkFailure('aborted');
      stage('completed');
    } catch(error) {
      if (privateQuality && error instanceof Error) privateQuality.validationError={name:error.name,message:error.message};
      report.error = controller.signal.aborted ? 'deadline_exceeded' : safeBenchmarkErrorLabel(error);
    } finally {
      clearTimeout(timeout);
      for (const request of report.requests) if (request.status==='pending') request.status='failure';
      report.totalMs=elapsed();
      report.targetMs=BENCHMARK_MAX_TARGET_MS;
      report.complete=!report.error&&report.stage==='completed';
      report.targetMet=report.complete&&report.totalMs<=report.targetMs;
      report.done=true;
    }
  })();
};
