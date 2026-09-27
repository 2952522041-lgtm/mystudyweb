import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommand, resultValue } from '../scripts/yeyu-tool.mjs';

void test('sync CLI only accepts read state or an explicit course and absolute PDF', () => {
  assert.deepEqual(parseCommand(['state']), { name: 'yeyu_get_state', arguments: {} });
  assert.deepEqual(parseCommand(['import', 'ece3250', '/tmp/L3.pdf']), {
    name: 'yeyu_import_pdf', arguments: { courseName: 'ece3250', localPath: '/tmp/L3.pdf' },
  });
  for (const args of [[], ['delete'], ['import', '', '/tmp/L3.pdf'], ['import', 'ece3250', 'L3.pdf'], ['import', 'ece3250', '/tmp/secret.txt'], ['state', 'extra']]) {
    assert.throws(() => parseCommand(args), /用法/);
  }
});

void test('sync CLI treats tool errors as failures, not successful imports', () => {
  assert.throws(() => resultValue({ isError: true, content: [{ type: 'text', text: '导入失败' }] }), /导入失败/);
  assert.deepEqual(resultValue({ content: [{ type: 'text', text: '{"courseName":"ece3250"}' }] }), { courseName: 'ece3250' });
  assert.equal(resultValue({ content: [{ type: 'text', text: 'complete' }] }), 'complete');
});
