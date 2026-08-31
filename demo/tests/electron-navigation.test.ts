import assert from 'node:assert/strict';
import test from 'node:test';

import {
  externalHttpUrl,
  isAppOrigin,
  resolveDevTargetUrl,
} from '../electron/navigation.ts';

/**
 * 导航隔离规则的单元测试（HANDOFF 13.3）。
 * 运行时接线由 electron/main.ts 的 applyNavigationGuards 完成，
 * 由 electron-workspace.test.ts 的结构断言和真实启动冒烟共同覆盖。
 */

void test('YEYU_DEV_URL is ignored when unset, empty or packaged', () => {
  assert.deepEqual(resolveDevTargetUrl(undefined, false), { url: null });
  assert.deepEqual(resolveDevTargetUrl('', false), { url: null });
  assert.deepEqual(resolveDevTargetUrl('   ', false), { url: null });

  const packaged = resolveDevTargetUrl('http://localhost:3000', true);
  assert.equal(packaged.url, null);
  assert.ok(packaged.warning);
});

void test('YEYU_DEV_URL accepts only loopback http addresses', () => {
  assert.equal(
    resolveDevTargetUrl('http://localhost:3000', false).url,
    'http://localhost:3000/',
  );
  assert.equal(
    resolveDevTargetUrl(' http://127.0.0.1:5173/app ', false).url,
    'http://127.0.0.1:5173/app',
  );
  assert.equal(
    resolveDevTargetUrl('http://[::1]:3000', false).url,
    'http://[::1]:3000/',
  );
});

void test('YEYU_DEV_URL rejects non-loopback, non-http and malformed values', () => {
  const rejected = [
    'https://localhost:3000',
    'http://example.com',
    'http://0.0.0.0:3000',
    'http://192.168.1.10:3000',
    'http://[::2]:3000',
    'file:///tmp/app/index.html',
    'javascript:alert(1)',
    'not a url',
  ];
  for (const value of rejected) {
    assert.throws(
      () => resolveDevTargetUrl(value, false),
      Error,
      `expected rejection for ${value}`,
    );
  }
});

void test('isAppOrigin matches protocol, host and port but not the path', () => {
  const appOrigin = 'http://127.0.0.1:41573';
  assert.equal(isAppOrigin('http://127.0.0.1:41573/', appOrigin), true);
  assert.equal(
    isAppOrigin('http://127.0.0.1:41573/_next/static/a.js', appOrigin),
    true,
  );
  assert.equal(isAppOrigin('http://127.0.0.1:41574/', appOrigin), false);
  assert.equal(isAppOrigin('https://127.0.0.1:41573/', appOrigin), false);
  assert.equal(isAppOrigin('http://localhost:41573/', appOrigin), false);
  assert.equal(isAppOrigin('file:///etc/passwd', appOrigin), false);
  assert.equal(isAppOrigin('not a url', appOrigin), false);
  assert.equal(isAppOrigin('about:blank', appOrigin), false);
});

void test('externalHttpUrl only lets http and https through', () => {
  assert.equal(
    externalHttpUrl('https://example.com/page?x=1'),
    'https://example.com/page?x=1',
  );
  assert.equal(
    externalHttpUrl('http://example.com'),
    'http://example.com/',
  );
  const blocked = [
    'file:///etc/passwd',
    'yeyu://course/1',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'about:blank',
    'chrome://settings',
    'not a url',
    '',
  ];
  for (const value of blocked) {
    assert.equal(externalHttpUrl(value), null, `expected null for ${value}`);
  }
});
