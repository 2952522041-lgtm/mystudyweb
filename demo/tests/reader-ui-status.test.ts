import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  countTranslated,
  statusToBadge,
  type TranslationStatus,
} from '../lib/reader-ui-status.ts';

const pageSource = await readFile(
  new URL('../app/page.tsx', import.meta.url),
  'utf8',
);
const styles = await readFile(
  new URL('../app/globals.css', import.meta.url),
  'utf8',
);

void test('every translation status maps to its badge label and tone', () => {
  const expectations: Record<TranslationStatus, [string, string]> = {
    recognizing: ['识别中', 'info'],
    translating: ['翻译中', 'warning'],
    complete: ['已翻译', 'success'],
    cached: ['已缓存', 'neutral'],
    error: ['失败', 'error'],
  };
  for (const [status, [label, tone]] of Object.entries(expectations)) {
    assert.deepEqual(statusToBadge(status as TranslationStatus), {
      label,
      tone,
    });
  }
});

void test('countTranslated returns zero for empty states', () => {
  assert.deepEqual(countTranslated({}, 12), { done: 0, total: 12 });
  assert.deepEqual(countTranslated({}, 0), { done: 0, total: 0 });
});

void test('countTranslated counts only pages with a usable translation', () => {
  const states: Record<string, { status: TranslationStatus }> = {
    '1:简体中文': { status: 'complete' },
    '2:简体中文': { status: 'cached' },
    '3:简体中文': { status: 'translating' },
    '4:简体中文': { status: 'recognizing' },
    '5:简体中文': { status: 'error' },
    '6:简体中文': { status: 'complete' },
  };
  assert.deepEqual(countTranslated(states, 12), { done: 3, total: 12 });
});

void test('countTranslated counts a page once across languages and drops invalid entries', () => {
  const states: Record<string, { status: TranslationStatus }> = {
    '1:English': { status: 'complete' },
    '1:日本語': { status: 'cached' },
    '2:English': { status: 'complete' },
    '13:English': { status: 'complete' }, // outside 1..pageCount
    'page:English': { status: 'complete' }, // malformed key
    ':English': { status: 'complete' }, // missing page number
  };
  assert.deepEqual(countTranslated(states, 12), { done: 2, total: 12 });
});

void test('thumbnails render a translation status badge with tone styling', () => {
  assert.match(
    pageSource,
    /import \{[^}]*statusToBadge[^}]*\} from '@\/lib\/reader-ui-status'/,
  );
  assert.match(pageSource, /translationStatus\?: TranslationStatus;/);
  assert.match(
    pageSource,
    /const badge = translationStatus \? statusToBadge\(translationStatus\) : null;/,
  );
  assert.match(
    pageSource,
    /className=\{`thumbnail-status-badge thumbnail-status-badge-\$\{badge\.tone\}`\}/,
  );
  assert.match(
    pageSource,
    /aria-label=\{`第 \$\{page\} 页翻译状态：\$\{badge\.label\}`\}/,
  );
  // The badge must not sit inside the aria-hidden thumbnail paper.
  assert.match(pageSource, /<\/span>\s*\{badge \? \(/);
  assert.match(styles, /\.thumbnail-thumb \{[^}]*relative block/);
  for (const tone of ['neutral', 'info', 'success', 'warning', 'error']) {
    assert.match(
      styles,
      new RegExp(`\\.thumbnail-status-badge-${tone} \\{[^}]*(bg|text)-`),
    );
  }
});

void test('thumbnail list feeds the per-page translation state into the badge', () => {
  assert.match(
    pageSource,
    /translationStatus=\{\s*translationStates\[\s*translationKey\(pageNumber, targetLanguage\)\s*\]\?\.status\s*\}/,
  );
});

void test('right panel header shows the translated-pages progress', () => {
  assert.match(
    pageSource,
    /countTranslated\(\s*translationStates,\s*docMeta\?\.pageCount \?\? 0,?\s*\)/,
  );
  assert.match(pageSource, /translationProgressLabel = `已翻译 \$\{/);
  assert.match(
    pageSource,
    /className="translation-progress-chip"\s*aria-label=\{`翻译进度：已翻译 \$\{translationProgress\.done\} 页，共 \$\{translationProgress\.total\} 页`\}/,
  );
  assert.match(styles, /\.translation-progress-chip \{[^}]*rounded-full/);
});
