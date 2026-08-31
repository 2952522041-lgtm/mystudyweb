import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// 回归防护：从阅读器切到课程知识库再返回时，已导入的 PDF 不允许被清空。
// 此前 Home 用条件渲染切换视图，PdfReader 卸载导致内存中的文档全部丢失。
const pageSource = await readFile(
  new URL('../app/page.tsx', import.meta.url),
  'utf8',
);

void test('reader stays mounted while the course library is shown', () => {
  // PdfReader 不再挂在 `view === 'reader'` 的条件返回里，而是常驻挂载。
  assert.doesNotMatch(pageSource, /if \(view === 'reader'\) \{\s*return/);
  assert.match(pageSource, /<div hidden=\{view !== 'reader'\}/);
  assert.match(pageSource, /inert=\{view !== 'reader'\}/);
});

void test('suspension is passed down so the reader can react to being hidden', () => {
  assert.match(pageSource, /suspended=\{view !== 'reader'\}/);
  assert.match(pageSource, /suspended\??: boolean/);
});

void test('returning to the reader re-anchors scroll on the page being read', () => {
  // display:none 子树会丢失滚动位置；恢复显示时必须重新定位到当前页。
  assert.match(pageSource, /anchorOnResumeRef\.current = true/);
  assert.match(
    pageSource,
    /anchorOnResumeRef\.current = false;[\s\S]*?scrollIntoView\(\{ block: 'start' \}\)/,
  );
  assert.match(pageSource, /\}, \[suspended, page\]\);/);
});

void test('importing inside the reader clears a stale course context', () => {
  // 先打开课程 PDF 再在阅读器里导入新文件时，旧课程的总结/脑图不得残留。
  assert.match(pageSource, /onStandaloneImport=\{\(\) => setReaderContext\(null\)\}/);
  assert.match(pageSource, /if \(origin === 'dialog'\) onStandaloneImportRef/);
  assert.match(pageSource, /handleFile\(file, undefined, 'dialog'\)/);
});

void test('right panel falls back to translation when the course digest disappears', () => {
  // rightMode 是用户意图，显示时按当前文档夹紧；无课程成果的文档不能停留在总结/脑图页签。
  assert.match(pageSource, /const activeMode =/);
  assert.match(
    pageSource,
    /rightMode === 'summary' \|\| rightMode === 'mindmap'\s*\?\s*courseContext\?\.digest/,
  );
  assert.match(pageSource, /value=\{activeMode\}/);
  assert.doesNotMatch(pageSource, /value=\{rightMode\}/);
});
