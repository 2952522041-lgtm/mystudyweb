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
  ensureCourseDirectory,
  ensureWorkspace,
  readCourseFile,
  scanCourses,
  writeCourseFile,
} from '../electron/workspace.ts';
import { resolveWorkspaceLayout } from '../electron/workspace-paths.ts';
import {
  KnowledgeError,
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
  knowledgeDigestCacheKey,
} from '../lib/knowledge/ai-knowledge-provider.ts';
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
  return JSON.stringify({
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
  });
}

function courseReply() {
  return JSON.stringify({
    theme: '本课程围绕线性代数的结构与分解展开。',
    concepts: [
      {
        id: 'k1',
        label: '向量空间',
        description: '两份讲义共同定义的核心结构。',
        sources: [
          { documentId: 'doc-aaaaaaaaaaaaaaaa', fileName: '讲义1.pdf', pageStart: 1, pageEnd: 2 },
          { documentId: 'doc-bbbbbbbbbbbbbbbb', fileName: '讲义2.pdf', pageStart: 2 },
        ],
      },
      {
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
) {
  const { requests, fetchImpl } = createMockFetch(replies);
  const store = cacheStore ?? createMemoryStore<DocumentDigest>();
  const provider = createKnowledgeProviderForSettings(
    settings,
    fetchImpl,
    createKnowledgeDigestCache(store),
  );
  return { requests, provider, store };
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
  assert.match(retryMessages.at(-2)?.content ?? '', /抱歉/);
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

  assert.equal(digest.schemaVersion, 2);
  assert.equal(digest.promptVersion, 'ai-digest-v2');
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

  assert.equal(aiKnowledge.promptVersion, 'ai-course-v1');
  assert.equal(aiKnowledge.provider, 'openai-compatible-knowledge');

  let knowledge = emptyCourseKnowledge('course-1', '线性代数', '2026-08-31T00:00:00.000Z');
  knowledge = applyAiCourseKnowledge(knowledge, aiKnowledge, '2026-08-31T01:00:00.000Z');
  assert.equal(knowledge.schemaVersion, 2);
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
  // AI 关系指向被跳过的重复节点，应被丢弃而不是报错。
  assert.equal(
    next.relations.some((relation) => relation.label === '依赖'),
    false,
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
      if (!options?.create) throw new Error(`文件不存在：${name}`);
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
    assert.equal(browserKnowledge.schemaVersion, 2);

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
