import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_GLOSSARY,
  MAX_GLOSSARY_ENTRIES,
  checkTerminology,
  containsTerm,
  exportGlossary,
  glossaryFingerprint,
  glossaryPrompt,
  importGlossary,
  parseGlossary,
  reviseGlossary,
  type TermPassage,
} from '../lib/glossary.ts';
import {
  createOpenAICompatibleProvider,
  translationCacheKey,
  type TranslationProvider,
} from '../lib/translation.ts';
import {
  createMemoryStore,
  createTranslationCache,
  findCachedPageTranslation,
  resolvePageTranslation,
  type CachedTranslation,
} from '../lib/reader-cache.ts';
import {
  cachedTranslationFromShared,
  findRestorableSharedTranslation,
  sharedTranslationFromCache,
  sharedTranslationIdentity,
  validateSharedTranslation,
} from '../lib/shared-translation.ts';
import { translateSelection } from '../lib/selection-translation.ts';
import { MemoryCourseStorage } from '../lib/course-storage/memory-course-storage.ts';
import { auditCourseTerminology } from '../lib/glossary-audit.ts';

const entry = {
  source: 'momentum',
  target: '动量',
  forbidden: ['冲量'],
  note: '力学术语',
};
const glossary = reviseGlossary(EMPTY_GLOSSARY, [entry]);

void test('glossary JSON version, edits and validation roundtrip without mutating input', async () => {
  assert.deepEqual(importGlossary(exportGlossary(glossary)), glossary);
  assert.equal(glossary.version, 1);
  assert.equal(EMPTY_GLOSSARY.entries.length, 0);
  assert.equal(await glossaryFingerprint(EMPTY_GLOSSARY), '');
  assert.notEqual(
    await glossaryFingerprint(glossary),
    await glossaryFingerprint(reviseGlossary(glossary, [entry])),
  );
  assert.notEqual(
    await glossaryFingerprint(glossary),
    await glossaryFingerprint({
      ...glossary,
      entries: [{ ...entry, target: '线动量' }],
    }),
  );
  assert.throws(() => parseGlossary({ ...glossary, schemaVersion: 2 }));
  assert.throws(
    () => parseGlossary({ ...glossary, entries: [entry, entry] }),
    /重复/,
  );
  assert.throws(
    () =>
      parseGlossary({
        ...glossary,
        entries: [{ ...entry, forbidden: ['动量'] }],
      }),
    /不能同时/,
  );
  assert.throws(() => importGlossary('{broken'));
});

void test('empty and oversized glossaries never silently truncate rules or prompt', () => {
  assert.equal(glossaryPrompt(EMPTY_GLOSSARY, 'momentum'), '');
  assert.deepEqual(checkTerminology(EMPTY_GLOSSARY, []), []);
  const entries = Array.from({ length: MAX_GLOSSARY_ENTRIES }, (_, i) => ({
    ...entry,
    source: `term${i}`,
  }));
  assert.equal(parseGlossary({ ...glossary, entries }).entries.length, 1000);
  assert.throws(
    () => parseGlossary({ ...glossary, entries: [...entries, entry] }),
    /1000/,
  );
  assert.throws(() => importGlossary(' '.repeat(512001)), /512/);
  assert.throws(
    () =>
      glossaryPrompt(
        { ...glossary, entries },
        entries.map((item) => item.source).join(' '),
      ),
    /容量/,
  );
  assert.ok(
    glossaryPrompt({ ...glossary, entries }, 'term999').includes('term999'),
  );
  assert.ok(
    !glossaryPrompt({ ...glossary, entries }, 'term999').includes('term998'),
  );
});

void test('literal matching distinguishes symbols, words and case; audit locates registered variants', () => {
  assert.equal(containsTerm('massive', 'mass'), false);
  assert.equal(containsTerm('V', 'v'), false);
  assert.equal(containsTerm('速度 v 和 v_1', 'v'), true);
  const passage: TermPassage = {
    documentId: 'd',
    fileName: 'a.pdf',
    pageNumber: 2,
    paragraph: 3,
    kind: 'translation',
    source: 'momentum rises',
    text: '冲量增大',
  };
  const issues = checkTerminology(glossary, [
    passage,
    { ...passage, pageNumber: 1, text: '动量增大' },
    { ...passage, pageNumber: 4, text: '动能增大' },
  ]);
  assert.deepEqual(
    issues.map((issue) => [issue.pageNumber, issue.paragraph, issue.reason]),
    [
      [2, 3, 'forbidden'],
      [4, 3, 'missing-target'],
    ],
  );
  assert.equal(
    checkTerminology(glossary, [
      { ...passage, source: 'massive', text: '质量很大' },
    ]).length,
    0,
  );
});

void test('mock HTTP translation and selection inject glossary while preserving scientific placeholders', async () => {
  const systems: string[] = [];
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://offline.test/v1',
    apiKey: 'fake',
    model: 'test',
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      );
      systems.push(body.messages[0].content);
      const text = body.messages[1].content
        .split('---\n')[1]
        .replace('momentum', '动量');
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n`,
      );
    }) as typeof fetch,
  });
  const source = 'momentum $p_i = mv_i$ at 10 m/s';
  const result = await provider.translate({
    text: source,
    pageNumber: 1,
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    glossary,
  });
  assert.equal(result.paragraphs[0], source.replace('momentum', '动量'));
  await translateSelection(
    provider,
    { text: source, pageNumber: 2, glossary },
    'zh',
  );
  for (const system of systems) {
    assert.match(
      system,
      /"source":"momentum","target":"动量","forbidden":\["冲量"\]/,
    );
    assert.match(system, /力学术语/);
    assert.match(system, /YYKEEP/);
    assert.match(system, /subscripts, superscripts, and units/);
  }
});

void test('cache fingerprint isolates edits, clear and legacy paths including published restoration', async () => {
  let calls = 0;
  const provider: TranslationProvider = {
    id: 'mock',
    model: 'test',
    async translate(request) {
      calls++;
      return {
        paragraphs: [request.glossary?.entries[0]?.target ?? '旧译文'],
        provider: 'mock',
        model: 'test',
      };
    },
  };
  const store = createMemoryStore<CachedTranslation>();
  const cache = createTranslationCache(store);
  const base = {
    provider,
    cache,
    fingerprint: 'doc',
    request: {
      text: 'momentum',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      pageNumber: 1,
    },
  };
  const old = await resolvePageTranslation(base);
  const published = sharedTranslationFromCache(old.cacheEntry, 'd');
  const current = await resolvePageTranslation({
    ...base,
    request: { ...base.request, glossary },
    publishedTranslations: [published],
  });
  assert.equal(current.source, 'generated');
  assert.deepEqual(current.cacheEntry.sourceParagraphs, ['momentum']);
  assert.equal(
    (
      await resolvePageTranslation({
        ...base,
        request: { ...base.request, glossary },
      })
    ).status,
    'cached',
  );
  const changed = reviseGlossary(glossary, [{ ...entry, target: '线动量' }]);
  const next = await resolvePageTranslation({
    ...base,
    request: { ...base.request, glossary: changed },
  });
  assert.notEqual(next.cacheEntry.key, current.cacheEntry.key);
  const cleared = reviseGlossary(changed, []);
  assert.equal(
    (
      await resolvePageTranslation({
        ...base,
        request: { ...base.request, glossary: cleared },
      })
    ).source,
    'generated',
  );
  assert.equal(calls, 4);
  assert.equal((await resolvePageTranslation(base)).status, 'cached');
  const parts = {
    cache,
    fingerprint: 'doc',
    pageNumber: 1,
    targetLanguage: 'zh',
    provider: 'mock',
    model: 'test',
  };
  assert.equal(
    (await findCachedPageTranslation(parts))?.paragraphs[0],
    '旧译文',
  );
  assert.equal(
    (
      await findCachedPageTranslation({
        ...parts,
        glossaryFingerprint: await glossaryFingerprint(glossary),
      })
    )?.paragraphs[0],
    '动量',
  );
  assert.equal(
    findRestorableSharedTranslation([published], {
      ...parts,
      glossaryFingerprint: await glossaryFingerprint(glossary),
    }),
    undefined,
  );
  const shared = sharedTranslationFromCache(current.cacheEntry, 'd');
  assert.equal(
    validateSharedTranslation(shared)?.glossaryFingerprint,
    current.cacheEntry.glossaryFingerprint,
  );
  assert.equal(
    cachedTranslationFromShared(shared).glossaryFingerprint,
    current.cacheEntry.glossaryFingerprint,
  );
  assert.notEqual(
    sharedTranslationIdentity(shared),
    sharedTranslationIdentity(published),
  );
  assert.ok(validateSharedTranslation(published));
  assert.equal(
    validateSharedTranslation({ ...shared, glossaryFingerprint: 'bad' }),
    null,
  );
  assert.notEqual(
    translationCacheKey({
      sourceHash: 's',
      targetLanguage: 'zh',
      provider: 'p',
      model: 'm',
    }),
    translationCacheKey({
      sourceHash: 's',
      targetLanguage: 'zh',
      provider: 'p',
      model: 'm',
      glossaryFingerprint: 'f',
    }),
  );
  await store.set('old-malformed', {} as CachedTranslation);
  assert.equal((await cache.list()).length, 4);
});

void test('course audit reports coverage, latest paragraphs, document scope and old cache limits', async () => {
  const storage = new MemoryCourseStorage();
  const bundle = await storage.initialize('力学');
  await storage.saveGlossary(glossary);
  assert.deepEqual(await storage.loadGlossary(), glossary);
  bundle.manifest.documents = [
    { id: 'd', fingerprint: 'f', fileName: 'a.pdf', pageCount: 3 } as never,
  ];
  const cached = {
    fingerprint: 'f',
    pageNumber: 2,
    paragraphs: ['冲量'],
    sourceParagraphs: ['momentum'],
    targetLanguage: 'zh',
    updatedAt: '2026-01-02',
  } as CachedTranslation;
  const report = auditCourseTerminology(bundle, glossary, [
    { ...cached, paragraphs: ['动量'], updatedAt: '2026-01-01' },
    cached,
  ]);
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].pageNumber, 2);
  assert.equal(report.translatedPages, 1);
  assert.equal(report.sourceAlignedPages, 1);
  assert.equal(report.totalPages, 3);
  assert.equal(
    auditCourseTerminology(bundle, glossary, [cached], 'other').issues.length,
    0,
  );
  const old = auditCourseTerminology(bundle, glossary, [
    { ...cached, sourceParagraphs: undefined },
  ]);
  assert.equal(old.sourceAlignedPages, 0);
  assert.equal(old.issues.length, 1);
  await storage.deleteCourse();
  await storage.initialize('另一门课程');
  assert.deepEqual(await storage.loadGlossary(), EMPTY_GLOSSARY);
});

void test('oversized matching glossary fails before any mock provider HTTP request', async () => {
  let calls = 0;
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://offline.test',
    apiKey: 'fake',
    model: 'test',
    fetchImpl: (async () => {
      calls++;
      throw new Error('unexpected network');
    }) as typeof fetch,
  });
  const entries = Array.from({ length: 1000 }, (_, i) => ({
    ...entry,
    source: `term${i}`,
  }));
  await assert.rejects(
    provider.translate({
      text: entries.map((item) => item.source).join(' '),
      pageNumber: 1,
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      glossary: { ...glossary, entries },
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'invalid_input',
  );
  assert.equal(calls, 0);
});
