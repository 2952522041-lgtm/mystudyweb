import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  McpControlServer,
  type McpControlDescriptor,
} from '../electron/mcp-control.ts';
import { prepareMcpRendererArgs } from '../electron/mcp-import.ts';

void test('MCP control endpoint requires its per-launch token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-mcp-control-'));
  const received: unknown[] = [];
  const server = new McpControlServer({
    settingsRoot: root,
    dispatch: async (request) => {
      received.push(request);
      return { view: 'courses' };
    },
  });
  try {
    const descriptor = await server.start();
    const stored = JSON.parse(
      await readFile(server.descriptorPath, 'utf8'),
    ) as McpControlDescriptor;
    assert.equal(stored.version, 1);
    assert.equal(stored.port, descriptor.port);
    assert.equal(stored.token, descriptor.token);
    if (process.platform !== 'win32') {
      assert.equal((await stat(server.descriptorPath)).mode & 0o777, 0o600);
    }

    const endpoint = `http://127.0.0.1:${descriptor.port}/command`;
    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ name: 'get_state', args: {} }),
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(received, []);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'show_courses', args: {} }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { view: 'courses' } });
    assert.deepEqual(received, [{ name: 'show_courses', args: {} }]);
  } finally {
    await server.stop();
    await assert.rejects(readFile(server.descriptorPath, 'utf8'));
    await rm(root, { recursive: true, force: true });
  }
});

void test('MCP import accepts only a regular PDF and removes its source path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-mcp-import-'));
  try {
    const pdfPath = path.join(root, 'lecture.PDF');
    await writeFile(pdfPath, Buffer.from('%PDF-test'));
    const args = await prepareMcpRendererArgs('import_pdf', {
      localPath: pdfPath,
      courseName: '测试课程',
      mergeIntoCourse: false,
    });
    assert.equal(args.localPath, undefined);
    assert.equal(args.fileName, 'lecture.PDF');
    assert.equal(args.courseName, '测试课程');
    assert.equal(args.mergeIntoCourse, false);
    assert.deepEqual(args.fileData, new Uint8Array(Buffer.from('%PDF-test')));

    await assert.rejects(
      prepareMcpRendererArgs('import_pdf', { localPath: 'relative.pdf' }),
      /绝对路径/,
    );
    const textPath = path.join(root, 'notes.txt');
    await writeFile(textPath, 'not a PDF');
    await assert.rejects(
      prepareMcpRendererArgs('import_pdf', { localPath: textPath }),
      /\.pdf/,
    );
    const disguisedPath = path.join(root, 'notes.pdf');
    await writeFile(disguisedPath, 'not a PDF');
    await assert.rejects(
      prepareMcpRendererArgs('import_pdf', { localPath: disguisedPath }),
      /文件内容不是有效的 PDF/,
    );
    if (process.platform !== 'win32') {
      const linkPath = path.join(root, 'linked.pdf');
      await symlink(pdfPath, linkPath);
      await assert.rejects(
        prepareMcpRendererArgs('import_pdf', { localPath: linkPath }),
        /符号链接/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('non-import MCP commands preserve their arguments', async () => {
  const args = { page: 3 };
  assert.equal(await prepareMcpRendererArgs('go_to_page', args), args);
});
