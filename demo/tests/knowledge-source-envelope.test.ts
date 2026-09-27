import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createKnowledgeProviderForSettings,
  createKnowledgeDigestCache,
} from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import { settings, reply } from './fixtures/hierarchical-synthesis.ts';

void test('section envelopes include valid point citations without retrying or changing the point', async () => {
  const payload = {
    ...reply(),
    sections: [
      {
        title: 'C++ strings',
        summary: 'Character literals',
        pageStart: 1,
        pageEnd: 1,
        points: [{ text: 'const char* text = "a";', pageStart: 3, pageEnd: 3 }],
      },
    ],
  };
  const prompts: string[] = [];
  const provider = createKnowledgeProviderForSettings(
    settings,
    async (_url, init) => {
      const body = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      );
      prompts.push(body.messages[1].content);
      const json = JSON.stringify(payload).replace(/\\"a\\"/, '"a"');
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: json }, finish_reason: 'stop' }] })}\n\n`,
      );
    },
    createKnowledgeDigestCache(createMemoryStore()),
    createMemoryStore(),
  );
  const digest = await provider.analyzeDocument({
    documentId: 'lecture',
    fileName: 'lecture.pdf',
    fingerprint: 'e'.repeat(64),
    pages: ['A character literal.', 'A string.', 'const char* text = "a";'],
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /"pageStart":1,"pageEnd":3/);
  assert.equal(digest.sections[0].pageEnd, 3);
  assert.deepEqual(
    digest.sections[0].points?.[0],
    payload.sections[0].points[0],
  );
});

void test('out-of-document point citations remain rejected', async () => {
  const payload = {
    ...reply(),
    sections: [
      {
        title: 'Strings',
        summary: 'Literal',
        pageStart: 1,
        pageEnd: 1,
        points: [{ text: 'An invalid source.', pageStart: 2, pageEnd: 2 }],
      },
    ],
  };
  const provider = createKnowledgeProviderForSettings(
    settings,
    async () =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] })}\n\n`,
      ),
    createKnowledgeDigestCache(createMemoryStore()),
    createMemoryStore(),
  );
  await assert.rejects(
    provider.analyzeDocument({
      documentId: 'lecture',
      fileName: 'lecture.pdf',
      fingerprint: 'f'.repeat(64),
      pages: ['One page only.'],
    }),
    /超出 PDF 实际页码/,
  );
});
