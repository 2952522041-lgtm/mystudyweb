import { registerHooks } from 'node:module';
import { stableDocumentId } from '../../lib/course-storage/file-utils.ts';
import { createKnowledgeProviderForSettings } from '../../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../../lib/reader-cache.ts';
import { createKnowledgeDigestCache } from '../../lib/knowledge/ai-knowledge-provider.ts';
import type { DocumentDigest } from '../../lib/course-storage/types.ts';

export const pages = [
  '第一章 电路基础\n1.1 电阻电路\n欧姆定律：电压等于电流乘电阻，U=IR。\n串联电阻：总电阻等于各电阻之和，R=R1+R2。',
  '第二章 动态电路\n2.1 电容储能\n电容定义：电荷等于电容乘电压，Q=CU。\n储能结论：电容储能 W=CU²/2。电容与电阻的储能行为不同。',
];

/** Deterministic PDF.js text-item boundary; real extractPdfPages + normalization run unchanged. No OCR/API/directory. */
export async function extractLecture() {
  const hook = registerHooks({ load(url, context, next) {
    if (!url.endsWith('/lib/pdfjs.ts')) return next(url, context);
    return { format: 'module', shortCircuit: true, source: `
      export async function loadPdfjs() { const pages = ${JSON.stringify(pages)}; return {
        getDocument: () => ({promise: Promise.resolve({numPages: pages.length,
          getPage: async (n) => ({getViewport: () => ({height:800}), cleanup(){},
            getTextContent: async () => ({items: pages[n-1].split('\\n').map((str,i) => ({str,transform:[12,0,0,12,40,760-i*30],width:500,height:12}))})}),
          cleanup: async () => {}})})}; }
    ` };
  }});
  try {
    const { extractPdfPages } = await import('../../lib/knowledge/document-digest.ts');
    const extracted = await extractPdfPages(new File([pages.join('\n')], '电路讲义.pdf'));
    return { ...extracted, documentId: stableDocumentId(extracted.fingerprint) };
  } finally { hook.deregister(); }
}

export function lectureReply(documentId: string, hierarchical: boolean) {
  const labels = ['电路基础', '电阻电路', '欧姆定律 U=IR', '串联电阻 R=R1+R2', '动态电路', '电容储能', '电容定义 Q=CU', '储能 W=CU²/2'];
  return {
    hierarchy: {mode:'structured',reason:'第1–2页有章、小节和定义/公式/结论'},
    title: '电路讲义', overview: '电阻电路与动态电路的定义、公式和储能结论。',
    sections: pages.map((text, i) => ({ title: text.split('\n')[0], summary: text, pageStart: i+1, pageEnd: i+1 })),
    concepts: labels.map((label, i) => ({ id: `c${i+1}`, parentId: hierarchical ? [null,"c1","c2","c2",null,"c5","c6","c6"][i] : null, label, description: label,
      sources: [{documentId, fileName:'电路讲义.pdf', pageStart:i<4?1:2}] })),
    relations: hierarchical ? [[1,2],[2,3],[2,4],[5,6],[6,7],[6,8]].map(([a,b]) => ({from:`c${a}`,to:`c${b}`,label:'包含'})) : [],
    unresolvedQuestions: [],
  };
}

export function mockProvider(replies: unknown[], store = createMemoryStore<DocumentDigest>(), generationMode?: 'fast' | 'deep') {
  const requests: Array<{messages: Array<{role:string;content:string}>}> = [];
  const provider = createKnowledgeProviderForSettings({
    baseUrl:'https://mock.invalid/v1', apiKey:'mock-only', model:'mock-hierarchy', generationMode,
  }, async (_url, init) => {
    requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    const text = JSON.stringify(replies[Math.min(requests.length-1,replies.length-1)]);
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})}\ndata: [DONE]\n`, {headers:{'content-type':'text/event-stream'}});
  }, createKnowledgeDigestCache(store));
  return {provider, requests, store};
}
