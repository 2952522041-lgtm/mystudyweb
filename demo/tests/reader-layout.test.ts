import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pageSource = await readFile(
  new URL('../app/page.tsx', import.meta.url),
  'utf8',
);
const styles = await readFile(
  new URL('../app/globals.css', import.meta.url),
  'utf8',
);
const settingsSource = await readFile(
  new URL('../components/reader-settings-dialog.tsx', import.meta.url),
  'utf8',
);
const chatSource = await readFile(
  new URL('../components/ai-chat-panel.tsx', import.meta.url),
  'utf8',
);

void test('reader exposes a scrollable thumbnail for every PDF page', () => {
  assert.match(pageSource, /className="thumbnail-sidebar"/);
  assert.match(pageSource, /pageNumbers\.map/);
  assert.match(styles, /\.thumbnail-scroll[\s\S]*overflow-y-auto/);
});

void test('reader canvas keeps every page in a continuous full-width column', () => {
  assert.match(pageSource, /className="document-pages"/);
  assert.match(pageSource, /className=\{`pdf-page /);
  assert.match(styles, /\.document-stage[\s\S]*overflow-auto/);
  assert.match(styles, /\.document-pages[\s\S]*min-w-full/);
});

void test('API key input captures its value before updating the settings state', () => {
  assert.match(
    settingsSource,
    /const updateTranslationApiKey = \(apiKey: string\) =>/,
  );
  assert.match(
    settingsSource,
    /onChange=\{\(event\) =>\s*updateTranslationApiKey\(event\.target\.value\)\s*\}/,
  );
  assert.doesNotMatch(
    settingsSource,
    /setDraftSettings\(\(previous\) => updateReaderApiKey\(previous, event\.target\.value\)\)/,
  );
});

void test('right panel exposes translation and page-scoped AI modes', () => {
  assert.match(pageSource, /<TabsTrigger\s+value="translation"/);
  assert.match(pageSource, /<TabsTrigger value="chat"/);
  assert.match(pageSource, /<AIChatPanel/);
  assert.match(chatSource, /正在基于第 \{pageNumber\} 页/);
  assert.match(chatSource, /renderPageImage\(pdfDoc, pageNumber/);
});

void test('chat tab content is a column flex container so messages scroll above the pinned composer', () => {
  assert.match(
    pageSource,
    /<TabsContent\s+value="chat"[\s\S]*?className="flex min-h-0 flex-col overflow-hidden/,
  );
});

void test('translation and AI settings use independent controlled fields', () => {
  assert.match(settingsSource, /translationSettings: ReaderSettings/);
  assert.match(settingsSource, /chatSettings: ChatSettings/);
  assert.match(settingsSource, /id="chat-api-key"/);
  assert.match(settingsSource, /支持图片输入的模型/);
});
