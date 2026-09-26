import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { KnowledgeSettings } from '../lib/knowledge-settings.ts';
import type {
  AiCourseKnowledge,
  BrowserDirectoryHandle,
  BrowserFileHandle,
  CourseManifest,
  DocumentDigest,
  ImportOptions,
  SourceReference,
  WritableFileHandle,
} from '../lib/course-storage/types.ts';
import { stableDocumentId } from '../lib/course-storage/file-utils.ts';
import { BrowserDirectoryStorage } from '../lib/course-storage/browser-directory-storage.ts';
import { MemoryCourseStorage } from '../lib/course-storage/memory-course-storage.ts';
import { DesktopCourseStorage } from '../lib/course-storage/desktop-course-storage.ts';
import type { YeyuDesktopApi } from '../electron/api.ts';
import {
  createCourseDirectory,
  courseFileExists,
  deleteCourseEntry,
  ensureCourseDirectory,
  ensureWorkspace,
  readCourseFile,
  removeCourseDirectory,
  scanCourses,
  writeCourseFile,
} from '../electron/workspace.ts';
import { resolveWorkspaceLayout } from '../electron/workspace-paths.ts';
import {
  KNOWLEDGE_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_MAX_OUTPUT_TOKENS_GLM_4_6V,
  KnowledgeError,
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
  knowledgeDigestCacheKey,
  knowledgeMaxOutputTokens,
  normalizeKnowledgeModel,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { ChatError } from '../lib/ai-errors.ts';
import { buildPdfChunks } from '../lib/knowledge/pdf-chunks.ts';
import {
  applyAiCourseKnowledge,
  emptyCourseKnowledge,
} from '../lib/knowledge/course-merger.ts';
import {
  renderCourseSummary,
  renderDocumentSummary,
  renderKnowledgeSvg,
} from '../lib/knowledge/artifact-renderer.ts';
import {
  buildMindmapLayout,
  MINDMAP_DEFAULT_MAX_NODES,
} from '../lib/knowledge/mindmap-layout.ts';
import { createMemoryStore, type KVStore } from '../lib/reader-cache.ts';

/** 知识库 AI 的独立配置：不再依赖「AI 答疑」设置。 */
const settings: KnowledgeSettings = {
  baseUrl: 'https://kb.example.com/v1',
  apiKey: 'kb-secret-key-123',
  model: 'knowledge-model-x',
};

const FINGERPRINT = 'a'.repeat(64);
const DOCUMENT_ID = stableDocumentId(FINGERPRINT);
const FILE_NAME = '线性代数讲义.pdf';
const PAGES = [
  '1 向量空间\n向量空间由线性无关的基张成，维度是基的个数。',
  '2 线性映射\n线性映射保持加法与数乘结构，用矩阵表示。',
  '3 特征值分解\n特征值分解把矩阵分解为特征向量与特征值。',
];

function sseEvent(text: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: finishReason }],
  })}\n`;
}

interface MockReply {
  text: string;
  finishReason?: string;
  status?: number;
}

function createMockFetch(replies: Array<MockReply | string>) {
  const scripts = replies.map((reply) =>
    typeof reply === 'string' ? { text: reply } : reply,
  );
  const requests: Array<{
    url: string;
    headers: Record<string, unknown>;
    body: Record<string, unknown>;
  }> = [];
  const fetchImpl = (async (
    _url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as Record<string, unknown>;
    const headers = (init?.headers ?? {}) as Record<string, unknown>;
    const reply = scripts[requests.length] ?? scripts.at(-1)!;
    const url =
      typeof _url === 'string'
        ? _url
        : _url instanceof URL
          ? _url.href
          : _url.url;
    requests.push({ url, headers, body });
    if (reply.status && reply.status !== 200) {
      return new Response(
        JSON.stringify({ error: { message: reply.text } }),
        { status: reply.status, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      [sseEvent(reply.text), sseEvent('', reply.finishReason ?? 'stop'), 'data: [DONE]\n'].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;
  return { requests, fetchImpl };
}

function chunkAnalysisReply() {
  return JSON.stringify({
    sections: [
      { title: '向量空间', summary: '介绍基与维度。', pageStart: 1, pageEnd: 2 },
    ],
    concepts: [
      {
        label: '向量空间',
        description: '由线性无关的基张成。',
        sources: [{ pageStart: 1, pageEnd: 1 }],
      },
    ],
    unresolvedQuestions: [],
  });
}

function digestReply(overrides: Record<string, unknown> = {}) {
  const source = (pageStart: number, pageEnd?: number) => ({
    documentId: DOCUMENT_ID,
    fileName: FILE_NAME,
    pageStart,
    ...(pageEnd ? { pageEnd } : {}),
  });
  const payload = {
    title: '线性代数讲义',
    overview:
      '这份讲义系统讲解向量空间、线性映射与特征值分解三大主题，逐步给出定义、定理与几何直觉，并在最后一节用二维例子演示如何求特征向量。全文由浅入深，适合作为线性代数入门材料。',
    sections: [
      { title: '向量空间', summary: '介绍基、维度与线性组合。', pageStart: 1, pageEnd: 2 },
      { title: '特征值分解', summary: '介绍特征值与特征向量的求法。', pageStart: 3, pageEnd: 3 },
    ],
    concepts: [
      {
        id: 'c1',
        label: '向量空间',
        description: '由线性无关的基张成的集合。',
        sources: [source(1, 2)],
      },
      {
        id: 'c2',
        label: '特征值分解',
        description: '把矩阵分解为特征向量与特征值。',
        sources: [source(3)],
      },
    ],
    relations: [{ from: 'c1', to: 'c2', label: '依赖' }],
    unresolvedQuestions: ['奇异矩阵是否一定可对角化？'],
    sourcePages: [1, 2, 3],
    ...overrides,
  };
  return JSON.stringify({...payload, hierarchy:{mode:"flat",reason:"夹具只有少量并列概念，没有章节从属论点"}, concepts: (payload.concepts as Array<Record<string,unknown>>).map(node => ({parentId:null,...node}))});
}

function courseReply() {
  return JSON.stringify({
    hierarchy: {mode:"flat",reason:"夹具仅有两个并列概念"},
    theme: '本课程围绕线性代数的结构与分解展开。',
    concepts: [
      {
        parentId: null,
        id: 'k1',
        label: '向量空间',
        description: '两份讲义共同定义的核心结构。',
        sources: [
          { documentId: 'doc-aaaaaaaaaaaaaaaa', fileName: '讲义1.pdf', pageStart: 1, pageEnd: 2 },
          { documentId: 'doc-bbbbbbbbbbbbbbbb', fileName: '讲义2.pdf', pageStart: 2 },
        ],
      },
      {
        parentId: null,
        id: 'k2',
        label: '特征值分解',
        description: '第二份讲义给出的分解方法。',
        sources: [{ documentId: 'doc-bbbbbbbbbbbbbbbb', fileName: '讲义2.pdf', pageStart: 3 }],
      },
    ],
    relations: [{ from: 'k1', to: 'k2', label: '依赖' }],
    conflicts: [
      {
        nodeId: 'k2',
        descriptions: ['讲义1 认为实对称矩阵才可对角化。', '讲义2 给出了复矩阵的反例。'],
        sources: [
          { documentId: 'doc-aaaaaaaaaaaaaaaa', fileName: '讲义1.pdf', pageStart: 2 },
          { documentId: 'doc-bbbbbbbbbbbbbbbb', fileName: '讲义2.pdf', pageStart: 3 },
        ],
      },
    ],
    unresolvedQuestions: ['如何判断矩阵可对角化？'],
  });
}

function makeAiDigest(overrides: Partial<DocumentDigest> = {}): DocumentDigest {
  const source = (documentId: string, fileName: string, pageStart: number): SourceReference => ({
    documentId,
    fileName,
    pageStart,
    type: 'pdf',
  });
  return {
    schemaVersion: 2,
    documentId: 'doc-aaaaaaaaaaaaaaaa',
    fingerprint: 'aa11'.repeat(16),
    title: '讲义1',
    overview: '第一份讲义的 AI 概述，包含向量空间与线性映射。',
    sections: [
      { id: 's1', title: '向量空间', summary: '基与维度。', pageStart: 1, pageEnd: 2 },
    ],
    concepts: [
      {
        id: 'doc-aaaaaaaaaaaaaaaa-concept-1',
        label: '向量空间',
        description: '由基张成。',
        sources: [source('doc-aaaaaaaaaaaaaaaa', '讲义1.pdf', 1)],
      },
      {
        id: 'doc-aaaaaaaaaaaaaaaa-concept-2',
        label: '特征值分解',
        description: '矩阵分解方法。',
        sources: [source('doc-aaaaaaaaaaaaaaaa', '讲义1.pdf', 2)],
      },
    ],
    relations: [
      {
        from: 'doc-aaaaaaaaaaaaaaaa-concept-1',
        to: 'doc-aaaaaaaaaaaaaaaa-concept-2',
        label: '依赖',
      },
    ],
    unresolvedQuestions: [],
    sourcePages: [1, 2],
    promptVersion: 'ai-digest-v1',
    provider: 'openai-compatible-knowledge',
    model: 'knowledge-model-x',
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

const importOptions: ImportOptions = {
  generateSummary: true,
  generateMindmap: true,
  mergeIntoCourse: true,
  includeConversationInsights: false,
};

function makeProvider(
  replies: Array<MockReply | string>,
  cacheStore?: KVStore<DocumentDigest>,
  settingsOverride: KnowledgeSettings = settings,
) {
  const { requests, fetchImpl } = createMockFetch(replies);
  const store = cacheStore ?? createMemoryStore<DocumentDigest>();
  const provider = createKnowledgeProviderForSettings(
    settingsOverride,
    fetchImpl,
    createKnowledgeDigestCache(store),
  );
  return { requests, provider, store };
}

/** glm-4.6v 的官方 max_tokens 上限是 32768，与其他型号不同。 */
const GLM_4_6V_SETTINGS: KnowledgeSettings = {
  ...settings,
  model: 'glm-4.6v',
};

function makeSecondDigest(): DocumentDigest {
  const base = makeAiDigest();
  return makeAiDigest({
    sections: base.sections.map(section => ({...section, pageEnd:3})),
    concepts: base.concepts.map((concept,index) => ({...concept, sources:[{documentId:'doc-bbbbbbbbbbbbbbbb',fileName:'讲义2.pdf',pageStart:index+2,type:'pdf'}]})),
    documentId: 'doc-bbbbbbbbbbbbbbbb',
    fingerprint: 'bb11'.repeat(16),
    title: '讲义2',
    overview: '第二份讲义的 AI 概述，介绍特征值分解。',
    sourcePages: [1, 2, 3],
  });
}

void test('chunker covers every page in order and tags pages, splitting overlong pages at boundaries', () => {
  const pages = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 页\n${'内容'.repeat(300)}`);
  const chunks = buildPdfChunks(pages);

  const covered = chunks.flatMap((chunk) => chunk.pages);
  assert.deepEqual(covered, Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(chunks[0].pageStart, 1);
  assert.equal(chunks.at(-1)?.pageEnd, 40);
  for (const chunk of chunks) {
    assert.ok(chunk.charCount <= 12000, `chunk too large: ${chunk.charCount}`);
    assert.ok(chunk.charCount >= 500, 'chunk unexpectedly tiny');
    assert.match(chunk.text, /<page number="/);
  }

  const longPage = ['段落一。\n\n段落二。', '段落三。']
    .join('\n\n')
    .repeat(2400);
  const single = buildPdfChunks([longPage]);
  assert.ok(single.length >= 3, 'overlong page should split into multiple chunks');
  assert.deepEqual(
    [...new Set(single.flatMap((chunk) => chunk.pages))],
    [1],
  );
  for (const chunk of single) {
    assert.ok(chunk.text.includes('<page number="1"'));
    assert.ok(chunk.text.length <= 12200);
  }
});

void test('knowledge provider uses its own settings verbatim and never logs the key', async () => {
  const { requests, provider } = makeProvider([chunkAnalysisReply(), digestReply()]);
  const digest = await provider.analyzeDocument({
    fingerprint: FINGERPRINT,
    fileName: FILE_NAME,
    documentId: DOCUMENT_ID,
    pages: PAGES,
  });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, 'https://kb.example.com/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${settings.apiKey}`);
    assert.equal(request.body.model, settings.model);
  }
  assert.equal(provider.model, settings.model);
  assert.equal(digest.model, settings.model);
  assert.equal(digest.provider, 'openai-compatible-knowledge');

  // 系统提示词必须包含不可信数据与只输出 JSON 的约束。
  const system = (requests[0].body.messages as Array<{ role: string; content: string }>)[0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /UNTRUSTED DATA/);
  assert.match(system.content, /Never invent page numbers/);
  assert.match(system.content, /one JSON value/);
});

void test('chunk analysis allows long output and bounds the section count in the prompt', async () => {
  const { requests, provider } = makeProvider([chunkAnalysisReply(), digestReply()]);
  await provider.analyzeDocument({
    fingerprint: FINGERPRINT,
    fileName: FILE_NAME,
    documentId: DOCUMENT_ID,
    pages: PAGES,
  });

  // 分块分析曾是 4096 输出上限，页数多但文字稀疏的分块会被 length 截断。
  assert.equal(requests[0].body.max_tokens, 8192);
  assert.equal(requests[1].body.max_tokens, 8192);
  const chunkPrompt = (requests[0].body.messages as Array<{ content: string }>)[1]
    .content;
  assert.match(chunkPrompt, /sections 最多 8 个/);
  assert.match(chunkPrompt, /每页一节/);
});

void test('glm-4.6v uses its own 32768 output ceiling while every other model keeps 8192', () => {
  assert.equal(KNOWLEDGE_MAX_OUTPUT_TOKENS, 8192);
  assert.equal(KNOWLEDGE_MAX_OUTPUT_TOKENS_GLM_4_6V, 32768);
  assert.equal(knowledgeMaxOutputTokens('glm-4.6v'), 32768);
  // 首尾空格与大小写不应影响识别。
  assert.equal(normalizeKnowledgeModel('  GLM-4.6V\t'), 'glm-4.6v');
  assert.equal(knowledgeMaxOutputTokens(' GLM-4.6V '), 32768);
  // 其他型号（含名字相近的）必须保持原上限，避免误匹配。
  for (const model of [
    'glm-4.6',
    'glm-4.6v-flash',
    'glm-4.6vx',
    'my-glm-4.6v',
    'glm-4.7-flashx',
    'knowledge-model-x',
    '',
  ]) {
    assert.equal(knowledgeMaxOutputTokens(model), 8192, `${model} 不应命中 glm-4.6v 上限`);
  }
});

void test('all three glm-4.6v stages send max_tokens=32768 through the request chain', async () => {
  const { requests, provider } = makeProvider(
    [chunkAnalysisReply(), digestReply(), courseReply()],
    undefined,
    GLM_4_6V_SETTINGS,
  );
  await provider.analyzeDocument({
    fingerprint: FINGERPRINT,
    fileName: FILE_NAME,
    documentId: DOCUMENT_ID,
    pages: PAGES,
  });
  await provider.synthesizeCourseKnowledge({
    courseId: 'course-1',
    courseName: '线性代数',
    digests: [makeAiDigest(), makeSecondDigest()],
  });

  assert.equal(provider.model, 'glm-4.6v');
  // 分块分析、单文档综合、课程综合三个阶段都必须带上提高后的上限。
  assert.deepEqual(
    requests.map((request) => request.body.max_tokens),
    [32768, 32768, 32768],
  );
  for (const request of requests) {
    assert.equal(request.body.model, 'glm-4.6v');
  }

  // 大小写/空格写法同样提高上限，但请求里保留用户填写的模型名。
  const { requests: paddedRequests, provider: paddedProvider } = makeProvider(
    [chunkAnalysisReply(), digestReply()],
    undefined,
    { ...settings, model: ' GLM-4.6V ' },
  );
  assert.equal(paddedProvider.model, 'GLM-4.6V');
  await paddedProvider.analyzeDocument({
    fingerprint: FINGERPRINT,
    fileName: FILE_NAME,
    documentId: DOCUMENT_ID,
    pages: PAGES,
  });
  assert.deepEqual(
    paddedRequests.map((request) => request.body.max_tokens),
    [32768, 32768],
  );
  for (const request of paddedRequests) {
    assert.equal(request.body.model, 'GLM-4.6V');
  }
});

void test('other models still request the original 8192 ceiling end to end', async () => {
  const { requests, provider } = makeProvider(
    [chunkAnalysisReply(), digestReply(), courseReply()],
  );
  await provider.analyzeDocument({
    fingerprint: FINGERPRINT,
    fileName: FILE_NAME,
    documentId: DOCUMENT_ID,
    pages: PAGES,
  });
  await provider.synthesizeCourseKnowledge({
    courseId: 'course-1',
    courseName: '线性代数',
    digests: [makeAiDigest(), makeSecondDigest()],
  });
  assert.deepEqual(
    requests.map((request) => request.body.max_tokens),
    [8192, 8192, 8192],
  );
});

void test('provider rejects unconfigured knowledge settings instead of falling back', async () => {
  const unconfigured: KnowledgeSettings = { ...settings, apiKey: '' };
  const { fetchImpl } = createMockFetch([digestReply()]);
  let fetchCalls = 0;
  const countingFetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  }) as typeof fetch;

  await assert.rejects(
    () =>
      Promise.resolve().then(() =>
        createKnowledgeProviderForSettings(unconfigured, countingFetch),
      ),
    (error: unknown) =>
      error instanceof KnowledgeError &&
      error.code === 'not_configured' &&
      /知识库/.test(error.message),
  );
  assert.equal(fetchCalls, 0);
});

void test('invalid JSON output triggers exactly one corrective retry', async () => {
  const { requests, provider } = makeProvider([
    chunkAnalysisReply(),
    '抱歉，我不能输出 JSON。',
    digestReply(),
  ]);
  const digest = await provider.analyzeDocument({
    fingerprint: FINGERPRINT,
    fileName: FILE_NAME,
    documentId: DOCUMENT_ID,
    pages: PAGES,
  });
  assert.equal(digest.title, '线性代数讲义');
  assert.equal(requests.length, 3);
  const retryMessages = requests[2].body.messages as Array<{
    role: string;
    content: string;
  }>;
  assert.equal(retryMessages.at(-1)?.role, 'user');
  assert.match(retryMessages.at(-1)?.content ?? '', /无法解析为 JSON/);
  assert.match(retryMessages.at(-2)?.content ?? '', /上次输出未通过校验/);
});

void test('finish_reason=length results are rejected and never cached', async () => {
  const { provider, store } = makeProvider([
    { text: chunkAnalysisReply(), finishReason: 'length' },
  ]);
  await assert.rejects(
    provider.analyzeDocument({
      fingerprint: FINGERPRINT,
      fileName: FILE_NAME,
      documentId: DOCUMENT_ID,
      pages: PAGES,
    }),
    (error: unknown) =>
      error instanceof KnowledgeError && error.code === 'truncated',
  );
  assert.equal((await store.keys()).length, 0);
});

void test('a truncated synthesis stage is rejected and leaves the previous cached digest intact', async () => {
  const store = createMemoryStore<DocumentDigest>();
  const input = {
    fingerprint: FINGERPRINT,
    fileName: FILE_NAME,
    documentId: DOCUMENT_ID,
    pages: PAGES,
  };
  const { requests, provider } = makeProvider(
    [chunkAnalysisReply(), digestReply()],
    store,
  );
  const first = await provider.analyzeDocument(input);
  assert.equal((await store.keys()).length, 1);

  // 用户点“重新生成”：分块分析成功，但单文档综合被输出上限截断。
  const { provider: truncating } = makeProvider(
    [
      { text: chunkAnalysisReply() },
      { text: digestReply(), finishReason: 'length' },
    ],
    store,
  );
  await assert.rejects(
    truncating.analyzeDocument({ ...input, bypassCache: true }),
    (error: unknown) =>
      error instanceof KnowledgeError && error.code === 'truncated',
  );

  // 旧成果必须原样保留，而且仍然命中缓存（不再发起新请求）。
  const cached = await provider.analyzeDocument(input);
  assert.deepEqual(cached, first);
  assert.equal(requests.length, 2);
  assert.equal((await store.keys()).length, 1);
});

void test('truncation blames the output ceiling instead of the input context and names the limit used', async () => {
  const { provider, store } = makeProvider(
    [{ text: chunkAnalysisReply(), finishReason: 'length' }],
    undefined,
    GLM_4_6V_SETTINGS,
  );
  await assert.rejects(
    provider.analyzeDocument({
      fingerprint: FINGERPRINT,
      fileName: FILE_NAME,
      documentId: DOCUMENT_ID,
      pages: PAGES,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, 'truncated');
      assert.match(error.message, /输出长度上限/);
      assert.match(error.message, /max_tokens=32768/);
      assert.match(error.message, /glm-4\.6v/);
      // 必须明确这是输出截断，而不是笼统归因于上下文不足。
      assert.match(error.message, /不是输入上下文不足/);
      assert.doesNotMatch(error.message, /kb-secret-key-123/);
      assert.equal((error as KnowledgeError).message.includes('Bearer'), false);
      return true;
    },
  );
  assert.equal((await store.keys()).length, 0);
});

void test('input context overflow is reported as its own failure, not as output truncation', async () => {
  const { provider, store } = makeProvider([
    {
      text: "This model's maximum context length is 128000 tokens. Please reduce the length of the messages.",
      status: 400,
    },
  ]);
  await assert.rejects(
    provider.analyzeDocument({
      fingerprint: FINGERPRINT,
      fileName: FILE_NAME,
      documentId: DOCUMENT_ID,
      pages: PAGES,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, 'context_overflow');
      assert.match(error.message, /输入内容超出/);
      assert.match(error.message, /不是输出长度不足/);
      assert.match(error.message, /分块分析/);
      assert.doesNotMatch(error.message, /输出长度上限/);
      assert.doesNotMatch(error.message, /kb-secret-key-123/);
      return true;
    },
  );
  assert.equal((await store.keys()).length, 0);
});

void test('unrelated 400 errors are not mislabelled as context overflow', async () => {
  const cases = [
    'invalid request: model glm-4.6v does not exist',
    // 限流的措辞出现在 400 时也不能被当成上下文超限。
    'Too many tokens per minute',
    // 只是不支持该参数，与上下文容量无关。
    'max_output_tokens is not supported',
    'invalid temperature: must be between 0 and 1',
  ];
  for (const text of cases) {
    const { provider, store } = makeProvider([{ text, status: 400 }]);
    await assert.rejects(
      provider.analyzeDocument({
        fingerprint: FINGERPRINT,
        fileName: FILE_NAME,
        documentId: DOCUMENT_ID,
        pages: PAGES,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ChatError, `${text} 应保留 ChatError`);
        assert.equal(error.code, 'invalid_input');
        assert.match(error.message, /400/);
        assert.doesNotMatch(error.message, /上下文长度|上下文容量/);
        assert.doesNotMatch(error.message, /kb-secret-key-123/);
        return true;
      },
    );
    assert.equal((await store.keys()).length, 0);
  }
});

void test('rate limit and auth errors keep their original classification instead of being read as context overflow', async () => {
  const cases: Array<{ status: number; text: string; code: ChatError['code'] }> = [
    // 429 的 “too many tokens per minute” 说的是速率，不是上下文长度。
    { status: 429, text: 'Too many tokens per minute', code: 'rate_limit' },
    { status: 429, text: '当前并发请求过多，请稍后重试', code: 'rate_limit' },
    { status: 401, text: 'invalid api key: input token expired', code: 'auth' },
    { status: 403, text: 'permission denied', code: 'auth' },
  ];
  for (const item of cases) {
    const { provider, store } = makeProvider([
      { text: item.text, status: item.status },
    ]);
    await assert.rejects(
      provider.analyzeDocument({
        fingerprint: FINGERPRINT,
        fileName: FILE_NAME,
        documentId: DOCUMENT_ID,
        pages: PAGES,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ChatError, `${item.status} 应保留 ChatError`);
        assert.equal(error.code, item.code);
        assert.notEqual(error.code, 'context_overflow');
        assert.match(error.message, new RegExp(String(item.status)));
        assert.doesNotMatch(error.message, /上下文长度|上下文容量/);
        assert.doesNotMatch(error.message, /kb-secret-key-123/);
        return true;
      },
    );
    assert.equal((await store.keys()).length, 0);
  }
});

void test('reserved-output parameter errors get a neutral message instead of blaming the input', async () => {
  const { provider, store } = makeProvider([
    // 这是预留输出额度与上下文容量冲突，不能判定成“输入过长”。
    { text: 'max_tokens must be less than the context window', status: 400 },
  ]);
  await assert.rejects(
    provider.analyzeDocument({
      fingerprint: FINGERPRINT,
      fileName: FILE_NAME,
      documentId: DOCUMENT_ID,
      pages: PAGES,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, 'context_overflow');
      assert.match(error.message, /输入与输出合计超出/);
      assert.match(error.message, /无法确定是输入过长还是预留的输出额度过大/);
      // 不能把责任单方面推给输入，也不能暴露凭据。
      assert.doesNotMatch(error.message, /输入内容超出/);
      assert.doesNotMatch(error.message, /不是输出长度不足/);
      assert.doesNotMatch(error.message, /kb-secret-key-123/);
      return true;
    },
  );
  assert.equal((await store.keys()).length, 0);
});

void test('input-side length errors are still reported as input overflow', async () => {
  const cases = [
    '输入长度超过模型最大输入长度限制',
    'The input is too long for this model',
  ];
  for (const text of cases) {
    const { provider } = makeProvider([{ text, status: 400 }]);
    await assert.rejects(
      provider.analyzeDocument({
        fingerprint: FINGERPRINT,
        fileName: FILE_NAME,
        documentId: DOCUMENT_ID,
        pages: PAGES,
      }),
      (error: unknown) => {
        assert.ok(error instanceof KnowledgeError);
        assert.equal(error.code, 'context_overflow');
        assert.match(error.message, /输入内容超出/);
        assert.match(error.message, /不是输出长度不足/);
        assert.doesNotMatch(error.message, /输入与输出合计超出/);
        return true;
      },
    );
  }
});

void test('source pages outside the PDF range are rejected and never saved', async () => {
  const bad = JSON.parse(digestReply()) as Record<string, unknown>;
  bad.concepts = [
    {
      id: 'c1',
      label: '向量空间',
      description: '由基张成。',
      sources: [{ documentId: DOCUMENT_ID, fileName: FILE_NAME, pageStart: 99 }],
    },
  ];
  const { provider, store } = makeProvider([chunkAnalysisReply(), JSON.stringify(bad)]);
  await assert.rejects(
    provider.analyzeDocument({
      fingerprint: FINGERPRINT,
      fileName: FILE_NAME,
      documentId: DOCUMENT_ID,
      pages: PAGES,
    }),
    (error: unknown) =>
      error instanceof KnowledgeError &&
      error.code === 'invalid_source_pages' &&
      /超出 PDF 实际页码范围/.test(error.message),
  );
  assert.equal((await store.keys()).length, 0);
});

void test('aborted requests fail fast without contacting the provider', async () => {
  const { requests, provider } = makeProvider([chunkAnalysisReply(), digestReply()]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.analyzeDocument({
      fingerprint: FINGERPRINT,
      fileName: FILE_NAME,
      documentId: DOCUMENT_ID,
      pages: PAGES,
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof KnowledgeError && error.code === 'aborted',
  );
  assert.equal(requests.length, 0);
});

void test('digest cache key changes with fingerprint, model, prompt and schema version', () => {
  const base = {
    fingerprint: FINGERPRINT,
    provider: 'openai-compatible-knowledge',
    model: 'model-a',
    promptVersion: 'ai-digest-v1',
    schemaVersion: 2,
  };
  assert.equal(knowledgeDigestCacheKey(base), knowledgeDigestCacheKey({ ...base }));
  assert.notEqual(
    knowledgeDigestCacheKey(base),
    knowledgeDigestCacheKey({ ...base, model: 'model-b' }),
  );
  assert.notEqual(
    knowledgeDigestCacheKey(base),
    knowledgeDigestCacheKey({ ...base, promptVersion: 'ai-digest-v2' }),
  );
  assert.notEqual(
    knowledgeDigestCacheKey(base),
    knowledgeDigestCacheKey({ ...base, fingerprint: 'b'.repeat(64) }),
  );
  assert.notEqual(
    knowledgeDigestCacheKey(base),
    knowledgeDigestCacheKey({ ...base, schemaVersion: 1 }),
  );
});

void test('second analysis of the same PDF reuses the cached digest without new requests', async () => {
  const { requests, provider } = makeProvider([chunkAnalysisReply(), digestReply()]);
  const input = {
    fingerprint: FINGERPRINT,
    fileName: FILE_NAME,
    documentId: DOCUMENT_ID,
    pages: PAGES,
  };
  const first = await provider.analyzeDocument(input);
  assert.equal(requests.length, 2);
  const second = await provider.analyzeDocument(input);
  assert.equal(requests.length, 2);
  assert.deepEqual(second, first);

  // 更换模型后缓存身份不同，必须重新请求。
  const otherSettings: KnowledgeSettings = { ...settings, model: 'model-b' };
  const { fetchImpl } = createMockFetch([chunkAnalysisReply(), digestReply()]);
  const otherProvider = createKnowledgeProviderForSettings(
    otherSettings,
    fetchImpl,
    createKnowledgeDigestCache(createMemoryStore<DocumentDigest>()),
  );
  const third = await otherProvider.analyzeDocument(input);
  assert.equal(third.model, 'model-b');

  // bypassCache 用于“重新生成”，必须重新调用 AI。
  await provider.analyzeDocument({ ...input, bypassCache: true });
  assert.equal(requests.length, 4);
});

void test('single-PDF summary and mindmap come from the mocked AI response', async () => {
  const { provider } = makeProvider([chunkAnalysisReply(), digestReply()]);
  const digest = await provider.analyzeDocument({
    fingerprint: FINGERPRINT,
    fileName: FILE_NAME,
    documentId: DOCUMENT_ID,
    pages: PAGES,
  });

  assert.equal(digest.schemaVersion, 3);
  assert.equal(digest.promptVersion, 'ai-digest-v5');
  assert.ok(digest.overview.length > 80, 'overview should be a real synthesis');
  assert.equal(digest.sourcePages, digest.sourcePages); // sanity
  assert.deepEqual(digest.sourcePages, [1, 2, 3]);
  assert.equal(digest.sections[1].pageStart, 3);
  // relations 已重映射为规范概念 id。
  const ids = new Set(digest.concepts.map((concept) => concept.id));
  for (const relation of digest.relations) {
    assert.ok(ids.has(relation.from));
    assert.ok(ids.has(relation.to));
    assert.equal(relation.label, '依赖');
  }
  for (const concept of digest.concepts) {
    for (const source of concept.sources) {
      assert.equal(source.documentId, DOCUMENT_ID);
      assert.equal(source.fileName, FILE_NAME);
    }
  }

  const markdown = renderDocumentSummary(digest);
  assert.match(markdown, /# 线性代数讲义/);
  assert.match(markdown, /AI 生成（模型 knowledge-model-x）/);
  assert.match(markdown, /来源：第 1–2 页/);
  assert.match(markdown, /待解决问题/);
  assert.doesNotMatch(markdown, /kb-secret-key-123/);
});

void test('course knowledge is synthesized across multiple documents by AI', async () => {
  const digestA = makeAiDigest();
  const digestB = makeAiDigest({
    documentId: 'doc-bbbbbbbbbbbbbbbb',
    fingerprint: 'bb11'.repeat(16),
    title: '讲义2',
    overview: '第二份讲义的 AI 概述，介绍特征值分解。',
    sourcePages: [1, 2, 3],
    concepts: [
      {
        id: 'doc-bbbbbbbbbbbbbbbb-concept-1',
        label: '向量空间',
        description: '第二份讲义的复习。',
        sources: [{ documentId: 'doc-bbbbbbbbbbbbbbbb', fileName: '讲义2.pdf', pageStart: 2, type: 'pdf' }],
      },
      {
        id: 'doc-bbbbbbbbbbbbbbbb-concept-2',
        label: '特征值分解',
        description: '分解方法。',
        sources: [{ documentId: 'doc-bbbbbbbbbbbbbbbb', fileName: '讲义2.pdf', pageStart: 3, type: 'pdf' }],
      },
    ],
  });

  const { requests, provider } = makeProvider([courseReply()]);
  const aiKnowledge = await provider.synthesizeCourseKnowledge({
    courseId: 'course-1',
    courseName: '线性代数',
    digests: [digestA, digestB],
    userNodeLabels: ['我的疑问'],
  });

  // 提示词里必须给出两个文档的摘要与用户节点约束。
  const prompt = (requests[0].body.messages as Array<{ content: string }>)[1].content;
  assert.match(prompt, /doc-aaaaaaaaaaaaaaaa/);
  assert.match(prompt, /doc-bbbbbbbbbbbbbbbb/);
  assert.match(prompt, /我的疑问/);

  assert.equal(aiKnowledge.promptVersion, 'ai-course-v4');
  assert.equal(aiKnowledge.provider, 'openai-compatible-knowledge');

  let knowledge = emptyCourseKnowledge('course-1', '线性代数', '2026-08-31T00:00:00.000Z');
  knowledge = applyAiCourseKnowledge(knowledge, aiKnowledge, '2026-08-31T01:00:00.000Z');
  assert.equal(knowledge.schemaVersion, 3);
  assert.equal(knowledge.version, 1);
  assert.equal(knowledge.model, settings.model);
  assert.match(knowledge.nodes.find((node) => node.kind === 'course')!.description, /线性代数的结构与分解/);

  const vector = knowledge.nodes.find((node) => node.label === '向量空间')!;
  assert.equal(vector.sources.length, 2, '跨文档概念应合并两份来源');
  assert.deepEqual(
    vector.sources.map((source) => source.documentId).sort(),
    ['doc-aaaaaaaaaaaaaaaa', 'doc-bbbbbbbbbbbbbbbb'],
  );
  const eigen = knowledge.nodes.find((node) => node.label === '特征值分解')!;
  assert.equal(
    knowledge.relations.some(
      (relation) => relation.from === vector.id && relation.to === eigen.id && relation.label === '依赖',
    ),
    true,
  );
  assert.equal(knowledge.conflicts.length, 1);
  assert.equal(knowledge.conflicts[0].nodeId, eigen.id);
  assert.deepEqual(knowledge.unresolvedQuestions, ['如何判断矩阵可对角化？']);

  const manifest: CourseManifest = {
    schemaVersion: 1,
    id: 'course-1',
    name: '线性代数',
    revision: 1,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T01:00:00.000Z',
    activeKnowledgeVersion: 1,
    documents: [],
  };
  const summary = renderCourseSummary(manifest, knowledge);
  assert.match(summary, /资料冲突/);
  assert.match(summary, /待解决问题/);
  assert.doesNotMatch(summary, /kb-secret-key-123/);
});

void test('AI regeneration keeps ownership=user nodes and their relations', () => {
  const knowledge = emptyCourseKnowledge('course-1', '机器学习', '2026-08-31T00:00:00.000Z');
  knowledge.nodes.push(
    {
      id: 'user-1',
      label: '我的疑问',
      description: '自己整理的问题清单。',
      kind: 'question',
      ownership: 'user',
      sources: [],
    },
    {
      id: 'user-2',
      label: '梯度下降',
      description: '用户自己的理解，不能被覆盖。',
      kind: 'concept',
      ownership: 'user',
      sources: [
        { documentId: 'doc-aaaaaaaaaaaaaaaa', fileName: '讲义1.pdf', pageStart: 4, type: 'pdf' },
      ],
    },
  );
  knowledge.relations.push({ from: 'user-1', to: 'user-2', label: '关联' });

  const ai: AiCourseKnowledge = {
    theme: '课程核心是优化与泛化。',
    nodes: [
      {
        id: 'course-1-kn-1',
        label: '梯度下降',
        description: 'AI 的描述，必须被忽略。',
        sources: [{ documentId: 'doc-aaaaaaaaaaaaaaaa', fileName: '讲义1.pdf', pageStart: 1, type: 'pdf' }],
      },
      {
        id: 'course-1-kn-2',
        label: '反向传播',
        description: '链式法则计算梯度。',
        sources: [{ documentId: 'doc-aaaaaaaaaaaaaaaa', fileName: '讲义1.pdf', pageStart: 2, type: 'pdf' }],
      },
    ],
    relations: [{ from: 'course-1-kn-2', to: 'course-1-kn-1', label: '依赖' }],
    conflicts: [],
    unresolvedQuestions: ['学习率如何选择？'],
    provider: 'openai-compatible-knowledge',
    model: 'knowledge-model-x',
    promptVersion: 'ai-course-v1',
  };

  const next = applyAiCourseKnowledge(knowledge, ai, '2026-08-31T02:00:00.000Z');
  const userNode = next.nodes.find((node) => node.id === 'user-2')!;
  assert.equal(userNode.ownership, 'user');
  assert.equal(userNode.description, '用户自己的理解，不能被覆盖。');
  assert.equal(next.nodes.filter((node) => node.label === '梯度下降').length, 1);
  // 去重后应指向受保护的用户节点，不能静默丢失关系。
  assert.equal(
    next.relations.some((relation) => relation.label === '依赖' && relation.to === 'user-2'),
    true,
  );
  assert.equal(
    next.relations.some((relation) => relation.from === 'user-1' && relation.to === 'user-2'),
    true,
    '用户节点之间的关系必须保留',
  );
  assert.equal(next.nodes.find((node) => node.id === 'user-1')?.kind, 'question');
  assert.match(
    next.nodes.find((node) => node.kind === 'course')!.description,
    /优化与泛化/,
  );
});

void test('mindmap layout and SVG follow AI relations instead of linking everything to the root', () => {
  const knowledge = emptyCourseKnowledge('course-1', '线性代数');
  const [a, b, c] = ['向量空间', '线性映射', '特征值'].map((label, index) => {
    const node = {
      id: `concept-${index + 1}`,
      label,
      description: `${label}的描述。`,
      kind: 'concept' as const,
      ownership: 'generated' as const,
      sources: [
        { documentId: DOCUMENT_ID, fileName: FILE_NAME, pageStart: index + 1, type: 'pdf' as const },
      ],
    };
    knowledge.nodes.push(node);
    return node;
  });
  const root = knowledge.nodes[0];
  knowledge.relations.push(
    { from: root.id, to: a.id, label: '包含' },
    { from: a.id, to: b.id, label: '依赖' },
    { from: b.id, to: c.id, label: '导致' },
  );

  const layout = buildMindmapLayout(knowledge.nodes, knowledge.relations);
  const depth = (id: string) => layout.nodes.find((node) => node.id === id)?.depth;
  assert.equal(depth(a.id), 1);
  assert.equal(depth(b.id), 2);
  assert.equal(depth(c.id), 3);
  const bNode = layout.nodes.find((node) => node.id === b.id)!;
  assert.equal(bNode.parentId, a.id);
  assert.equal(bNode.relationLabel, '依赖');

  const manifest: CourseManifest = {
    schemaVersion: 1,
    id: 'course-1',
    name: '线性代数',
    revision: 1,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    activeKnowledgeVersion: 1,
    documents: [],
  };
  const svg = renderKnowledgeSvg(manifest, knowledge);
  assert.match(svg, /依赖/);
  assert.match(svg, /导致/);
  assert.match(svg, /包含/);
  assert.doesNotMatch(svg, /api[_-]?key/i);

  // 节点超上限时折叠展示，而不是丢失结构（JSON 仍保存全部节点）。
  const many = emptyCourseKnowledge('course-2', '大数据课程');
  for (let index = 0; index < MINDMAP_DEFAULT_MAX_NODES + 20; index += 1) {
    many.nodes.push({
      id: `node-${index}`,
      label: `概念 ${index}`,
      description: '占位描述。',
      kind: 'concept',
      ownership: 'generated',
      sources: [],
    });
    many.relations.push({ from: many.nodes[0].id, to: `node-${index}`, label: '包含' });
  }
  const capped = buildMindmapLayout(many.nodes, many.relations);
  assert.equal(capped.nodes.length, MINDMAP_DEFAULT_MAX_NODES);
  assert.equal(capped.hiddenCount, many.nodes.length - capped.nodes.length);
  const cappedSvg = renderKnowledgeSvg(
    { ...manifest, id: 'course-2', name: '大数据课程' },
    many,
  );
  assert.match(cappedSvg, /已折叠 \d+ 个节点/);
});

type MemoryNode =
  | { type: 'dir'; children: Map<string, MemoryNode> }
  | { type: 'file'; data: Uint8Array };

class MemoryFileHandle implements BrowserFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  private readonly node: Extract<MemoryNode, { type: 'file' }>;

  constructor(name: string, node: Extract<MemoryNode, { type: 'file' }>) {
    this.name = name;
    this.node = node;
  }

  async getFile(): Promise<File> {
    return new File([this.node.data.slice()], this.name);
  }

  async createWritable(): Promise<WritableFileHandle> {
    const chunks: BlobPart[] = [];
    return {
      write: async (data) => {
        chunks.push(data as BlobPart);
      },
      close: async () => {
        this.node.data = new Uint8Array(await new Blob(chunks).arrayBuffer());
      },
    };
  }
}

class MemoryDirectoryHandle implements BrowserDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  private readonly node: Extract<MemoryNode, { type: 'dir' }>;

  constructor(name: string, node: Extract<MemoryNode, { type: 'dir' }>) {
    this.name = name;
    this.node = node;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BrowserDirectoryHandle> {
    let child = this.node.children.get(name);
    if (!child) {
      if (!options?.create) throw new Error(`目录不存在：${name}`);
      child = { type: 'dir', children: new Map() };
      this.node.children.set(name, child);
    }
    if (child.type !== 'dir') throw new Error(`“${name}”不是目录`);
    return new MemoryDirectoryHandle(name, child);
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BrowserFileHandle> {
    let child = this.node.children.get(name);
    if (!child) {
      if (!options?.create) throw new DOMException(`文件不存在：${name}`, 'NotFoundError');
      child = { type: 'file', data: new Uint8Array() };
      this.node.children.set(name, child);
    }
    if (child.type !== 'file') throw new Error(`“${name}”不是文件`);
    return new MemoryFileHandle(name, child);
  }

  async list(): Promise<string[]> {
    return [...this.node.children.keys()];
  }
}

function newMemoryRoot(): MemoryDirectoryHandle {
  return new MemoryDirectoryHandle('课程文件夹', {
    type: 'dir',
    children: new Map(),
  });
}

async function readMemoryFile(
  root: BrowserDirectoryHandle,
  pathSegments: string[],
): Promise<string> {
  let current: BrowserDirectoryHandle = root;
  for (const segment of pathSegments.slice(0, -1)) {
    current = await current.getDirectoryHandle(segment);
  }
  const handle = await current.getFileHandle(pathSegments.at(-1)!);
  return (await handle.getFile()).text();
}

/** 用真实 workspace 文件层模拟主进程 IPC（与 desktop-course-storage.test.ts 相同）。 */
class FakeWorkspaceApi implements YeyuDesktopApi {
  private layout;

  constructor(root: string) {
    this.layout = resolveWorkspaceLayout(root);
  }

  async getWorkspaceInfo() {
    await ensureWorkspace(this.layout);
    return { root: this.layout.root, coursesRoot: this.layout.coursesRoot };
  }

  listCourses() {
    return scanCourses(this.layout.coursesRoot);
  }

  createCourseDirectory(name: string) {
    return createCourseDirectory(this.layout.coursesRoot, name);
  }

  exists(courseDirectory: string, relativePath: string[]) {
    return courseFileExists(this.layout.coursesRoot, courseDirectory, relativePath);
  }

  ensureDirectory(courseDirectory: string, relativePath: string[]) {
    return ensureCourseDirectory(this.layout.coursesRoot, courseDirectory, relativePath);
  }

  readFile(courseDirectory: string, relativePath: string[]) {
    return readCourseFile(this.layout.coursesRoot, courseDirectory, relativePath);
  }

  writeFile(courseDirectory: string, relativePath: string[], data: Uint8Array) {
    return writeCourseFile(this.layout.coursesRoot, courseDirectory, relativePath, data);
  }

  deleteFile(courseDirectory: string, relativePath: string[]) {
    return deleteCourseEntry(this.layout.coursesRoot, courseDirectory, relativePath);
  }

  deleteCourseDirectory(courseDirectory: string) {
    return removeCourseDirectory(this.layout.coursesRoot, courseDirectory);
  }

  async revealWorkspace() {}
}

function normalizeTimestamps(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'NOW')
    .replace(/revision-\d+-\d+/g, 'revision');
}

void test('browser and desktop storages produce identical AI artifacts', async () => {
  const digest = makeAiDigest();
  const ai: AiCourseKnowledge = {
    theme: '课程核心是线性结构与分解。',
    nodes: [
      {
        id: 'course-kn-1',
        label: '向量空间',
        description: '由基张成的结构。',
        sources: [{ documentId: digest.documentId, fileName: '讲义1.pdf', pageStart: 1, type: 'pdf' }],
      },
      {
        id: 'course-kn-2',
        label: '特征值分解',
        description: '矩阵分解方法。',
        sources: [{ documentId: digest.documentId, fileName: '讲义1.pdf', pageStart: 2, type: 'pdf' }],
      },
    ],
    relations: [{ from: 'course-kn-1', to: 'course-kn-2', label: '依赖' }],
    conflicts: [],
    unresolvedQuestions: ['如何求特征向量？'],
    provider: 'openai-compatible-knowledge',
    model: 'knowledge-model-x',
    promptVersion: 'ai-course-v1',
  };

  const browserRoot = newMemoryRoot();
  const browserStorage = new BrowserDirectoryStorage(browserRoot);
  const browserInitial = await browserStorage.initialize('线性代数');
  await browserStorage.importDocument(
    new File(['pdf'], '讲义1.pdf', { type: 'application/pdf' }),
    digest,
    importOptions,
    browserInitial.manifest.revision,
    ai,
  );

  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), 'yeyu-parity-'));
  try {
    const api = new FakeWorkspaceApi(desktopRoot);
    await api.getWorkspaceInfo();
    const { directoryName } = await api.createCourseDirectory('线性代数');
    const desktopStorage = new DesktopCourseStorage(api, directoryName);
    const desktopInitial = await desktopStorage.initialize('线性代数');
    await desktopStorage.importDocument(
      new File(['pdf'], '讲义1.pdf', { type: 'application/pdf' }),
      digest,
      importOptions,
      desktopInitial.manifest.revision,
      ai,
    );

    const browserKnowledgeRaw = await readMemoryFile(browserRoot, ['课程脑图.json']);
    const desktopKnowledgeRaw = normalizeTimestamps(
      new TextDecoder().decode(
        await api.readFile(directoryName, ['课程脑图.json']),
      ),
    ).replaceAll(desktopInitial.manifest.id, 'COURSE');
    const browserKnowledgeNormalized = normalizeTimestamps(browserKnowledgeRaw)
      .replaceAll(browserInitial.manifest.id, 'COURSE');
    assert.equal(browserKnowledgeNormalized, desktopKnowledgeRaw);
    const browserKnowledge = JSON.parse(browserKnowledgeRaw) as { schemaVersion: number };
    assert.equal(browserKnowledge.schemaVersion, 3);

    // 课程总结 Markdown 结构一致（仅时间戳与课程 id 不同）。
    assert.equal(
      normalizeTimestamps(await readMemoryFile(browserRoot, ['课程总结.md'])).replaceAll(
        browserInitial.manifest.id,
        'COURSE',
      ),
      normalizeTimestamps(
        new TextDecoder().decode(await api.readFile(directoryName, ['课程总结.md'])),
      ).replaceAll(desktopInitial.manifest.id, 'COURSE'),
    );
    // 单 PDF 成果完全一致（AI 摘要带 relations）。
    const brainmapJson = JSON.parse(
      await readMemoryFile(browserRoot, ['Documents', digest.documentId, 'PDF脑图.json']),
    ) as { relations: Array<{ label: string }> };
    assert.equal(brainmapJson.relations[0].label, '依赖');
    assert.equal(
      await readMemoryFile(browserRoot, ['Documents', digest.documentId, 'PDF总结.md']),
      new TextDecoder().decode(
        await api.readFile(directoryName, ['Documents', digest.documentId, 'PDF总结.md']),
      ),
    );
    assert.equal(
      await readMemoryFile(browserRoot, ['Documents', digest.documentId, 'PDF脑图.svg']),
      new TextDecoder().decode(
        await api.readFile(directoryName, ['Documents', digest.documentId, 'PDF脑图.svg']),
      ),
    );
  } finally {
    await rm(desktopRoot, { recursive: true, force: true });
  }
});

void test('failed AI synthesis leaves the course version, history and files untouched', async () => {
  // AI 分块分析成功，但课程综合两次都输出非法 JSON。
  const { provider } = makeProvider([
    chunkAnalysisReply(),
    digestReply(),
    '第一条坏输出',
    '第二条坏输出',
  ]);
  const digest = await provider.analyzeDocument({
    fingerprint: FINGERPRINT,
    fileName: FILE_NAME,
    documentId: DOCUMENT_ID,
    pages: PAGES,
  });

  const browserRoot = newMemoryRoot();
  const storage = new BrowserDirectoryStorage(browserRoot);
  const initial = await storage.initialize('线性代数');
  await assert.rejects(
    (async () => {
      const aiKnowledge = await provider.synthesizeCourseKnowledge({
        courseId: initial.manifest.id,
        courseName: '线性代数',
        digests: [digest],
      });
      await storage.importDocument(
        new File(['pdf'], FILE_NAME, { type: 'application/pdf' }),
        digest,
        importOptions,
        initial.manifest.revision,
        aiKnowledge,
      );
    })(),
    (error: unknown) =>
      error instanceof KnowledgeError &&
      error.code === 'invalid_output' &&
      /已自动重试一次仍失败/.test(error.message),
  );

  const reloaded = await storage.load();
  assert.equal(reloaded.manifest.revision, 0, '课程版本不应推进');
  assert.equal(reloaded.knowledge.version, 0);
  assert.equal(Object.keys(reloaded.digests).length, 0);
  const historyDir = (await browserRoot.getDirectoryHandle(
    'History',
  )) as MemoryDirectoryHandle;
  assert.deepEqual(await historyDir.list(), [], '不得写入 History 快照');
  const documentsDir = (await browserRoot.getDirectoryHandle(
    'Documents',
  )) as MemoryDirectoryHandle;
  assert.deepEqual(await documentsDir.list(), [], '不得写入残缺文档成果');
});

void test('failed digest analysis does not touch an already-initialized course', async () => {
  const { provider, store } = makeProvider([
    '分块分析坏输出 1',
    '分块分析坏输出 2',
  ]);
  const storage = new MemoryCourseStorage();
  const initial = await storage.initialize('机器学习');
  await assert.rejects(
    (async () => {
      const digest = await provider.analyzeDocument({
        fingerprint: FINGERPRINT,
        fileName: FILE_NAME,
        documentId: DOCUMENT_ID,
        pages: PAGES,
      });
      await storage.importDocument(
        new File(['pdf'], FILE_NAME, { type: 'application/pdf' }),
        digest,
        importOptions,
        initial.manifest.revision,
      );
    })(),
    /已自动重试一次仍失败/,
  );
  const reloaded = await storage.load();
  assert.equal(reloaded.manifest.revision, 0);
  assert.equal(reloaded.knowledge.version, 0);
  assert.equal((await store.keys()).length, 0);
});

void test('provider errors surface service details without exposing credentials', async () => {
  const { provider } = makeProvider([
    { text: '配额已用尽', status: 402 },
  ]);
  try {
    await provider.analyzeDocument({
      fingerprint: FINGERPRINT,
      fileName: FILE_NAME,
      documentId: DOCUMENT_ID,
      pages: PAGES,
    });
    assert.fail('should reject');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /额度不足|402|配额已用尽/);
    assert.doesNotMatch(message, /kb-secret-key-123/);
  }
});

void test('scientific summary points preserve LaTeX and tables through synthesis, cache and Markdown', async () => {
  const text = String.raw`### 能量关系
$$E = mc^2 + \frac{p^2}{2m}$$

| 量 | 单位 |
| --- | --- |
| E | J |`;
  const { provider, requests } = makeProvider([chunkAnalysisReply(), digestReply({sections:[{
    title:'能量', summary:'适用条件', pageStart:1, pageEnd:2,
    points:[{text,pageStart:2,pageEnd:2}],
  }]})]);
  const input = {fingerprint:FINGERPRINT,documentId:DOCUMENT_ID,fileName:FILE_NAME,pages:PAGES};
  const digest = await provider.analyzeDocument(input);
  assert.equal(digest.sections[0].points?.[0].text, text);
  assert.ok(renderDocumentSummary(digest).includes(text));
  assert.match(renderDocumentSummary(digest), /来源：第 2 页/);
  assert.deepEqual(await provider.analyzeDocument(input), digest);
  assert.equal(requests.length, 2);
  const prompts = JSON.stringify(requests.map((request) => request.body.messages));
  assert.match(prompts, /points/);
  assert.match(prompts, /GFM tables/);
});

void test('out-of-section point sources are rejected before cache writes', async () => {
  const { provider, store } = makeProvider([chunkAnalysisReply(), digestReply({sections:[{
    title:'能量',summary:'条件',pageStart:1,pageEnd:1,points:[{text:'结论',pageStart:2,pageEnd:2}],
  }]})]);
  await assert.rejects(provider.analyzeDocument({fingerprint:FINGERPRINT,documentId:DOCUMENT_ID,fileName:FILE_NAME,pages:PAGES}), /要点来源超出/);
  assert.equal((await store.keys()).length, 0);
});

void test('unavailable IndexedDB cache does not discard successful AI work', async () => {
  const stages: string[] = [];
  const broken: KVStore<DocumentDigest> = {
    get:async () => {throw new Error('blocked IDB');},
    set:async () => {throw new Error('quota');}, delete:async () => {}, keys:async () => [],
  };
  const { provider } = makeProvider([chunkAnalysisReply(), digestReply()], broken);
  const digest = await provider.analyzeDocument({fingerprint:FINGERPRINT,documentId:DOCUMENT_ID,fileName:FILE_NAME,pages:PAGES,onStage:(stage) => stages.push(stage)});
  assert.equal(digest.title, '线性代数讲义');
  assert.equal(stages.filter((stage) => stage === 'cache-unavailable').length, 6);
});

void test('duplicate document concepts remap every relation and retain scientific signs', async () => {
  const concept = (id: string,label: string,page: number) => ({id,label,description:label,sources:[{pageStart:page}]});
  const { provider } = makeProvider([chunkAnalysisReply(), digestReply({
    concepts:[concept('c1','C++',1),concept('c2','C++',2),concept('c3','C',3)],
    relations:[{from:'c2',to:'c3',label:'对比'}],
  })]);
  const digest = await provider.analyzeDocument({fingerprint:FINGERPRINT,documentId:DOCUMENT_ID,fileName:FILE_NAME,pages:PAGES});
  assert.equal(digest.concepts.length, 2);
  assert.equal(digest.concepts[0].sources.length, 2);
  assert.equal(digest.relations[0].from, digest.concepts[0].id);
  assert.equal(digest.relations[0].to, digest.concepts[1].id);
});

void test('course regeneration deduplicates, keeps stable IDs and preserves user-connected endpoints', () => {
  const source = (documentId: string, fileName: string, pageStart: number): SourceReference => ({documentId,fileName,pageStart,type:'pdf'});
  const current = emptyCourseKnowledge('c','科学');
  current.nodes.push(
    {id:'old',label:'Gradient Descent',description:'old',kind:'concept',ownership:'generated',sources:[]},
    {id:'omitted',label:'前提',description:'保留的前提',kind:'concept',ownership:'generated',sources:[]},
    {id:'note',label:'我的笔记',description:'禁止覆盖',kind:'insight',ownership:'user',sources:[]},
  );
  current.relations.push({from:'note',to:'old',label:'关联'},{from:'note',to:'omitted',label:'依赖'});
  const ai: AiCourseKnowledge = {theme:'优化',nodes:[
    {id:'k1',label:'gradient  descent',description:'新解释',sources:[source('d1','a.pdf',1)]},
    {id:'k2',label:'Gradient Descent',description:'重复',sources:[source('d2','b.pdf',2)]},
    {id:'k3',label:'我的笔记',description:'覆盖尝试',sources:[source('d1','a.pdf',2)]},
  ],relations:[{from:'k2',to:'k3',label:'应用'}],conflicts:[{nodeId:'k2',descriptions:['a','b'],sources:[]}],unresolvedQuestions:[],provider:'mock',model:'mock',promptVersion:'test'};
  const next = applyAiCourseKnowledge(current, ai);
  assert.equal(next.nodes.filter((node) => /descent/i.test(node.label)).length, 1);
  assert.equal(next.nodes.find((node) => node.id === 'old')?.sources.length, 2);
  assert.equal(next.nodes.find((node) => node.id === 'note')?.description, '禁止覆盖');
  assert.equal(next.nodes.find((node) => node.id === 'note')?.sources.length, 1);
  assert.ok(next.nodes.some((node) => node.id === 'omitted'));
  assert.ok(next.relations.some((relation) => relation.from === 'old' && relation.to === 'note'));
  assert.equal(next.relations.filter((relation) => relation.from === 'note').length, 2);
  assert.equal(next.conflicts[0].nodeId, 'old');
  assert.equal(current.nodes.find((node) => node.id === 'note')?.sources.length, 0);
});

void test('oversized course output is rejected instead of retaining dangling relations', async () => {
  const raw = JSON.parse(courseReply()) as {concepts: Array<Record<string, unknown>>};
  raw.concepts = Array.from({length:61}, (_,index) => ({...raw.concepts[0],id:`k${index+1}`,label:`概念 ${index}`}));
  const { provider } = makeProvider([JSON.stringify(raw)]);
  await assert.rejects(provider.synthesizeCourseKnowledge({courseId:'c',courseName:'科学',digests:[makeAiDigest(),makeAiDigest({documentId:'doc-bbbbbbbbbbbb',sourcePages:[1,2,3]})]}), /超过 60/);
});

void test('glossary reaches chunk, document and course prompts and invalidates digest cache', async () => {
  const { EMPTY_GLOSSARY, reviseGlossary, glossaryFingerprint } = await import('../lib/glossary.ts');
  const glossary = reviseGlossary(EMPTY_GLOSSARY, [{ source: 'vector space', target: '向量空间', forbidden: ['矢量空间'], note: '统一名称，保留 V 与 v' }]);
  const { requests, provider, store } = makeProvider([chunkAnalysisReply(), digestReply(), chunkAnalysisReply(), digestReply(), courseReply()]);
  const input = { fingerprint: FINGERPRINT, documentId: DOCUMENT_ID, fileName: FILE_NAME, pages: ['vector space V', ...PAGES.slice(1)], glossary };
  const digest = await provider.analyzeDocument(input);
  assert.equal(digest.glossaryFingerprint, await glossaryFingerprint(glossary));
  await provider.analyzeDocument(input);
  assert.equal(requests.length, 2);
  await provider.analyzeDocument({ ...input, glossary: reviseGlossary(glossary, glossary.entries) });
  assert.equal(requests.length, 4);
  assert.equal((await store.keys()).length, 2);
  await provider.synthesizeCourseKnowledge({ courseId: 'course-1', courseName: '线性代数', digests: [makeAiDigest(), makeSecondDigest()], glossary });
  for (const request of requests) {
    const system = (request.body.messages as Array<{ content: string }>)[0].content;
    assert.match(system, /"source":"vector space"/);
    assert.match(system, /"target":"向量空间"/);
    assert.match(system, /矢量空间/);
    assert.match(system, /Preserve formulas, symbols, variable names/);
    assert.match(system, /MUST remain unchanged/);
  }
  assert.notEqual(knowledgeDigestCacheKey({ fingerprint: 'a', provider: 'p', model: 'm', promptVersion: 'v', schemaVersion: 2 }),
    knowledgeDigestCacheKey({ fingerprint: 'a', provider: 'p', model: 'm', promptVersion: 'v', schemaVersion: 2, glossaryFingerprint: 'f' }));
});

void test('browser directory glossary persists independently and rejects damaged files', async () => {
  const { EMPTY_GLOSSARY, reviseGlossary } = await import('../lib/glossary.ts');
  const root = newMemoryRoot();
  const storage = new BrowserDirectoryStorage(root);
  await storage.initialize('课程');
  assert.deepEqual(await storage.loadGlossary(), EMPTY_GLOSSARY);
  const glossary = reviseGlossary(EMPTY_GLOSSARY, [{ source: 'v', target: 'v', forbidden: [], note: '速度符号' }]);
  const before = await storage.load();
  await storage.saveGlossary(glossary);
  assert.deepEqual(await new BrowserDirectoryStorage(root).loadGlossary(), glossary);
  assert.deepEqual(await storage.load(), before);
  const writer = await (await root.getFileHandle('glossary.json')).createWritable();
  await writer.write('{invalid'); await writer.close();
  await assert.rejects(storage.loadGlossary());
});
