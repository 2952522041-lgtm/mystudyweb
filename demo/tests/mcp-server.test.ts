import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createYeyuMcpServer,
  invokeElectronCommand,
  resolveControlFilePath,
  YEYU_TOOL_COMMANDS,
  yeyuGoToPageArgsSchema,
  yeyuImportPdfArgsSchema,
  yeyuOpenCourseArgsSchema,
  yeyuOpenDocumentArgsSchema,
  yeyuSetReaderPanelArgsSchema,
} from '../mcp/server.ts';

async function withControlFile(
  callback: (controlFilePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-mcp-test-'));
  const controlFilePath = path.join(directory, 'mcp-control.json');
  try {
    await writeFile(
      controlFilePath,
      JSON.stringify({
        version: 1,
        port: 43123,
        token: 'test-token',
        pid: 123,
        updatedAt: '2026-09-28T00:00:00.000Z',
      }),
    );
    await callback(controlFilePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('control file path honors explicit, workspace, then home defaults', () => {
  assert.equal(
    resolveControlFilePath({
      environment: {
        YEYU_MCP_CONTROL_FILE: '/tmp/explicit/mcp-control.json',
        YEYU_WORKSPACE_ROOT: '/tmp/workspace',
      },
      homeDirectory: '/home/tester',
    }),
    path.resolve('/tmp/explicit/mcp-control.json'),
  );
  assert.equal(
    resolveControlFilePath({
      environment: { YEYU_WORKSPACE_ROOT: '/tmp/workspace' },
      homeDirectory: '/home/tester',
    }),
    path.join('/tmp/workspace', 'Settings', 'mcp-control.json'),
  );
  assert.equal(
    resolveControlFilePath({ environment: {}, homeDirectory: '/home/tester' }),
    path.join(
      '/home/tester',
      'Documents',
      '页语工作区',
      'Settings',
      'mcp-control.json',
    ),
  );
});

void test('command request uses the descriptor token and sends the expected JSON body', async () => {
  await withControlFile(async (controlFilePath) => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const result = await invokeElectronCommand(
      'open_course',
      { courseName: '数学' },
      {
        controlFilePath,
        fetchImplementation: async (url, init) => {
          requestUrl = String(url);
          requestInit = init;
          return new Response(JSON.stringify({ result: { opened: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );

    assert.equal(requestUrl, 'http://127.0.0.1:43123/command');
    assert.equal(
      new Headers(requestInit?.headers).get('authorization'),
      'Bearer test-token',
    );
    assert.equal(
      new Headers(requestInit?.headers).get('content-type'),
      'application/json',
    );
    assert.equal(requestInit?.method, 'POST');
    assert.deepEqual(JSON.parse(requestInit?.body as string), {
      name: 'open_course',
      args: { courseName: '数学' },
    });
    assert.deepEqual(result, { opened: true });
  });
});

void test('HTTP failures, invalid JSON, and offline bridge failures become Chinese errors', async () => {
  await withControlFile(async (controlFilePath) => {
    await assert.rejects(
      invokeElectronCommand(
        'get_state',
        {},
        {
          controlFilePath,
          fetchImplementation: async () =>
            new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
            }),
        },
      ),
      /HTTP 401.*Unauthorized/,
    );
    await assert.rejects(
      invokeElectronCommand(
        'get_state',
        {},
        {
          controlFilePath,
          fetchImplementation: async () =>
            new Response('not-json', { status: 200 }),
        },
      ),
      /无效 JSON.*HTTP 200/,
    );
    await assert.rejects(
      invokeElectronCommand(
        'get_state',
        {},
        {
          controlFilePath,
          fetchImplementation: async () => {
            throw new Error('ECONNREFUSED');
          },
        },
      ),
      /无法连接页语控制桥.*ECONNREFUSED/,
    );
  });
});

void test('tool schemas enforce locators, positive pages, panels, and import defaults', () => {
  assert.equal(yeyuOpenCourseArgsSchema.safeParse({}).success, false);
  assert.equal(
    yeyuOpenCourseArgsSchema.safeParse({ courseName: '  课程一  ' }).success,
    true,
  );
  assert.equal(
    yeyuOpenDocumentArgsSchema.safeParse({
      courseId: 'course-1',
      fileName: 'notes.pdf',
      page: 2,
    }).success,
    true,
  );
  assert.equal(
    yeyuOpenDocumentArgsSchema.safeParse({ documentId: 'doc-1' }).success,
    false,
  );
  assert.equal(yeyuGoToPageArgsSchema.safeParse({ page: 0 }).success, false);
  assert.equal(yeyuGoToPageArgsSchema.safeParse({ page: 1.5 }).success, false);
  assert.equal(
    yeyuSetReaderPanelArgsSchema.safeParse({ panel: 'unknown' }).success,
    false,
  );

  const imported = yeyuImportPdfArgsSchema.safeParse({
    localPath: '/tmp/import.pdf',
    courseName: '课程一',
  });
  assert.equal(imported.success, true);
  if (imported.success) {
    assert.deepEqual(imported.data, {
      localPath: '/tmp/import.pdf',
      courseName: '课程一',
      generateSummary: true,
      generateMindmap: true,
      mergeIntoCourse: true,
    });
  }
  assert.equal(
    yeyuImportPdfArgsSchema.safeParse({
      localPath: 'relative.pdf',
      courseName: '课程一',
    }).success,
    false,
  );
  assert.equal(
    yeyuImportPdfArgsSchema.safeParse({ localPath: '/tmp/import.pdf' }).success,
    false,
  );
});

void test('tool-to-command map includes the PDF import command', () => {
  assert.equal(YEYU_TOOL_COMMANDS.yeyu_import_pdf, 'import_pdf');
});

void test('registered tools return command results as MCP text and dispatch import_pdf', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = createYeyuMcpServer({
    invokeCommand: async (name, args) => {
      calls.push({ name, args });
      return { accepted: true };
    },
  });
  const registeredTools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
          ) => Promise<{ content: unknown; isError?: boolean }>;
        }
      >;
    }
  )._registeredTools;

  const result = await registeredTools.yeyu_import_pdf.handler({
    localPath: '/tmp/import.pdf',
    courseName: '课程一',
  });
  assert.deepEqual(result, {
    content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }],
  });
  assert.deepEqual(calls, [
    {
      name: 'import_pdf',
      args: {
        localPath: '/tmp/import.pdf',
        courseName: '课程一',
        generateSummary: true,
        generateMindmap: true,
        mergeIntoCourse: true,
      },
    },
  ]);

  const invalid = await registeredTools.yeyu_open_course.handler({});
  assert.equal(invalid.isError, true);
  assert.match(
    String((invalid.content as [{ text: string }])[0].text),
    /courseId 或 courseName/,
  );
});
