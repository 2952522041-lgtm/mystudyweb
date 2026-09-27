import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createKnowledgeProviderForSettings,
  createKnowledgeDigestCache,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';

function userPrompt(request: Record<string, unknown>): string {
  const messages = request.messages;
  assert.ok(Array.isArray(messages));
  const message = messages.find(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      (candidate as { role?: unknown }).role === 'user',
  ) as { content?: unknown } | undefined;
  if (typeof message?.content !== 'string')
    throw new Error('request is missing its user prompt');
  return message.content;
}

function assertSingleRelationLabelInstruction(prompt: string): void {
  assert.doesNotMatch(
    prompt,
    /"label":"(?:包含|依赖|导致|对比|组成|应用|冲突|关联)\|/,
    'relation schema must not show a pipe-joined label example',
  );
  assert.match(prompt, /relations 中每个 label 必须且只能是以下一个完整值/);
  assert.match(prompt, /禁止使用竖线或斜线拼接多个值/);
}

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
      assertSingleRelationLabelInstruction(userPrompt(request));
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
  const requests: Array<{thinking?:unknown;intermediate:boolean;prompt:string}> = [];
  const provider=createKnowledgeProviderForSettings({baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4.6v',apiKey:'test-key'},async(_url,init)=>{
    const body=JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const prompt=body.messages[1].content as string;
    const records=JSON.parse(prompt.split('\n')[2]);
    const mappingLine=prompt.split('\n').find((line:string)=>line.startsWith('文档身份映射'));
    const mapping=Object.fromEntries(((mappingLine ? JSON.parse(mappingLine.slice(mappingLine.indexOf('：')+1)) : []) as Array<{documentId:string;fileName:string}>).map((item)=>[item.documentId,item.fileName]));
    const sources=synthesisSources(records,undefined,mapping);
    const payload=reply('lecture',sources[0].pageStart);
    payload.concepts[0].sources=sources.map(source=>({...source,pageEnd:source.pageEnd??source.pageStart,type:'pdf' as const}));
    requests.push({thinking:body.thinking,intermediate:prompt.includes('这是分层中间归并'),prompt});
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(payload)},finish_reason:'stop'}]})}\n\n`);
  },createKnowledgeDigestCache(createMemoryStore()),createMemoryStore());
  await provider.synthesizeCourseKnowledge({courseId:'course',courseName:'Lecture',digests:[legacyLongDigest('lecture')]});
  assert.ok(requests.some(request=>request.intermediate));
  assert.ok(requests.some(request=>!request.intermediate));
  const finalPrompt = requests.find(request=>!request.intermediate);
  assert.ok(finalPrompt);
  assertSingleRelationLabelInstruction(finalPrompt.prompt);
  for(const request of requests)assert.deepEqual(request.thinking,request.intermediate?{type:'disabled'}:undefined);
});

void test('invalid relation labels retain their value and valid endpoints in the rejection', async () => {
  const source = {
    documentId: 'doc-b',
    fileName: 'bad-label.pdf',
    pageStart: 1,
    pageEnd: 1,
    type: 'pdf',
  };
  const chunkPayload = {
    hierarchy: { mode: 'flat', reason: 'single-page fixture' },
    sections: [{ title: 'Section', summary: 'Summary', pageStart: 1, pageEnd: 1 }],
    concepts: [
      { id: 'c1', parentId: null, label: 'A', description: 'A concept', sources: [source] },
      { id: 'c2', parentId: null, label: 'B', description: 'B concept', sources: [source] },
    ],
    relations: [],
    unresolvedQuestions: [],
  };
  const badDocumentPayload = {
    ...chunkPayload,
    title: 'Bad label fixture',
    overview: 'A document with a deliberately invalid relation label.',
    relations: [{ from: 'c1', to: 'c2', label: '含混|关联' }],
    sourcePages: [1],
  };
  let calls = 0;
  const provider = createKnowledgeProviderForSettings(
    { baseUrl: 'https://proxy.example/v1', model: 'glm-4.6v', apiKey: 'test-key' },
    async (_url, init) => {
      calls += 1;
      const body = calls === 1 ? chunkPayload : badDocumentPayload;
      const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      assert.equal(typeof request.messages?.[1]?.content, 'string');
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(body) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
    createKnowledgeDigestCache(createMemoryStore()),
    createMemoryStore(),
  );

  await assert.rejects(
    provider.analyzeDocument({
      documentId: 'doc-b',
      fingerprint: 'b'.repeat(64),
      fileName: 'bad-label.pdf',
      pages: ['A short page.'],
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /含混\|关联/);
      assert.match(message, /c1 → c2/);
      return true;
    },
  );
  assert.ok(calls >= 3, 'invalid output should be retried, not silently repaired by dropping the relation');
});
