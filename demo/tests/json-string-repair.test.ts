import assert from 'node:assert/strict';
import test from 'node:test';

import {
  repairJsonStringEscapes,
  parseJsonPreservingText,
} from '../lib/knowledge/json-string-repair.ts';

void test('leaves valid JSON escapes byte-for-byte unchanged', () => {
  const input = String.raw`{"text":"quote: \" slash: \\ solidus: \/ controls: \b\f\n\r\t unicode: \u4e2d"}`;

  assert.equal(repairJsonStringEscapes(input), input);
  assert.equal(
    JSON.parse(input).text,
    'quote: " slash: \\ solidus: / controls: \b\f\n\r\t unicode: 中',
  );
});

void test('repairs malformed escapes and raw controls while preserving decoded text', () => {
  const original =
    '\\0 and \\alpha and \\u12G4 and \\u123' +
    '\0' +
    '\\' +
    '\n' +
    '\t' +
    'line' +
    '\n';
  const input = `{"text":"${original}"}`;
  const repaired = repairJsonStringEscapes(input);

  assert.equal(JSON.parse(repaired).text, original);
  for (let i = 0; i < repaired.length; i++)
    assert.ok(repaired.charCodeAt(i) > 0x1f);
});

void test('does not repair malformed JSON structure', () => {
  const malformedInputs = [
    '{"a":"\\alpha" "b":"ok"}',
    '{a:"\\alpha"}',
    '{"a":"\\alpha"',
  ];

  for (const input of malformedInputs) {
    assert.throws(
      () => JSON.parse(repairJsonStringEscapes(input)),
      SyntaxError,
    );
  }
});

void test('repairs embedded C++ quotes without replacing document characters', () => {
  const code = 'string text = "a"; cout << "hello";';
  const raw = `{"code":"${code}","page":2}`;
  assert.deepEqual(parseJsonPreservingText(raw), { code, page: 2 });
});

void test('rejects broad library repairs that would invent missing syntax or values', () => {
  for (const raw of [
    '{"a":"ok"',
    '{"a":1 "b":2}',
    '{a:1}',
    '{"a":undefined}',
    '{"a":1,}',
    '{"a":"ok","nodes":[{"id":1}',
  ]) {
    assert.throws(() => parseJsonPreservingText(raw));
  }
});

void test('preserves paired C++ literal quotes followed by non-ASCII punctuation', () => {
  const value =
    '自动转换：string str="hello"）（第25页），再调用 str.find("ll")。';
  const raw = `{"text":"${value}","pageStart":25,"pageEnd":25}`;
  assert.deepEqual(parseJsonPreservingText(raw), {
    text: value,
    pageStart: 25,
    pageEnd: 25,
  });
  assert.throws(() => parseJsonPreservingText('{"text":"one" "other":"two"}'));
});

void test('rejects ambiguous quoted keys inside a malformed value', () => {
  assert.throws(() => parseJsonPreservingText('{"a":"x "b":"y""}'));
  assert.throws(() => parseJsonPreservingText('{"outer":{"a":"x "b":"y""}}'));
});
