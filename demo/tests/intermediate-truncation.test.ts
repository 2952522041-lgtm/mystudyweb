import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKnowledgeDigestCache,
  createKnowledgeProviderForSettings,
  KnowledgeError,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import type { DocumentDigest } from '../lib/course-storage/types.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import { synthesisSources } from '../lib/knowledge/hierarchical-synthesis.ts';
import {
  legacyLongDigest,
  settings,
} from './fixtures/hierarchical-synthesis.ts';

const GLM_SETTINGS = { ...settings, model: 'glm-4.6v' };
const CRITICAL_EVIDENCE = '关键课程证据：公式、适用条件和原文页码必须保留。';
const PARTIAL_OUTPUT = '{"theme":"partial intermediate output"';

type Message = { role?: string; content?: string };
type RequestBody = { messages?: Message[]; max_tokens?: number; model?: string };
type RequestRecord = RequestBody & { intermediate: boolean; final: boolean; finishReason?: string };

function streamResponse(content: string, finishReason = 'stop'): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n`,
    'data: [DONE]\n',
  ].join('\n');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function parseInputRecords(prompt: string): unknown[] {
  for (const line of prompt.split('\n')) {
    if (!line.trimStart().startsWith('[')) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (Array.isArray(value)) return value;
    } catch {
      // The schema example is not the input records array.
    }
  }
  return [];
}

function sourceFileNamesForPrompt(prompt: string): Record<string, string> {
  const line = prompt.split('\n').find((value) => value.startsWith('文档身份映射'));
  if (!line) return {};
  const raw = line.slice(line.indexOf('：') + 1);
  const entries = JSON.parse(raw) as Array<{ documentId: string; fileName: string }>;
  return Object.fromEntries(entries.map((entry) => [entry.documentId, entry.fileName]));
}

function courseDigests(): DocumentDigest[] {
  return ['alpha', 'beta', 'gamma'].map((documentId, index) => {
    const digest = legacyLongDigest(documentId);
    if (index === 0) {
      digest.evidence = [{
        text: CRITICAL_EVIDENCE,
        sources: [{
          documentId,
          fileName: `${documentId}.pdf`,
          pageStart: 1,
          pageEnd: 1,
          type: 'pdf',
        }],
      }];
    }
    return digest;
  });
}

function sourceForPrompt(prompt: string) {
  const records = parseInputRecords(prompt);
  const allowed = synthesisSources(records, undefined, sourceFileNamesForPrompt(prompt));
  return allowed[0] ?? {
    documentId: 'alpha',
    fileName: 'alpha.pdf',
    pageStart: 1,
    pageEnd: 1,
    type: 'pdf' as const,
  };
}

function compactIntermediate(prompt: string): string {
  const source = sourceForPrompt(prompt);
  return JSON.stringify({
    theme: '紧凑中间主题',
    concepts: [{
      id: 'intermediate-concept',
      parentId: null,
      label: '中间概念',
      description: '压缩后的独有事实。',
      sources: [{
        documentId: source.documentId,
        pageStart: source.pageStart,
        pageEnd: source.pageEnd ?? source.pageStart,
      }],
    }],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
  });
}

function finalCourse(prompt: string): string {
  const sources = synthesisSources(parseInputRecords(prompt), undefined, sourceFileNamesForPrompt(prompt));
  const outputSources = (sources.length ? sources : [sourceForPrompt(prompt)]).map((source) => ({
    documentId: source.documentId,
    fileName: source.fileName,
    pageStart: source.pageStart,
    pageEnd: source.pageEnd ?? source.pageStart,
  }));
  return JSON.stringify({
    hierarchy: { mode: 'flat', reason: '长讲义夹具仅保留并列主题。' },
    theme: '课程最终主题',
    concepts: [{
      id: 'course-concept',
      parentId: null,
      label: '课程主题',
      description: '最终课程概念。',
      sources: outputSources,
    }],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
  });
}

type MockMode = 'first-intermediate-length' | 'same-intermediate-length' | 'final-length';

function createCourseMock(mode: MockMode) {
  const requests: RequestRecord[] = [];
  const intermediateStore = createMemoryStore<unknown>();
  let firstIntermediatePrompt: string | undefined;
  let finalCalls = 0;

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as RequestBody;
    const prompt = body.messages?.[1]?.content ?? '';
    const intermediate = prompt.includes('当前只是中间压缩') || prompt.includes('这是分层中间归并');
    const final = !intermediate;
    const retry = body.messages?.some((message) =>
      message.role === 'assistant' && (
        message.content?.includes('上次输出未通过校验')
        || message.content?.includes('上次中间输出达到长度上限')
      )) ?? false;

    if (intermediate && !firstIntermediatePrompt) firstIntermediatePrompt = prompt;
    let finishReason = 'stop';
    let content = compactIntermediate(prompt);
    if (intermediate && (mode === 'same-intermediate-length' ||
      (mode === 'first-intermediate-length' && !retry && prompt === firstIntermediatePrompt))) {
      finishReason = 'length';
      content = PARTIAL_OUTPUT;
    }
    if (final && mode === 'final-length') {
      finishReason = 'length';
      content = '{"theme":"partial final output"';
      finalCalls += 1;
    } else if (final) {
      finalCalls += 1;
      content = finalCourse(prompt);
    }
    requests.push({ ...body, intermediate, final, finishReason });
    return streamResponse(content, finishReason);
  }) as typeof fetch;

  const provider = createKnowledgeProviderForSettings(
    GLM_SETTINGS,
    fetchImpl,
    createKnowledgeDigestCache(createMemoryStore()),
    intermediateStore,
  );
  return { provider, requests, intermediateStore, get finalCalls() { return finalCalls; } };
}

function courseInput() {
  return {
    courseId: 'truncation-course',
    courseName: '长讲义课程',
    digests: courseDigests(),
  };
}

void test('limits GLM intermediate output to 8192, retries one length response, and retains evidence', async () => {
  const mock = createCourseMock('first-intermediate-length');
  const result = await mock.provider.synthesizeCourseKnowledge(courseInput());

  const intermediate = mock.requests.filter((request) => request.intermediate);
  const final = mock.requests.filter((request) => request.final);
  assert.ok(intermediate.length >= 2);
  assert.deepEqual(new Set(intermediate.map((request) => request.max_tokens)), new Set([8192]));
  assert.deepEqual(new Set(final.map((request) => request.max_tokens)), new Set([32768]));
  assert.equal(intermediate.filter((request) => request.finishReason === 'length').length, 1);
  assert.equal(mock.finalCalls, 1);

  const retry = intermediate.find((request) =>
    request.messages?.some((message) =>
      message.role === 'assistant' && message.content?.includes('上次中间输出达到长度上限')),
  );
  assert.ok(retry, 'the intermediate length response should get one compact retry');
  assert.ok(retry.messages?.every((message) => !message.content?.includes(PARTIAL_OUTPUT)));

  const evidence = result.evidence?.find((item) => item.text === CRITICAL_EVIDENCE);
  assert.ok(evidence);
  assert.deepEqual(evidence.sources.map((source) => [source.documentId, source.fileName, source.pageStart]), [['alpha', 'alpha.pdf', 1]]);
  assert.ok(result.nodes.length > 0);
  assert.ok(result.nodes.some((node) => node.sources.some((source) => source.documentId === 'alpha' && source.fileName === 'alpha.pdf')));
  for (const key of await mock.intermediateStore.keys()) {
    assert.doesNotMatch(JSON.stringify(await mock.intermediateStore.get(key)), /partial intermediate output/);
  }
});

void test('rejects after two intermediate length responses for one identity without producing a final digest', async () => {
  const mock = createCourseMock('same-intermediate-length');
  await assert.rejects(
    mock.provider.synthesizeCourseKnowledge(courseInput()),
    (error: unknown) => error instanceof KnowledgeError && error.code === 'truncated',
  );

  const truncated = mock.requests.filter((request) => request.finishReason === 'length' && request.intermediate);
  assert.equal(truncated.length, 2);
  assert.equal(new Set(truncated.map((request) => request.messages?.[1]?.content)).size, 1);
  assert.equal(mock.finalCalls, 0);
  for (const key of await mock.intermediateStore.keys()) {
    assert.doesNotMatch(JSON.stringify(await mock.intermediateStore.get(key)), /partial intermediate output/);
  }
});

void test('final GLM truncation is rejected without an additional final retry', async () => {
  const mock = createCourseMock('final-length');
  await assert.rejects(
    mock.provider.synthesizeCourseKnowledge(courseInput()),
    (error: unknown) => error instanceof KnowledgeError && error.code === 'truncated',
  );

  const final = mock.requests.filter((request) => request.final);
  assert.equal(final.length, 1);
  assert.equal(final[0]?.max_tokens, 32768);
  assert.equal(final[0]?.finishReason, 'length');
  assert.equal(final[0]?.messages?.some((message) => message.role === 'assistant'), false);
  assert.equal(mock.finalCalls, 1);
});
