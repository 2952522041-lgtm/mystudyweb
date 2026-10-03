import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import type { DiffViewFixtureProps } from './summary-diff-view.fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
let directory: string;
let outfile: string;

let renderDiffView: (props: DiffViewFixtureProps) => string;

function countRows(html: string): number {
  return [...html.matchAll(/data-diff-kind="(?:equal|added|removed)"/g)].length;
}

function diffTexts(html: string): string[] {
  return [
    ...html.matchAll(/data-diff-text="true"[^>]*>([\s\S]*?)<\/div>/g),
  ].map((match) => match[1]);
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-summary-diff-ssr-'));
  outfile = path.join(directory, 'summary-diff-view.fixture.cjs');
  await build({
    entryPoints: [path.join(root, 'tests', 'summary-diff-view.fixture.tsx')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
  });
  const require = createRequire(import.meta.url);
  const fixture = require(outfile) as {
    renderDiffView: (props: DiffViewFixtureProps) => string;
  };
  renderDiffView = fixture.renderDiffView;
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

void test('renders the accessible section, labels and counts', () => {
  const html = renderDiffView({
    before: 'A\n\nold\n\nZ',
    after: 'A\n\nnew\n\nZ',
  });
  assert.ok(html.includes('总结文字差异'));
  assert.ok(html.includes('起始版本'));
  assert.ok(html.includes('对比版本'));
  assert.ok(html.includes('新增 1 段 · 移除 1 段 · 未变 2 段'));
  assert.ok(html.includes('只看改动'));
  assert.ok(html.includes('type="checkbox"'));
  assert.ok(html.includes('checked=""'));
  const labelFor = /<label for="([^"]+)"/.exec(html)?.[1];
  const inputId = /<input id="([^"]+)" type="checkbox"/.exec(html)?.[1];
  assert.ok(labelFor !== undefined && labelFor === inputId);
});

void test('supplied version labels replace the defaults', () => {
  const html = renderDiffView({
    before: 'A',
    after: 'B',
    beforeLabel: '旧版',
    afterLabel: '新版',
  });
  assert.ok(html.includes('旧版'));
  assert.ok(html.includes('新版'));
  assert.ok(!html.includes('起始版本'));
});

void test('hides equal rows by default but keeps change order', () => {
  const html = renderDiffView({
    before: 'A\n\nold\n\nZ',
    after: 'A\n\nnew\n\nZ',
  });
  assert.equal(countRows(html), 2);
  assert.ok(html.includes('data-diff-kind="removed"'));
  assert.ok(html.includes('data-diff-kind="added"'));
  assert.ok(!html.includes('data-diff-kind="equal"'));
  const removedAt = html.indexOf('data-diff-kind="removed"');
  const addedAt = html.indexOf('data-diff-kind="added"');
  assert.ok(removedAt >= 0 && addedAt > removedAt);
});

void test('each row carries the exact escaped paragraph text', () => {
  const html = renderDiffView({
    before: '<b>hi</b>',
    after: '<script>alert(1)</script>',
  });
  assert.deepEqual(diffTexts(html), [
    '&lt;b&gt;hi&lt;/b&gt;',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  ]);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>hi</b>'));
  assert.ok(html.includes('whitespace-pre-wrap'));
});

void test('shows visible kind labels, not colour alone', () => {
  const html = renderDiffView({ before: 'old', after: 'new' });
  assert.ok(html.includes('移除'));
  assert.ok(html.includes('新增'));
  const unchanged = renderDiffView({ before: 'A\n\nB', after: 'A\n\nB' });
  assert.ok(unchanged.includes('未变'));
});

void test('renders at most 20 rows initially with a show more button', () => {
  const after = Array.from({ length: 25 }, (_value, index) => `p${index}`).join(
    '\n\n',
  );
  const html = renderDiffView({ before: '', after });
  assert.equal(countRows(html), 20);
  assert.ok(html.includes('显示更多'));
  assert.ok(html.includes('新增 25 段 · 移除 0 段 · 未变 0 段'));
});

void test('does not show the show more button when all rows fit', () => {
  const after = Array.from({ length: 20 }, (_value, index) => `p${index}`).join(
    '\n\n',
  );
  const html = renderDiffView({ before: '', after });
  assert.equal(countRows(html), 20);
  assert.ok(!html.includes('显示更多'));
});

void test('reports empty, unchanged and coarse states truthfully', () => {
  const empty = renderDiffView({ before: '', after: ' \n\n ' });
  assert.ok(empty.includes('没有可比较的总结文字。'));
  assert.equal(countRows(empty), 0);

  const unchanged = renderDiffView({ before: 'A\n\nB', after: 'A\n\nB' });
  assert.ok(unchanged.includes('总结文字没有变化。'));
  assert.equal(countRows(unchanged), 0);

  const before = Array.from({ length: 201 }, (_value, i) => `b${i}`).join(
    '\n\n',
  );
  const after = Array.from({ length: 201 }, (_value, i) => `a${i}`).join(
    '\n\n',
  );
  const coarse = renderDiffView({ before, after });
  assert.ok(coarse.includes('内容较长，显示简化差异。'));
  assert.equal(countRows(coarse), 20);
  assert.ok(coarse.includes('显示更多'));
});

void test('preserves interior line breaks in paragraph text', () => {
  const html = renderDiffView({ before: 'a\nb', after: 'c' });
  assert.deepEqual(diffTexts(html), ['a\nb', 'c']);
});
