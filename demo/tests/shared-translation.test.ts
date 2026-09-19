import assert from 'node:assert/strict';
import test from 'node:test';

import { PROMPT_VERSION } from '../lib/translation.ts';
import {
  findRestorableSharedTranslation,
  sharedTranslationFromCache,
  type SharedTranslationRecord,
} from '../lib/shared-translation.ts';

function record(
  overrides: Partial<SharedTranslationRecord>,
): SharedTranslationRecord {
  return sharedTranslationFromCache(
    {
      fingerprint: 'fp-math',
      pageNumber: 3,
      sourceHash: 'a'.repeat(64),
      paragraphs: ['绕 z 轴旋转 φ。'],
      targetLanguage: '简体中文',
      provider: 'openai-compatible',
      model: 'glm-4.7-flashx',
      updatedAt: '2026-09-19T01:00:00.000Z',
      ...overrides,
    },
    'course-document',
  );
}

void test('restorable records require the current prompt version', () => {
  const current = record({});
  const stale = record({
    paragraphs: ['绕 z 轴旋转。'], // pre-fix translation lost the symbol
    promptVersion: PROMPT_VERSION - 1,
    updatedAt: '2026-09-20T01:00:00.000Z',
  });
  const restored = findRestorableSharedTranslation([stale, current], {
    fingerprint: 'fp-math',
    pageNumber: 3,
    targetLanguage: '简体中文',
  });
  assert.ok(restored);
  assert.equal(restored.promptVersion, PROMPT_VERSION);
  assert.deepEqual(restored.paragraphs, ['绕 z 轴旋转 φ。']);
});

void test('stale records alone do not restore; other pages never match', () => {
  const stale = record({ promptVersion: PROMPT_VERSION - 1 });
  assert.equal(
    findRestorableSharedTranslation([stale], {
      fingerprint: 'fp-math',
      pageNumber: 3,
      targetLanguage: '简体中文',
    }),
    undefined,
  );
  const current = record({});
  assert.equal(
    findRestorableSharedTranslation([current], {
      fingerprint: 'fp-math',
      pageNumber: 4,
      targetLanguage: '简体中文',
    }),
    undefined,
  );
  assert.equal(
    findRestorableSharedTranslation([current], {
      fingerprint: 'fp-other',
      pageNumber: 3,
      targetLanguage: '简体中文',
    }),
    undefined,
  );
  assert.equal(
    findRestorableSharedTranslation([current], {
      fingerprint: 'fp-math',
      pageNumber: 3,
      targetLanguage: '日本語',
    }),
    undefined,
  );
});

void test('the newest record of several current versions wins', () => {
  const older = record({ updatedAt: '2026-09-18T01:00:00.000Z' });
  const newer = record({
    paragraphs: ['绕 z 轴旋转 φ（重新翻译）。'],
    updatedAt: '2026-09-19T02:00:00.000Z',
  });
  const restored = findRestorableSharedTranslation([older, newer], {
    fingerprint: 'fp-math',
    pageNumber: 3,
    targetLanguage: '简体中文',
  });
  assert.deepEqual(restored?.paragraphs, ['绕 z 轴旋转 φ（重新翻译）。']);
});
