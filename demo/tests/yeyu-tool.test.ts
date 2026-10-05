import assert from 'node:assert/strict';
import test from 'node:test';
import {
  main,
  inspectProcessing,
  parseCommand,
  PDF_IMPORT_FAILED_MESSAGE,
  resultValue,
  waitForImportCompletion,
} from '../scripts/yeyu-tool.mjs';

void test('CLI only accepts read state or an explicit course and absolute PDF', () => {
  assert.deepEqual(parseCommand(['state']), {
    name: 'yeyu_get_state',
    arguments: {},
  });
  assert.deepEqual(parseCommand(['import', 'ece3250', '/tmp/L3.pdf']), {
    name: 'yeyu_import_pdf',
    arguments: { courseName: 'ece3250', localPath: '/tmp/L3.pdf' },
  });
  assert.deepEqual(
    parseCommand(['import', '--wait', 'ece3250', '/tmp/L3.pdf']),
    {
      name: 'yeyu_import_pdf',
      arguments: { courseName: 'ece3250', localPath: '/tmp/L3.pdf' },
      wait: true,
    },
  );
  for (const args of [
    [],
    ['delete'],
    ['import', '', '/tmp/L3.pdf'],
    ['import', 'ece3250', 'L3.pdf'],
    ['import', 'ece3250', '/tmp/secret.txt'],
    ['state', 'extra'],
  ]) {
    assert.throws(() => parseCommand(args), /用法/);
  }
});

void test('sync CLI treats tool errors as failures, not successful imports', () => {
  assert.throws(
    () =>
      resultValue({
        isError: true,
        content: [{ type: 'text', text: '导入失败' }],
      }),
    /导入失败/,
  );
  assert.deepEqual(
    resultValue({
      content: [{ type: 'text', text: '{"courseName":"ece3250"}' }],
    }),
    { courseName: 'ece3250' },
  );
  assert.equal(
    resultValue({ content: [{ type: 'text', text: 'complete' }] }),
    'complete',
  );
});

const imported = {
  courseId: 'course-1',
  courseName: 'ece3250',
  fileName: 'L3.pdf',
  documentId: 'document-1',
  message: 'PDF 已保存，后台整理已排队。',
  processing: {
    phase: 'document',
    status: 'queued',
    options: {
      generateSummary: true,
      generateMindmap: true,
      mergeIntoCourse: true,
    },
    updatedAt: '2026-09-28T00:00:00.000Z',
  },
};

function stateWithProcessing(processing: unknown) {
  return {
    courseLibrary: {
      courses: [
        {
          id: 'course-1',
          name: 'ece3250',
          documents: [
            {
              id: 'document-1',
              fileName: 'L3.pdf',
              status: 'processing',
              processing,
            },
          ],
        },
      ],
    },
  };
}

function mcpText(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

void test('wait polling stops when processing disappears and never calls import twice', async () => {
  const states = [
    stateWithProcessing({ phase: 'document', status: 'running' }),
    stateWithProcessing({ phase: 'course', status: 'running' }),
    stateWithProcessing(undefined),
  ];
  const completion = await waitForImportCompletion({
    importResult: imported,
    getState: async () => states.shift(),
    intervalMs: 0,
    sleep: async () => undefined,
    onProgress: undefined,
  });
  assert.equal(completion.status, 'completed');
  assert.equal(states.length, 0);
});

void test('an existing document without processing is already complete and needs no poll', async () => {
  let stateReads = 0;
  const completion = await waitForImportCompletion({
    importResult: { ...imported, processing: undefined },
    getState: async () => {
      stateReads += 1;
      return stateWithProcessing(undefined);
    },
    intervalMs: 0,
    sleep: async () => undefined,
    onProgress: undefined,
  });
  assert.deepEqual(completion, {
    status: 'completed',
    source: 'import-result',
  });
  assert.equal(stateReads, 0);
});

void test('wait polling reports a background failure without resubmitting the PDF', async () => {
  const completion = await waitForImportCompletion({
    importResult: imported,
    getState: async () =>
      stateWithProcessing({
        phase: 'document',
        status: 'failed',
        error: '知识库请求失败',
      }),
    intervalMs: 0,
    sleep: async () => undefined,
    onProgress: undefined,
  });
  assert.equal(completion.status, 'failed');
  assert.equal(completion.error, '知识库请求失败');
});

void test('paused, cancelled and review are explicit processing states; unknown states still fail', () => {
  for (const status of ['paused', 'cancelled', 'review']) {
    const processing = { phase: 'document', status };
    assert.deepEqual(inspectProcessing(processing), {
      kind: status,
      status,
      processing,
    });
  }
  assert.throws(() => inspectProcessing({ status: 'unexpected' }), /未知/);
});

void test('wait stops immediately on an initial or polled pause/cancellation/review', async () => {
  for (const status of ['paused', 'cancelled', 'review']) {
    for (const initial of [true, false]) {
      let stateReads = 0;
      const completion = await waitForImportCompletion({
        importResult: initial
          ? { ...imported, processing: { ...imported.processing, status } }
          : imported,
        getState: async () => {
          stateReads += 1;
          return stateWithProcessing({ phase: 'document', status });
        },
        sleep: async () => assert.fail('a stopped task must not wait for another poll'),
        onProgress: () => assert.fail('a stopped task must not report active progress'),
      });
      assert.equal(completion.status, status);
      assert.equal(completion.source, initial ? 'import-result' : 'state');
      assert.equal(stateReads, initial ? 0 : 1);
    }
  }
});

void test('CLI --wait emits stopped status, rejects with recovery guidance and closes without resubmitting', async () => {
  for (const [status, label, action] of [
    ['paused', '已暂停', '继续'],
    ['cancelled', '已取消', '重试'],
  ]) {
    for (const initial of [true, false]) {
      const calls: string[] = [];
      const outputs: string[] = [];
      const errors: string[] = [];
      let closed = false;
      const stopped = { ...imported.processing, status };
      const client = {
        async connect() {},
        async callTool(command: { name: string }) {
          calls.push(command.name);
          return mcpText(command.name === 'yeyu_import_pdf'
            ? initial ? { ...imported, processing: stopped } : imported
            : stateWithProcessing(stopped));
        },
        async close() { closed = true; },
      };
      await assert.rejects(main(['import', '--wait', 'ece3250', '/tmp/L3.pdf'], {
        createClient: () => client,
        createTransport: () => ({}),
        errorLog: (message: string) => errors.push(message),
        log: (message: string) => outputs.push(message),
        waitOptions: {
          sleep: async () => assert.fail('paused/cancelled polling must stop'),
        },
      }), new RegExp(`PDF已保存.*${label}.*后台任务.*${action}`));
      assert.deepEqual(calls, initial
        ? ['yeyu_import_pdf']
        : ['yeyu_import_pdf', 'yeyu_get_state']);
      assert.equal(closed, true);
      assert.equal(outputs.length, 1);
      assert.equal(JSON.parse(outputs[0]).completion.status, status);
      assert.doesNotMatch(errors.join('\n'), /后台整理已完成|当前没有后台整理任务/);
    }
  }
});

void test('default import reports an existing pause/cancellation without claiming completion or polling', async () => {
  for (const [status, label] of [['paused', '已暂停'], ['cancelled', '已取消']]) {
    const calls: string[] = [];
    const errors: string[] = [];
    const outputs: string[] = [];
    await main(['import', 'ece3250', '/tmp/L3.pdf'], {
      createClient: () => ({
        async connect() {},
        async callTool(command: { name: string }) {
          calls.push(command.name);
          return mcpText({ ...imported, processing: { ...imported.processing, status } });
        },
        async close() {},
      }),
      createTransport: () => ({}),
      errorLog: (message: string) => errors.push(message),
      log: (message: string) => outputs.push(message),
    });
    assert.deepEqual(calls, ['yeyu_import_pdf']);
    assert.match(errors.join('\n'), new RegExp(`PDF已保存.*${label}`));
    assert.doesNotMatch(errors.join('\n'), /后台整理已完成|当前没有后台整理任务/);
    assert.equal(JSON.parse(outputs[0]).result.processing.status, status);
  }
});

void test('polling errors and timeout are terminal read failures, never a second import', async () => {
  await assert.rejects(
    waitForImportCompletion({
      importResult: imported,
      getState: async () => {
        throw new Error('连接中断');
      },
      onProgress: undefined,
    }),
    /连接中断.*未重复导入/,
  );
  await assert.rejects(
    waitForImportCompletion({
      importResult: imported,
      getState: async () =>
        stateWithProcessing({ phase: 'document', status: 'running' }),
      timeoutMs: 0,
      intervalMs: 0,
      sleep: async () => undefined,
      onProgress: undefined,
    }),
    /超时.*未重复导入/,
  );
});

void test('CLI default import reports queue state without polling or claiming completion', async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const outputs: string[] = [];
  const client = {
    async connect() {},
    async callTool(command: { name: string }) {
      calls.push(command.name);
      return mcpText(imported);
    },
    async close() {},
  };
  await main(['import', 'ece3250', '/tmp/L3.pdf'], {
    createClient: () => client,
    createTransport: () => ({}),
    errorLog: (message: string) => errors.push(message),
    log: (message: string) => outputs.push(message),
  });
  assert.deepEqual(calls, ['yeyu_import_pdf']);
  assert.match(errors.join('\n'), /后台整理已排队/);
  assert.doesNotMatch(errors.join('\n'), /处理已完成/);
  assert.equal(outputs.length, 1);
});

void test('CLI --wait reports failure and keeps import count at one', async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    async connect() {},
    async callTool(command: { name: string }) {
      requests.push(command);
      calls.push(command.name);
      return command.name === 'yeyu_import_pdf'
        ? mcpText(imported)
        : mcpText(
            stateWithProcessing({
              phase: 'document',
              status: 'failed',
              error: '后台服务失败',
            }),
          );
    },
    async close() {},
  };
  await assert.rejects(
    main(['import', '--wait', 'ece3250', '/tmp/L3.pdf'], {
      createClient: () => client,
      createTransport: () => ({}),
      errorLog: (message: string) => errors.push(message),
      waitOptions: { intervalMs: 0, sleep: async () => undefined },
    }),
    /后台服务失败/,
  );
  assert.deepEqual(calls, ['yeyu_import_pdf', 'yeyu_get_state']);
  assert.equal('wait' in requests[0], false);
  assert.ok(errors.includes(PDF_IMPORT_FAILED_MESSAGE));
});

void test('CLI --wait emits an independent completion status', async () => {
  const outputs: string[] = [];
  const calls: string[] = [];
  const client = {
    async connect() {},
    async callTool(command: { name: string }) {
      calls.push(command.name);
      return command.name === 'yeyu_import_pdf'
        ? mcpText(imported)
        : mcpText(stateWithProcessing(undefined));
    },
    async close() {},
  };
  await main(['import', '--wait', 'ece3250', '/tmp/L3.pdf'], {
    createClient: () => client,
    createTransport: () => ({}),
    errorLog: () => undefined,
    log: (message: string) => outputs.push(message),
    waitOptions: { intervalMs: 0, sleep: async () => undefined },
  });
  assert.deepEqual(calls, ['yeyu_import_pdf', 'yeyu_get_state']);
  assert.equal(JSON.parse(outputs[0]).completion.status, 'completed');
  assert.equal(JSON.parse(outputs[0]).result.processing.status, 'queued');
});
