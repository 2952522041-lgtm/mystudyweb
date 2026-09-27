import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { loopbackFetch } from '../mcp/loopback-fetch.ts';

void test('loopback fetch sends the request and returns a fetch-compatible response', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/command?test=1');
      assert.equal(request.headers.authorization, 'Bearer test');
      assert.equal(body, '{"name":"get_state"}');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await loopbackFetch(
      `http://127.0.0.1:${address.port}/command?test=1`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json',
        },
        body: '{"name":"get_state"}',
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

void test('loopback fetch rejects non-loopback URLs and already-aborted requests', async () => {
  await assert.rejects(
    loopbackFetch('http://localhost:1234/command'),
    /只允许访问 127\.0\.0\.1/,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loopbackFetch('http://127.0.0.1:1234/command', {
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
});

void test('loopback bridge waits for delayed headers without using global fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected global fetch'); });
  const server = createServer((_request, response) => {
    setTimeout(() => response.end('{"result":"imported"}'), 30);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await loopbackFetch(`http://127.0.0.1:${address.port}/command`);
    assert.deepEqual(await response.json(), { result: 'imported' });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

void test('loopback bridge aborts an in-flight request and releases its connection', async () => {
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  const server = createServer(() => started());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const controller = new AbortController();
    const pending = loopbackFetch(`http://127.0.0.1:${address.port}/command`, { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await received;
    controller.abort();
    await rejected;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
