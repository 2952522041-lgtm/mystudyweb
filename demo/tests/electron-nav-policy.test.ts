import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DevUrlError,
  externalHttpUrl,
  isAppOriginUrl,
  resolveDevUrl,
} from '../electron/nav-policy.ts';

void test('resolveDevUrl ignores the override in packaged builds', () => {
  assert.equal(resolveDevUrl(undefined, true), null);
  assert.equal(resolveDevUrl('  ', true), null);
  assert.equal(resolveDevUrl('http://localhost:3000', true), null);
  // 即使打包环境收到恶意地址，也必须被忽略而不是加载。
  assert.equal(resolveDevUrl('https://evil.example.com', true), null);
  assert.equal(resolveDevUrl('file:///C:/Windows/System32', true), null);
});

void test('resolveDevUrl accepts only loopback http/https in development', () => {
  assert.equal(
    resolveDevUrl('http://127.0.0.1:3000', false),
    'http://127.0.0.1:3000',
  );
  assert.equal(
    resolveDevUrl('  http://localhost:5173/  ', false),
    'http://localhost:5173/',
  );
  assert.equal(
    resolveDevUrl('https://localhost:3000', false),
    'https://localhost:3000',
  );
});

void test('resolveDevUrl rejects non-loopback and non-http targets in development', () => {
  const rejects = [
    'https://evil.example.com',
    'http://192.168.1.10:3000',
    'http://[::1]:3000',
    'file:///C:/Windows/System32/calc.exe',
    'ftp://localhost/files',
    'javascript:alert(1)',
    'not a url at all',
  ];
  for (const value of rejects) {
    assert.throws(
      () => resolveDevUrl(value, false),
      DevUrlError,
      `expected rejection for ${value}`,
    );
  }
});

void test('main window may only stay on the app origin', () => {
  const appOrigin = 'http://127.0.0.1:41023';
  assert.equal(
    isAppOriginUrl('http://127.0.0.1:41023/index.html', appOrigin),
    true,
  );
  assert.equal(isAppOriginUrl('http://127.0.0.1:41023/a/b?x=1', appOrigin), true);
  assert.equal(isAppOriginUrl('http://127.0.0.1:41023/#/course/1', appOrigin), true);
  // 同主机不同端口也算离开应用 origin。
  assert.equal(isAppOriginUrl('http://127.0.0.1:41024/', appOrigin), false);
  assert.equal(isAppOriginUrl('http://localhost:41023/', appOrigin), false);
  assert.equal(isAppOriginUrl('https://example.com/', appOrigin), false);
  assert.equal(isAppOriginUrl('file:///C:/evil.html', appOrigin), false);
  assert.equal(isAppOriginUrl('about:blank', appOrigin), false);
  assert.equal(isAppOriginUrl('not-a-url', appOrigin), false);
});

void test('only http/https links may be handed to the system browser', () => {
  assert.equal(
    externalHttpUrl('https://example.com/doc?a=1'),
    'https://example.com/doc?a=1',
  );
  assert.equal(externalHttpUrl('http://example.com'), 'http://example.com/');
  assert.equal(externalHttpUrl('file:///C:/Windows/System32/calc.exe'), null);
  assert.equal(externalHttpUrl('javascript:alert(1)'), null);
  assert.equal(externalHttpUrl('about:blank'), null);
  assert.equal(externalHttpUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(externalHttpUrl(undefined), null);
  assert.equal(externalHttpUrl('::not a url'), null);
});
