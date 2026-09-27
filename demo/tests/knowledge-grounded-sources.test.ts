import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createKnowledgeProviderForSettings,
  createKnowledgeDigestCache,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import type { DocumentDigest } from '../lib/course-storage/types.ts';
import {
  legacyLongDigest,
  reply,
  settings,
  source,
} from './fixtures/hierarchical-synthesis.ts';

void test('course synthesis grounds broad citations to supplied disjoint ranges without another model call', async () => {
  const digest = legacyLongDigest('lecture');
  digest.sections = [1, 3].map((page) => ({
    id: `s${page}`,
    title: `Section ${page}`,
    summary: 'Known material',
    pageStart: page,
    pageEnd: page,
  }));
  digest.concepts[0].sources = [source('lecture', 1), source('lecture', 3)];
  const result = reply('lecture');
  result.concepts[0].sources = [{ ...source('lecture', 1), pageEnd: 3 }];
  let calls = 0;
  const provider = createKnowledgeProviderForSettings(
    settings,
    (async () => {
      calls++;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch,
    createKnowledgeDigestCache(createMemoryStore<DocumentDigest>()),
    createMemoryStore<unknown>(),
  );
  const knowledge = await provider.synthesizeCourseKnowledge({
    courseId: 'course',
    courseName: 'Course',
    digests: [digest],
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    knowledge.nodes[0].sources.map((s) => [s.pageStart, s.pageEnd]),
    [
      [1, 1],
      [3, 3],
    ],
  );
  assert.equal(knowledge.nodes[0].description, result.concepts[0].description);
  assert.ok(
    knowledge.diagnostics?.some(
      (d) => d.action === 'quality-restored' && d.detail.includes('页码间隙'),
    ),
  );
});
