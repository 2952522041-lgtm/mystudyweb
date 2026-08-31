import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Script } from 'node:vm';

const demoUrl = new URL('../public/course-workspace-demo.html', import.meta.url);

void test('course workspace demo contains the core local-folder workflow', async () => {
  const html = await readFile(demoUrl, 'utf8');

  for (const requirement of [
    '创建本地课程',
    '导入 PDF',
    '生成 PDF 总结',
    '生成 PDF 脑图',
    '并入课程总总结和总脑图',
    '提炼后续 AI 问答',
    '课程总总结',
    '课程脑图',
    '尚未纳入课程知识库',
  ]) {
    assert.match(html, new RegExp(requirement));
  }
});

void test('course workspace demo is standalone and does not call remote APIs', async () => {
  const html = await readFile(demoUrl, 'utf8');

  assert.match(html, /^<!doctype html>/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /\bfetch\s*\(/);
  assert.doesNotMatch(html, /XMLHttpRequest|WebSocket/);
});

void test('each PDF opens a reader with its own summary and mindmap', async () => {
  const html = await readFile(demoUrl, 'utf8');

  for (const requirement of [
    'function openDocument',
    'data-open-doc',
    'PDF 页面预览',
    '页面翻译',
    'AI 答疑',
    '单 PDF 总结',
    '本 PDF 知识脑图',
    'data-back-course',
  ]) {
    assert.match(html, new RegExp(requirement));
  }
});

void test('PDF reader demo preserves the existing reader structure', async () => {
  const html = await readFile(demoUrl, 'utf8');

  for (const requirement of [
    'existing-toolbar',
    'existing-page-control',
    '自动识别 →',
    '更换 PDF',
    'existing-pane-eyebrow">原文',
    '文字型 PDF',
    'existing-thumbnails',
    'existing-document-stage',
    'PDF、译文与对话仅保存在本地',
  ]) {
    assert.match(html, new RegExp(requirement));
  }
});

void test('course workspace demo inline script compiles', async () => {
  const html = await readFile(demoUrl, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];

  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Script(scripts[0][1]));
});
