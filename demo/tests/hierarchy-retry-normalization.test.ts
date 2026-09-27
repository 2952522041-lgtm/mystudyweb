import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  DocumentDigest,
  SourceReference,
} from '../lib/course-storage/types.ts';
import {
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
  KnowledgeError,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import {
  paperPages,
  reply,
  settings,
  source,
} from './fixtures/hierarchical-synthesis.ts';

const DOCUMENT_ID = 'lecture';
const FILE_NAME = 'lecture.pdf';
const ROOT_IDS = Array.from({ length: 12 }, (_, index) => `root-${index + 1}`);

type HierarchyMode = 'success' | 'cycle' | 'source';
type RequestBody = { messages?: Array<{ role?: string; content?: string }> };

function streamResponse(value: unknown): Response {
  const content = JSON.stringify(value);
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n`,
    'data: [DONE]\n',
  ].join('\n');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function initialDigestPayload() {
  const conceptSource = (pageStart = 1): SourceReference =>
    source(DOCUMENT_ID, pageStart);
  return {
    hierarchy: {
      mode: 'flat' as const,
      reason: '测试输入故意提供超过布局容量的并列根节点。',
    },
    title: '层级修复材料',
    overview: '包含全部原始事实、来源和横向关系。',
    sections: [
      {
        title: '原始章节',
        summary: '原始章节摘要。',
        pageStart: 1,
        pageEnd: 1,
      },
    ],
    concepts: ROOT_IDS.map((id, index) => ({
      id,
      parentId: null,
      label: `原始事实 ${index + 1}`,
      description: `事实说明 ${index + 1}`,
      sources: [conceptSource()],
    })),
    relations: [
      { from: 'root-1', to: 'root-2', label: '依赖' },
      { from: 'root-3', to: 'root-4', label: '对比' },
    ],
    unresolvedQuestions: [],
  };
}

function safeAssignments() {
  return [
    { id: 'root-1', parentId: null },
    { id: 'root-2', parentId: 'root-1' },
    { id: 'root-3', parentId: 'root-2' },
    // The repair candidate intentionally has depth 4. root-4 can be promoted
    // to root-2 because that ancestor is present in the same candidate.
    { id: 'root-4', parentId: 'root-3' },
    ...ROOT_IDS.slice(4).map((id) => ({ id, parentId: null })),
  ];
}

function repairPayload(mode: HierarchyMode) {
  const assignments =
    mode === 'cycle'
      ? [
          { id: 'root-1', parentId: 'root-2' },
          { id: 'root-2', parentId: 'root-1' },
          ...ROOT_IDS.slice(2).map((id) => ({ id, parentId: null })),
        ]
      : safeAssignments();
  return {
    hierarchy: {
      mode: 'flat' as const,
      reason: '按原始材料组织根节点和从属分支。',
    },
    assignments,
    branches: [
      {
        id: 'extra-branch',
        parentId: 'root-1',
        label: '新增分支',
        description: '修复输出新增的材料分支。',
        sourceIds:
          mode === 'source' ? ['missing-source'] : ['root-1', 'root-4'],
      },
    ],
    relations: [],
  };
}

function createProvider(mode: HierarchyMode, duplicateLabels = false) {
  const requests: RequestBody[] = [];
  const initial = initialDigestPayload();
  if (duplicateLabels) initial.concepts[3]!.label = initial.concepts[2]!.label;
  const initialSnapshot = JSON.parse(JSON.stringify(initial));
  const digestStore = createMemoryStore<DocumentDigest>();
  const intermediateStore = createMemoryStore<unknown>();
  let chunkCalls = 0;
  let finalCalls = 0;
  let repairCalls = 0;

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as { messages?: Array<{ role?: string; content?: string }> };
    requests.push(request);
    const prompt = request.messages?.[1]?.content ?? '';
    if (prompt.includes('分析以下 PDF 分块')) {
      chunkCalls += 1;
      return streamResponse(reply(DOCUMENT_ID, 1));
    }
    if (prompt.includes('仅修复以下脑图结构')) {
      repairCalls += 1;
      return streamResponse(repairPayload(mode));
    }
    finalCalls += 1;
    return streamResponse(initial);
  }) as typeof fetch;

  const provider = createKnowledgeProviderForSettings(
    settings,
    fetchImpl,
    createKnowledgeDigestCache(digestStore),
    intermediateStore,
  );
  return {
    provider,
    requests,
    initial,
    initialSnapshot,
    digestStore,
    intermediateStore,
    get calls() {
      return { chunkCalls, finalCalls, repairCalls };
    },
  };
}

function documentInput() {
  return {
    documentId: DOCUMENT_ID,
    fingerprint: 'hierarchy-retry-normalization',
    fileName: FILE_NAME,
    pages: paperPages,
  };
}

void test('a structure repair may omit duplicate renames without dropping facts or making a third model request', async () => {
  const mock = createProvider('success', true);
  const digest = await mock.provider.analyzeDocument(documentInput());
  assert.deepEqual(mock.calls, {chunkCalls:1,finalCalls:1,repairCalls:1});
  assert.equal(digest.concepts.length, ROOT_IDS.length + 1);
  assert.equal(new Set(digest.concepts.map(node => node.label)).size, digest.concepts.length);
  for (let index = 0; index < ROOT_IDS.length; index += 1) {
    assert.ok(digest.concepts.some(node => node.description === `事实说明 ${index + 1}`));
  }
  assert.deepEqual(mock.initial, mock.initialSnapshot);
});

void test('duplicate labels alone are qualified locally using original context and sources', async () => {
  const initial = initialDigestPayload();
  const draft = {
    ...initial,
    hierarchy: {mode:'structured',reason:'明确三级结构。'},
    concepts: initial.concepts.slice(0,4).map((node,index)=>({
      ...node, parentId:index===0?null:index===1?ROOT_IDS[0]:ROOT_IDS[1],
      label:index>=2?'同名要点':node.label,
    })),
    relations: [],
  };
  let calls=0;
  const provider=createKnowledgeProviderForSettings(settings,async()=>streamResponse(++calls===1?reply(DOCUMENT_ID,1):draft),createKnowledgeDigestCache(createMemoryStore()),createMemoryStore());
  const digest=await provider.analyzeDocument(documentInput());
  assert.equal(calls,2);
  assert.equal(digest.concepts.length,4);
  assert.equal(new Set(digest.concepts.map(node=>node.label)).size,4);
  assert.deepEqual(digest.concepts.map(node=>node.description),draft.concepts.map(node=>node.description));
  assert.ok(digest.concepts.filter(node=>node.label.startsWith('同名要点')).every(node=>node.label.includes('第1页')));
});

void test('reversed containment directions and excess depth are repaired locally without another model call', async () => {
  const initial = initialDigestPayload();
  const draft = {
    ...initial,
    hierarchy: { mode: 'structured', reason: '章节、小节与要点已有明确 parentId。' },
    concepts: initial.concepts.slice(0, 4).map((node, index) => ({
      ...node,
      parentId: index === 0 ? null : ROOT_IDS[index - 1],
      label: index >= 2 ? '重复要点' : node.label,
    })),
    relations: [1, 2, 3].map(index => ({
      from: ROOT_IDS[index], to: ROOT_IDS[index - 1], label: '包含',
    })),
  };
  const snapshot = structuredClone(draft);
  let calls = 0;
  const provider = createKnowledgeProviderForSettings(settings, async () => {
    calls += 1;
    return streamResponse(calls === 1 ? reply(DOCUMENT_ID, 1) : draft);
  }, createKnowledgeDigestCache(createMemoryStore()), createMemoryStore());
  const digest = await provider.analyzeDocument(documentInput());
  assert.equal(calls, 2, 'chunk and final only; format repair must not add a model request');
  assert.equal(digest.concepts.length, 4);
  assert.deepEqual(digest.concepts.map(node => node.description), draft.concepts.map(node => node.description));
  assert.deepEqual(draft, snapshot);
  assert.ok(digest.diagnostics?.some(item => item.detail.includes('反向包含边')));
  for (const relation of digest.relations.filter(edge => edge.label === '包含')) {
    assert.equal(digest.concepts.find(node => node.id === relation.to)?.parentId, relation.from);
  }
});

void test('normalizes a depth-four repair candidate while retaining facts, sources, cross-links and branches', async () => {
  const mock = createProvider('success');
  const digest = await mock.provider.analyzeDocument(documentInput());

  assert.deepEqual(mock.calls, {
    chunkCalls: 1,
    finalCalls: 1,
    repairCalls: 1,
  });
  assert.equal(
    mock.requests.length,
    3,
    'chunk + final synthesis + one hierarchy repair',
  );
  assert.deepEqual(digest.sourcePages, [1]);
  assert.equal(digest.concepts.length, ROOT_IDS.length + 1);

  const byLabel = new Map(
    digest.concepts.map((concept) => [concept.label, concept]),
  );
  for (const [index] of ROOT_IDS.entries()) {
    const node = byLabel.get(`原始事实 ${index + 1}`);
    assert.ok(node, `original fact ${index + 1} must remain`);
    assert.equal(node.description, `事实说明 ${index + 1}`);
    assert.deepEqual(
      node.sources.map((item) => ({
        documentId: item.documentId,
        fileName: item.fileName,
        pageStart: item.pageStart,
        pageEnd: item.pageEnd,
      })),
      [
        {
          documentId: DOCUMENT_ID,
          fileName: FILE_NAME,
          pageStart: 1,
          pageEnd: 1,
        },
      ],
    );
  }
  const extra = byLabel.get('新增分支');
  assert.ok(extra, 'repair-added branch must remain');
  assert.equal(extra.description, '修复输出新增的材料分支。');

  const root1 = byLabel.get('原始事实 1')!;
  const root2 = byLabel.get('原始事实 2')!;
  const root3 = byLabel.get('原始事实 3')!;
  const root4 = byLabel.get('原始事实 4')!;
  assert.equal(root2.parentId, root1.id);
  assert.equal(root3.parentId, root2.id);
  assert.equal(
    root4.parentId,
    root2.id,
    'depth-four root-4 should be promoted to root-2',
  );
  assert.equal(extra.parentId, root1.id);
  assert.ok(
    digest.relations.some(
      (relation) =>
        relation.from === root1.id &&
        relation.to === root2.id &&
        relation.label === '依赖',
    ),
  );
  assert.ok(
    digest.relations.some(
      (relation) =>
        relation.from === root3.id &&
        relation.to === root4.id &&
        relation.label === '对比',
    ),
  );
  assert.ok(
    digest.relations.some(
      (relation) =>
        relation.from === root3.id &&
        relation.to === root4.id &&
        relation.label === '组成',
    ),
  );
  assert.deepEqual(
    mock.initial,
    mock.initialSnapshot,
    'repair must not mutate the original draft',
  );
});

void test('cyclic or unknown-source repairs are rejected without another API call or a digest mutation', async () => {
  for (const mode of ['cycle', 'source'] as const) {
    const mock = createProvider(mode);
    await assert.rejects(
      mock.provider.analyzeDocument(documentInput()),
      (error: unknown) => {
        assert.ok(error instanceof KnowledgeError);
        assert.equal(error.code, 'invalid_output');
        return true;
      },
    );
    assert.deepEqual(
      mock.calls,
      { chunkCalls: 1, finalCalls: 1, repairCalls: 1 },
      mode,
    );
    assert.equal(
      mock.requests.length,
      3,
      `${mode} must not trigger a third repair request`,
    );
    assert.equal(await mock.digestStore.keys().then((keys) => keys.length), 0);
    assert.deepEqual(
      mock.initial,
      mock.initialSnapshot,
      `${mode} must not mutate the original draft`,
    );
  }
});
