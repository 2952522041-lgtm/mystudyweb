import { createKnowledgeProviderForSettings, createKnowledgeDigestCache } from '../lib/knowledge/ai-knowledge-provider.ts';
import { extractPdfPages, inspectPdf } from '../lib/knowledge/document-digest.ts';
import { loadKnowledgeSettings } from '../lib/knowledge-settings.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import { MemoryCourseStorage } from '../lib/course-storage/memory-course-storage.ts';
import { createOcrProviderForSettings, createOcrService, resolvePageOcr } from '../lib/ocr.ts';
import { loadChatSettings } from '../lib/chat-cache.ts';
import { courseKnowledgeFromSingleDigest } from '../lib/knowledge/single-document-course.ts';

declare global { interface Window { __startPdfBenchmark: (input:{course:string;fileName:string})=>void; __pdfBenchmark: any; } }
window.__startPdfBenchmark = input => {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const report = window.__pdfBenchmark = {fileName:input.fileName, startedAt:new Date().toISOString(), done:false, stage:'read', stages:[], requests:[], diagnostics:[]} as any;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12 * 60_000);
  const measuredFetch: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const request = {startMs:elapsed(), model:body.model, thinking:body.thinking?.type ?? 'default', maxTokens:body.max_tokens, inputChars:JSON.stringify(body.messages).length, outputChars:0, reasoningChars:0} as any;
    report.requests.push(request);
    const response = await fetch(url, init);
    request.headersMs = elapsed() - request.startMs;
    request.status = response.status;
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
            if (data.usage) request.usage = data.usage;
            if (data.choices?.[0]?.finish_reason) request.finishReason = data.choices[0].finish_reason;
          } catch { /* SSE heartbeat or DONE */ }
        }
        request.lastDataMs = elapsed() - request.startMs;
        streamController.enqueue(chunk);
      },
      flush() { request.totalMs = elapsed() - request.startMs; },
    }));
    return new Response(stream, {status:response.status,headers:response.headers});
  };
  const stage = (name:string) => { report.stage=name; report.stages.push({name, atMs:elapsed()}); };
  void (async () => {
    try {
      const data = await window.yeyuDesktop!.readFile(input.course, ['PDFs',input.fileName]);
      const file = new File([Uint8Array.from(data).buffer], input.fileName, {type:'application/pdf'});
      report.fileBytes=file.size;
      const settings=loadKnowledgeSettings();
      report.model=settings.model; report.mode=settings.generationMode;
      const provider=createKnowledgeProviderForSettings(settings, measuredFetch, createKnowledgeDigestCache(createMemoryStore()), createMemoryStore());
      const storage=new MemoryCourseStorage();
      const initial=await storage.initialize('隔离性能测试');
      const metadata=await inspectPdf(file, controller.signal);
      const saved=await storage.savePdf(file,metadata,{generateSummary:true,generateMindmap:true,mergeIntoCourse:true,includeConversationInsights:true},initial.manifest.revision);
      stage('extract');
      report.ocrPages=0;
      const extracted=await extractPdfPages(file,{signal:controller.signal, recognizePage:async request => {
        report.ocrPages++;
        return (await resolvePageOcr({provider:createOcrProviderForSettings(loadChatSettings(),measuredFetch),cache:createOcrService(createMemoryStore()),request,signal:controller.signal})).result.text;
      }});
      report.pageCount=extracted.pages.length; report.textChars=extracted.pages.join('').length;
      stage('document');
      const diagnostic=(d:any)=>report.diagnostics.push({layer:d.layer,action:d.action,identity:d.identity,atMs:elapsed(),inputBytes:d.inputBytes,outputBytes:d.outputBytes});
      const digest=await provider.analyzeDocument({fingerprint:extracted.fingerprint,documentId:saved.document.id,fileName:input.fileName,pages:extracted.pages,signal:controller.signal,onDiagnostic:diagnostic});
      const ready=await storage.updateDocumentArtifacts(saved.document.id,saved.bundle.manifest.revision,digest);
      stage('course');
      const reused=courseKnowledgeFromSingleDigest([digest],[]);
      report.singleDocumentReused=Boolean(reused);
      const knowledge=reused ?? await provider.synthesizeCourseKnowledge({courseId:initial.manifest.id,courseName:initial.manifest.name,digests:[digest],signal:controller.signal,onDiagnostic:diagnostic});
      const final=await storage.mergeDocuments([saved.document.id],ready.manifest.revision,knowledge);
      report.result={hasSummary:final.manifest.documents[0].hasSummary,hasMindmap:final.manifest.documents[0].hasMindmap,includedInCourse:final.manifest.documents[0].includedInCourse,concepts:digest.concepts.length,sections:digest.sections.length};
      if (!report.result.hasSummary || !report.result.hasMindmap || !report.result.includedInCourse || !report.result.concepts || !report.result.sections) throw new Error('Incomplete benchmark artifacts');
      stage('completed');
    } catch(error) { report.error=controller.signal.aborted?'Benchmark deadline exceeded':(error instanceof Error?error.message:'Benchmark failed'); }
    finally { clearTimeout(timeout);report.totalMs=elapsed();report.targetMs=180_000;report.targetMet=!report.error && report.stage==='completed' && report.totalMs<=report.targetMs;report.done=true; }
  })();
};
