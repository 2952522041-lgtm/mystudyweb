import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createKnowledgeProviderForSettings,
  createKnowledgeDigestCache,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';

for (const [baseUrl, model, disabled] of [
  ['https://open.bigmodel.cn/api/paas/v4', 'glm-4.6v', true],
  ['https://proxy.example/v1', 'glm-4.6v', false],
  ['https://open.bigmodel.cn/api/paas/v4', 'glm-5', false],
] as const) {
  void test(`knowledge extraction reasoning policy: ${baseUrl} ${model}`, async () => {
    const requests: Record<string, unknown>[] = [];
    const source = {
      documentId: 'doc-a',
      fileName: 'notes.pdf',
      pageStart: 1,
      pageEnd: 1,
      type: 'pdf',
    };
    const payload = {
      title: 'Functions',
      overview: 'A function maps arguments to a return value.',
      hierarchy: {
        mode: 'flat',
        reason: 'Single definition with no chapter hierarchy.',
      },
      sections: [
        {
          title: 'Functions',
          summary: 'A function returns a value.',
          pageStart: 1,
          pageEnd: 1,
        },
      ],
      concepts: [
        {
          id: 'function',
          parentId: null,
          label: 'Function',
          description: 'Maps arguments to a return value.',
          sources: [source],
        },
      ],
      relations: [],
      unresolvedQuestions: [],
    };
    const provider = createKnowledgeProviderForSettings(
      { baseUrl, model, apiKey: 'test-key' },
      async (_url, init) => {
        requests.push(
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
        );
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
      createKnowledgeDigestCache(createMemoryStore()),
      createMemoryStore(),
    );
    await provider.analyzeDocument({
      documentId: 'doc-a',
      fingerprint: 'a'.repeat(64),
      fileName: 'notes.pdf',
      pages: ['A function maps arguments to a return value.'],
    });
    assert.equal(requests.length, 2);
    for (const request of requests)
      assert.deepEqual(
        request.response_format,
        new URL(baseUrl).hostname === 'open.bigmodel.cn'
          ? { type: 'json_object' }
          : undefined,
      );
    assert.deepEqual(
      requests[0].thinking,
      disabled ? { type: 'disabled' } : undefined,
    );
    assert.equal(
      requests[1].thinking,
      undefined,
      'document synthesis retains model reasoning defaults',
    );
  });
}

void test('intermediate course compression is direct while final synthesis retains reasoning', async () => {
  const {legacyLongDigest,reply} = await import('./fixtures/hierarchical-synthesis.ts');
  const {synthesisSources} = await import('../lib/knowledge/hierarchical-synthesis.ts');
  const requests: Array<{thinking?:unknown;intermediate:boolean}> = [];
  const provider=createKnowledgeProviderForSettings({baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4.6v',apiKey:'test-key'},async(_url,init)=>{
    const body=JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const prompt=body.messages[1].content as string;
    const records=JSON.parse(prompt.split('\n')[2]);
    const sources=synthesisSources(records);
    const payload=reply('lecture',sources[0].pageStart);
    payload.concepts[0].sources=sources.map(source=>({...source,pageEnd:source.pageEnd??source.pageStart,type:'pdf' as const}));
    requests.push({thinking:body.thinking,intermediate:prompt.includes('这是分层中间归并')});
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(payload)},finish_reason:'stop'}]})}\n\n`);
  },createKnowledgeDigestCache(createMemoryStore()),createMemoryStore());
  await provider.synthesizeCourseKnowledge({courseId:'course',courseName:'Lecture',digests:[legacyLongDigest('lecture')]});
  assert.ok(requests.some(request=>request.intermediate));
  assert.ok(requests.some(request=>!request.intermediate));
  for(const request of requests)assert.deepEqual(request.thinking,request.intermediate?{type:'disabled'}:undefined);
});
