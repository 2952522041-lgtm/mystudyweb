import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReaderStatusFacts } from '../components/reader-status-facts.ts';

import {
  cacheStatusLabel,
  countTranslated,
  modeLabel,
  statusBarParts,
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
    /countTranslated\(\s*translationStates,\s*docMeta\?\.pageCount \?\? 0,\s*targetLanguage,?\s*\)/,
  );
  assert.match(pageSource, /translationProgressLabel = `已翻译 \$\{/);
  assert.match(
    pageSource,
    /className="translation-progress-chip"\s*aria-label=\{`翻译进度：已翻译 \$\{translationProgress\.done\} 页，共 \$\{translationProgress\.total\} 页`\}/,
  );
  assert.match(styles, /\.translation-progress-chip \{[^}]*rounded-full/);
});

void test('modeLabel maps every right-panel mode to its Chinese label', () => {
  assert.equal(modeLabel('translation'), '页面翻译');
  assert.equal(modeLabel('chat'), 'AI 答疑');
  assert.equal(modeLabel('summary'), 'PDF 总结');
  assert.equal(modeLabel('mindmap'), 'PDF 脑图');
});

void test('statusBarParts composes page position, zoom, mode and progress', () => {
  assert.deepEqual(
    statusBarParts({
      page: 3,
      pageCount: 12,
      zoom: 95,
      mode: 'translation',
      translated: { done: 5, total: 12 },
    }),
    ['第 3/12 页', '95%', '页面翻译', '已翻译 5/12', '缓存：待生成'],
  );
  assert.deepEqual(
    statusBarParts({
      page: 7,
      pageCount: 12,
      zoom: 110,
      mode: 'chat',
      translated: { done: 0, total: 12 },
    }),
    ['第 7/12 页', '110%', 'AI 答疑', '已翻译 0/12', '缓存：待生成'],
  );
});

void test('statusBarParts omits document facts while no document is open', () => {
  assert.deepEqual(
    statusBarParts({
      page: 1,
      pageCount: 0,
      zoom: 95,
      mode: 'mindmap',
      translated: { done: 0, total: 0 },
    }),
    ['95%', 'PDF 脑图'],
  );
});

void test('bottom status bar renders the read-only facts group', () => {
  assert.match(
    pageSource,
    /import \{[^}]*statusBarParts[^}]*\} from '@\/lib\/reader-ui-status'/,
  );
  // The facts derive from the same state the toolbar used to display.
  assert.match(
    pageSource,
    /const statusBarItems = statusBarParts\(\{\s*page,\s*pageCount: docMeta\?\.pageCount \?\? 0,\s*zoom,\s*mode: activeMode,\s*translated: translationProgress,\s*cacheState: translationStates\[translationKey\(page, targetLanguage\)\],\s*\}\)/,
  );
  assert.match(pageSource, /<ReaderStatusFacts parts=\{statusBarItems\} \/>/);
  // The status bar lives in the footer, after the reader panels.
  const footerIndex = pageSource.indexOf('<footer className="status-bar" aria-label="阅读器状态栏">');
  assert.notEqual(footerIndex, -1);
  const panelsEndIndex = pageSource.indexOf('</ResizablePanelGroup>');
  assert.notEqual(panelsEndIndex, -1);
  assert.ok(
    footerIndex > panelsEndIndex,
    'status bar footer must sit after the reader panels',
  );
});

void test('top toolbar keeps its controls but drops facts duplicated by the status bar', () => {
  // Operation controls survive the slim-down.
  assert.match(pageSource, /<span className="sr-only">跳转页码<\/span>/);
  assert.match(pageSource, /label="缩小"/);
  assert.match(pageSource, /label="放大"/);
  assert.match(pageSource, /label="阅读服务设置"/);
  assert.match(pageSource, /导入 PDF/);
  assert.match(pageSource, /<TabsTrigger\s+value="translation"/);
  // Static facts now only live in the bottom status bar.
  assert.doesNotMatch(pageSource, /\{zoom\}%/);
  assert.doesNotMatch(pageSource, /docMeta\?\.pageCount \?\? '—'/);
  assert.doesNotMatch(pageSource, /第 \{page\} 页正在阅读/);
  assert.doesNotMatch(pageSource, /status-chip/);
});

void test('progress follows the selected language and rejects partial page numbers', () => {
  const states: Record<string, { status: TranslationStatus }> = {
    '1:简体中文': { status: 'complete' },
    '2:日本語': { status: 'cached' },
    '3:简体中文': { status: 'error' },
    '4x:简体中文': { status: 'complete' },
    '4.5:简体中文': { status: 'complete' },
    '5': { status: 'complete' },
  };
  assert.deepEqual(countTranslated(states, 6, '简体中文'), { done: 1, total: 6 });
  assert.deepEqual(countTranslated(states, 6, '日本語'), { done: 1, total: 6 });
  assert.deepEqual(countTranslated(states, 6, '한국어'), { done: 0, total: 6 });
  assert.deepEqual(countTranslated(states, 0, '简体中文'), { done: 0, total: 0 });
});

void test('cache status distinguishes pending, local, restored and failed persistence', () => {
  assert.equal(cacheStatusLabel(), '缓存：待生成');
  assert.equal(cacheStatusLabel({ status: 'error' }), '缓存：待生成');
  assert.equal(cacheStatusLabel({ status: 'complete', source: 'generated' }), '缓存：本机已保存');
  assert.equal(cacheStatusLabel({ status: 'cached', source: 'indexeddb' }), '缓存：本机命中');
  assert.equal(cacheStatusLabel({ status: 'cached', source: 'course' }), '缓存：课程目录');
  assert.equal(cacheStatusLabel({ status: 'complete', persistence: 'saving' }), '缓存：保存中');
  assert.equal(cacheStatusLabel({ status: 'complete', persistence: 'failed' }), '缓存：课程保存失败');
  assert.match(styles, /\.status-bar \{[^}]*flex-wrap/);
});

void test('status facts render page, zoom, active mode, progress and cache without controls', () => {
  const parts = statusBarParts({ page: 2, pageCount: 8, zoom: 110,
    mode: 'chat', translated: { done: 3, total: 8 },
    cacheState: { status: 'cached', source: 'course' } });
  const html = renderToStaticMarkup(createElement(ReaderStatusFacts, { parts }));
  for (const text of ['第 2/8 页', '110%', 'AI 答疑', '已翻译 3/8', '缓存：课程目录']) {
    assert.ok(html.includes(`<span>${text}</span>`));
  }
  assert.match(html, /aria-label="阅读状态"/);
  assert.doesNotMatch(html, /<(button|input|select)/);
});
