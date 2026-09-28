import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createKnowledgeProviderForSettings,
  createKnowledgeDigestCache,
  knowledgeMaxOutputTokens,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore, type KVStore } from '../lib/reader-cache.ts';
import type { DocumentDigest } from '../lib/course-storage/types.ts';
import { synthesisSources } from '../lib/knowledge/hierarchical-synthesis.ts';
import { legacyLongDigest, reply, source } from './fixtures/hierarchical-synthesis.ts';

type GenerationMode = 'fast' | 'deep';

void test('official DeepSeek fast mode disables thinking and reserves enough complete JSON output', async () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    const requests = await captureDocumentRequests({ baseUrl:'https://api.deepseek.com', model });
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.deepEqual(request.thinking, { type:'disabled' });
      assert.deepEqual(request.response_format, { type:'json_object' });
      assert.equal(request.max_tokens, 32768);
    }
  }
});

void test('DeepSeek deep mode keeps final thinking, while proxies and unknown models remain generic', async () => {
  const deep = await captureDocumentRequests({ baseUrl:'https://api.deepseek.com/v1', model:'deepseek-flash', generationMode:'deep' });
  assert.deepEqual(deep[0].thinking, { type:'disabled' });
  assert.equal(deep[1].thinking, undefined);
  for (const options of [
    { baseUrl:'https://proxy.example/v1', model:'deepseek-flash' },
    { baseUrl:'https://api.deepseek.com', model:'future-unknown-model' },
  ]) {
    const requests = await captureDocumentRequests(options);
    for (const request of requests) {
      assert.equal(request.thinking, undefined);
      assert.equal(request.response_format, undefined);
      assert.equal(request.max_tokens, 8192);
    }
  }
  assert.equal(knowledgeMaxOutputTokens('deepseek-flash'), 8192);
});

function streamJson(value: unknown): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function documentPayload() {
  const documentSource = {
    documentId: 'doc-mode',
    fileName: 'mode.pdf',
    pageStart: 1,
    pageEnd: 1,
    type: 'pdf' as const,
  };
  return {
    title: 'Functions',
    overview: 'A function maps arguments to a return value.',
    hierarchy: {
      mode: 'flat',
      reason: 'Single definition with no chapter hierarchy.',
    },
    sections: [{
      title: 'Functions',
      summary: 'A function returns a value.',
      pageStart: 1,
      pageEnd: 1,
    }],
    concepts: [{
      id: 'function',
      parentId: null,
      label: 'Function',
      description: 'Maps arguments to a return value.',
      sources: [documentSource],
    }],
    relations: [],
    unresolvedQuestions: [],
  };
}

function modeSettings(
  baseUrl: string,
  model: string,
  generationMode?: GenerationMode,
): { baseUrl: string; model: string; apiKey: string; generationMode?: GenerationMode } {
  return {
    baseUrl,
    model,
    apiKey: 'test-key',
    ...(generationMode ? { generationMode } : {}),
  };
}

async function captureDocumentRequests(options: {
  baseUrl?: string;
  model?: string;
  generationMode?: GenerationMode;
  fetchResponse?: (call: number) => unknown;
  digestStore?: KVStore<DocumentDigest>;
  layerStore?: KVStore<unknown>;
} = {}) {
  const requests: Record<string, unknown>[] = [];
  let call = 0;
  const payload = documentPayload();
  const provider = createKnowledgeProviderForSettings(
    modeSettings(
      options.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
      options.model ?? 'glm-4.6v',
      options.generationMode,
    ),
    async (_url, init) => {
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      const value = options.fetchResponse?.(call++) ?? payload;
      return streamJson(value);
    },
    createKnowledgeDigestCache(options.digestStore ?? createMemoryStore<DocumentDigest>()),
    options.layerStore ?? createMemoryStore(),
  );
  await provider.analyzeDocument({
    documentId: 'doc-mode',
    fingerprint: 'mode-fingerprint',
    fileName: 'mode.pdf',
    pages: ['A function maps arguments to a return value.'],
  });
  return requests;
}

function promptRecords(prompt: string): unknown[] {
  const line = prompt.split('\n')[2];
  if (!line) return [];
  return JSON.parse(line) as unknown[];
}

function promptSourceMap(prompt: string): Record<string, string> {
  const line = prompt.split('\n').find((value) => value.startsWith('文档身份映射'));
  if (!line) return {};
  const entries = JSON.parse(line.slice(line.indexOf('：') + 1)) as Array<{ documentId: string; fileName: string }>;
  return Object.fromEntries(entries.map((entry) => [entry.documentId, entry.fileName]));
}

async function captureCourseRequests(generationMode?: GenerationMode, layerStore?: KVStore<unknown>) {
  const requests: Record<string, unknown>[] = [];
  const provider = createKnowledgeProviderForSettings(
    modeSettings('https://open.bigmodel.cn/api/paas/v4', 'glm-4.6v', generationMode),
    async (_url, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      requests.push(body);
      const prompt = userPrompt(body);
      const sources = synthesisSources(promptRecords(prompt), undefined, promptSourceMap(prompt));
      const output = reply('lecture', sources[0]?.pageStart ?? 1);
      output.concepts[0]!.sources = (sources.length ? sources : [source('lecture', 1)]).map((item) => ({
        ...item,
        pageEnd: item.pageEnd ?? item.pageStart,
        type: 'pdf' as const,
      }));
      return streamJson(output);
    },
    createKnowledgeDigestCache(createMemoryStore()),
    layerStore ?? createMemoryStore(),
  );
  await provider.synthesizeCourseKnowledge({
    courseId: 'mode-course',
    courseName: 'Mode course',
    digests: [legacyLongDigest('lecture')],
  });
  return requests;
}

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
      { baseUrl, model, apiKey: 'test-key', generationMode: 'deep' },
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
  const provider=createKnowledgeProviderForSettings({baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4.6v',apiKey:'test-key',generationMode:'deep'},async(_url,init)=>{
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

void test('fast, deep, default, and non-GLM reasoning policies cover every synthesis layer', async () => {
  for (const generationMode of [undefined, 'fast'] as const) {
    const requests = await captureDocumentRequests({ generationMode });
    assert.deepEqual(
      requests.map((request) => request.thinking),
      [{ type: 'disabled' }, { type: 'disabled' }],
      `${generationMode ?? 'default'} official GLM fast mode should disable chunk and document thinking`,
    );
    const courseRequests = await captureCourseRequests(generationMode);
    const intermediate = courseRequests.filter((request) => userPrompt(request).includes('当前只是中间压缩'));
    const final = courseRequests.filter((request) => !userPrompt(request).includes('当前只是中间压缩'));
    assert.ok(intermediate.length > 0, 'course fixture should exercise intermediate synthesis');
    assert.ok(final.length > 0, 'course fixture should exercise final synthesis');
    assert.ok(courseRequests.every((request) => request.thinking && (request.thinking as { type?: string }).type === 'disabled'));
  }

  const deepDocument = await captureDocumentRequests({ generationMode: 'deep' });
  assert.deepEqual(deepDocument.map((request) => request.thinking), [{ type: 'disabled' }, undefined]);
  const deepCourse = await captureCourseRequests('deep');
  assert.ok(deepCourse.some((request) => userPrompt(request).includes('当前只是中间压缩')));
  assert.ok(deepCourse.some((request) => !userPrompt(request).includes('当前只是中间压缩')));
  assert.ok(deepCourse.filter((request) => userPrompt(request).includes('当前只是中间压缩')).every((request) =>
    (request.thinking as { type?: string } | undefined)?.type === 'disabled',
  ));
  assert.ok(deepCourse.filter((request) => !userPrompt(request).includes('当前只是中间压缩')).every((request) => request.thinking === undefined));

  const otherProviderSettings: Array<[string, string]> = [
    ['https://proxy.example/v1', 'glm-4.6v'],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-5'],
  ];
  for (const [baseUrl, model] of otherProviderSettings) {
    for (const generationMode of [undefined, 'fast', 'deep'] as const) {
      const requests = await captureDocumentRequests({ baseUrl, model, generationMode });
      assert.ok(requests.every((request) => request.thinking === undefined), `${baseUrl} ${model} must not receive vendor thinking options`);
    }
  }
});

void test('fast structural repair keeps the default reasoning mode', async () => {
  const valid = documentPayload();
  const invalid = {
    ...valid,
    concepts: [
      ...valid.concepts,
      { ...valid.concepts[0], id: 'second', label: 'Second concept' },
    ],
    relations: [{ from: 'function', to: 'second', label: '含混|关联' }],
  };
  const repair = {
    hierarchy: valid.hierarchy,
    assignments: [
      { id: 'function', parentId: null },
      { id: 'second', parentId: null },
    ],
    branches: [],
  };
  const requests = await captureDocumentRequests({
    fetchResponse: (call) => call === 0 ? valid : call === 1 ? invalid : repair,
  });
  assert.equal(requests.length, 3, 'chunk, rejected document draft, and structure-only repair should be requested');
  assert.deepEqual(requests.map((request) => request.thinking), [
    { type: 'disabled' },
    { type: 'disabled' },
    undefined,
  ]);
});

void test('generation mode isolates final caches while sharing chunks and intermediates', async () => {
  const deepDigestStore = createMemoryStore<DocumentDigest>();
  const deepRequests = await captureDocumentRequests({
    generationMode: 'deep',
    digestStore: deepDigestStore,
    layerStore: createMemoryStore<unknown>(),
  });
  assert.equal(deepRequests.length, 2);

  const fastFromDeepDigest = await captureDocumentRequests({
    generationMode: 'fast',
    digestStore: deepDigestStore,
    layerStore: createMemoryStore<unknown>(),
  });
  assert.equal(fastFromDeepDigest.length, 0, 'fast may reuse a validated deep document digest');

  const fastDigestStore = createMemoryStore<DocumentDigest>();
  const fastRequests = await captureDocumentRequests({
    generationMode: 'fast',
    digestStore: fastDigestStore,
    layerStore: createMemoryStore<unknown>(),
  });
  assert.equal(fastRequests.length, 2);
  const deepFromFastDigest = await captureDocumentRequests({
    generationMode: 'deep',
    digestStore: fastDigestStore,
    layerStore: createMemoryStore<unknown>(),
  });
  assert.equal(deepFromFastDigest.length, 2, 'deep must not reuse a fast document digest');

  const deepLayerStore = createMemoryStore<unknown>();
  await captureDocumentRequests({
    generationMode: 'deep',
    digestStore: createMemoryStore<DocumentDigest>(),
    layerStore: deepLayerStore,
  });
  const fastFromDeepLayer = await captureDocumentRequests({
    generationMode: 'fast',
    digestStore: createMemoryStore<DocumentDigest>(),
    layerStore: deepLayerStore,
  });
  assert.equal(fastFromDeepLayer.length, 1, 'fast final layer remains mode-isolated');
  assert.ok(fastFromDeepLayer.every((request) => !userPrompt(request).includes('分析以下 PDF 分块')),
    'fast should still reuse the deep chunk layer');

  const fastLayerStore = createMemoryStore<unknown>();
  await captureDocumentRequests({
    generationMode: 'fast',
    digestStore: createMemoryStore<DocumentDigest>(),
    layerStore: fastLayerStore,
  });
  const deepFromFastLayer = await captureDocumentRequests({
    generationMode: 'deep',
    digestStore: createMemoryStore<DocumentDigest>(),
    layerStore: fastLayerStore,
  });
  assert.equal(deepFromFastLayer.length, 1, 'deep must not reuse a fast final layer');
  assert.ok(deepFromFastLayer.every((request) => !userPrompt(request).includes('分析以下 PDF 分块')),
    'chunk layers remain shared in both directions');

  const deepCourseLayer = createMemoryStore<unknown>();
  const deepCourse = await captureCourseRequests('deep', deepCourseLayer);
  const fastCourseFromDeep = await captureCourseRequests('fast', deepCourseLayer);
  assert.ok(deepCourse.some((request) => userPrompt(request).includes('当前只是中间压缩')));
  assert.equal(
    fastCourseFromDeep.filter((request) => userPrompt(request).includes('当前只是中间压缩')).length,
    0,
    'intermediate layers remain shared',
  );
  assert.equal(fastCourseFromDeep.length, 1, 'fast final course layer remains mode-isolated');
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
