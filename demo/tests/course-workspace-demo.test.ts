import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
