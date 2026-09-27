import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
  KnowledgeError,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import type { DocumentDigest } from '../lib/course-storage/types.ts';
import { legacyLongDigest, settings } from './fixtures/hierarchical-synthesis.ts';

function streamResponse(value: unknown): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })}\n`,
    'data: [DONE]\n',
  ].join('\n');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function courseDigests(): DocumentDigest[] {
  return ['alpha', 'beta', 'gamma'].map((id) => legacyLongDigest(id));
}

function sourceFromPrompt(prompt: string, page = 1) {
  const documentId = /"documentId":"([^"]+)"/.exec(prompt)?.[1] ?? 'alpha';
  const promptPage = /"pageStart":(\d+)/.exec(prompt)?.[1];
  const pageStart = page === 1 && promptPage ? Number(promptPage) : page;
  return { documentId, pageStart, pageEnd: pageStart };
}

function intermediateReply(prompt: string, sequence: number, source = sourceFromPrompt(prompt)) {
  return {
    theme: `中间主题 ${sequence}`,
    concepts: [{
      id: `intermediate-${sequence}`,
      parentId: 'parent-from-another-batch',
      label: `中间概念 ${sequence}`,
      description: '本批保留的事实。',
      sources: [source],
    }],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
  };
}

function validFinalReply() {
  const source = (documentId: string, pageStart: number) => ({
    documentId,
    pageStart,
    pageEnd: pageStart,
  });
  return {
    hierarchy: { mode: 'structured', reason: '课程材料按主题、分支和要点组织。' },
    theme: '课程主题',
    concepts: [
      {
        id: 'root',
        parentId: null,
        label: '总主题',
        description: '跨文档主题。',
        sources: [source('alpha', 1)],
      },
      {
        id: 'branch',
        parentId: 'root',
        label: '一级分支',
        description: '跨文档分支。',
        sources: [source('beta', 2)],
      },
      {
        id: 'leaf',
        parentId: 'branch',
        label: '关键要点',
        description: '有来源的关键要点。',
        sources: [source('gamma', 3)],
      },
    ],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
  };
}

function invalidFinalReply(kind: 'orphan' | 'cycle') {
  const source = { documentId: 'alpha', pageStart: 1, pageEnd: 1 };
  const parentIds = kind === 'orphan'
    ? { first: null, second: 'missing-parent', third: 'second' }
    : { first: 'second', second: 'first', third: null };
  return {
    hierarchy: { mode: 'structured', reason: '课程材料声称有层级。' },
    theme: '错误课程主题',
    concepts: [
      { id: 'first', parentId: parentIds.first, label: '第一节点', description: '节点一。', sources: [source] },
      { id: 'second', parentId: parentIds.second, label: '第二节点', description: '节点二。', sources: [source] },
      { id: 'third', parentId: parentIds.third, label: '第三节点', description: '节点三。', sources: [source] },
    ],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
  };
}

function createProvider(options: {
  intermediateSource?: (prompt: string, sequence: number) => { documentId: string; pageStart: number; pageEnd: number };
  finalReply?: unknown;
} = {}) {
  let intermediateSequence = 0;
  const requests: string[] = [];
  let intermediateCount = 0;
  let intermediateRetries = 0;
  let finalCount = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const prompt = body.messages?.[1]?.content ?? '';
    requests.push(prompt);
    const intermediate = prompt.includes('当前只是中间压缩') || prompt.includes('这是分层中间归并');
    if (intermediate) {
      if (body.messages?.some((message) => message.role === 'assistant' && message.content?.includes('上次输出未通过校验'))) {
        intermediateRetries += 1;
      }
      const sequence = intermediateSequence++;
      intermediateCount += 1;
      const source = options.intermediateSource?.(prompt, sequence) ?? sourceFromPrompt(prompt);
      return streamResponse(intermediateReply(prompt, sequence, source));
    }
    finalCount += 1;
    return streamResponse(options.finalReply ?? validFinalReply());
  }) as typeof fetch;
  const provider = createKnowledgeProviderForSettings(
    settings,
    fetchImpl,
    createKnowledgeDigestCache(createMemoryStore<DocumentDigest>()),
    createMemoryStore<unknown>(),
  );
  return {
    provider,
    requests,
    get intermediateCount() { return intermediateCount; },
    get intermediateRetries() { return intermediateRetries; },
    get finalCount() { return finalCount; },
  };
}

function courseInput(digests = courseDigests()) {
  return {
    courseId: 'course',
    courseName: '长课程',
    digests,
  };
}

void test('large courses accept intermediate JSON without hierarchy or batch-global parents', async () => {
  const m = createProvider();
  const result = await m.provider.synthesizeCourseKnowledge(courseInput());

  assert.ok(m.intermediateCount >= 2, `expected multiple intermediate batches, got ${m.intermediateCount}`);
  assert.equal(m.finalCount, 1);
  assert.ok(result.nodes.some((node) => node.parentId), 'final hierarchy should retain nested nodes');
  assert.ok(m.requests.some((prompt) => prompt.includes('当前只是中间压缩')));
});

void test('long restored source metadata does not trigger intermediate retries and remains fully sourced', async () => {
  const digests = courseDigests();
  // The restored source and provenance together exceed the 10 KiB intermediate
  // limit, while the model-controlled content remains tiny.
  const longFileName = `${'长'.repeat(1800)}.pdf`;
  const [first, second, third] = digests;
  assert.ok(first && second && third);
  first.concepts[0]!.sources[0]!.fileName = longFileName;
  first.sections = [];
  first.sourcePages = [1];
  second.sections = Array.from({ length: 3 }, (_, index) => ({
    id: `beta-section-${index}`,
    title: `批次章节 ${index + 1}`,
    summary: '批次资料。'.repeat(500),
    pageStart: index + 1,
    pageEnd: index + 1,
  }));
  second.sourcePages = [1, 2, 3];
  third.sections = [
    { id: 'gamma-section', title: '短章节', summary: '保留的短材料。', pageStart: 3, pageEnd: 3 },
  ];
  third.concepts[0]!.sources[0]!.pageStart = 3;
  third.concepts[0]!.sources[0]!.pageEnd = 3;
  third.sourcePages = [1, 2, 3];

  const m = createProvider();
  const result = await m.provider.synthesizeCourseKnowledge(courseInput(digests));

  assert.ok(m.intermediateCount >= 2);
  assert.equal(m.intermediateRetries, 0);
  assert.equal(m.finalCount, 1);
  assert.ok(
    result.nodes.some((node) => node.sources.some((source) => source.fileName === longFileName)),
    'application-restored source metadata should be retained in the final course result',
  );
});

void test('intermediate sources still reject unknown documents and pages outside the input', async () => {
  for (const scenario of ['unknown-document', 'out-of-range'] as const) {
    const m = createProvider({
      intermediateSource: (prompt) => scenario === 'unknown-document'
        ? { documentId: 'not-in-course', pageStart: 1, pageEnd: 1 }
        : { ...sourceFromPrompt(prompt), pageStart: 999, pageEnd: 999 },
    });
    await assert.rejects(
      m.provider.synthesizeCourseKnowledge(courseInput()),
      (error: unknown) => {
        assert.ok(error instanceof KnowledgeError);
        if (scenario === 'unknown-document') assert.equal(error.code, 'invalid_output');
        else assert.equal(error.code, 'invalid_source_pages');
        return true;
      },
    );
    assert.equal(m.finalCount, 0);
  }
});

void test('final course hierarchy still rejects orphan and cyclic parent relationships', async () => {
  for (const kind of ['orphan', 'cycle'] as const) {
    const m = createProvider({ finalReply: invalidFinalReply(kind) });
    await assert.rejects(
      m.provider.synthesizeCourseKnowledge(courseInput()),
      (error: unknown) => error instanceof KnowledgeError && error.code === 'invalid_output',
    );
    assert.equal(m.finalCount, 2, `${kind} should receive one structural repair retry`);
  }
});
