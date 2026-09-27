import assert from 'node:assert/strict';
import test from 'node:test';

import {
  locateEntity,
  readCourseLocator,
  readDocumentLocator,
  readPage,
  readReaderPanel,
} from '../lib/yeyu-mcp-control.ts';

const courses = [
  { id: 'course-a', name: '高等数学' },
  { id: 'course-b', name: '线性代数' },
];

void test('MCP entity locators accept ids or names and reject ambiguity', () => {
  assert.deepEqual(readCourseLocator({ courseName: ' 高等数学 ' }, true), {
    id: undefined,
    name: '高等数学',
  });
  assert.deepEqual(readDocumentLocator({ documentId: 'doc-1' }), {
    id: 'doc-1',
    name: undefined,
  });
  assert.equal(
    locateEntity(
      courses,
      { id: 'course-b' },
      { id: (item) => item.id, name: (item) => item.name },
      '课程',
    ).name,
    '线性代数',
  );
  assert.throws(() => readCourseLocator({}, true), /courseId/);
  assert.throws(() => readDocumentLocator({}), /documentId/);
  assert.throws(
    () =>
      locateEntity(
        [
          { id: 'a', name: '同名' },
          { id: 'b', name: '同名' },
        ],
        { name: '同名' },
        { id: (item) => item.id, name: (item) => item.name },
        '课程',
      ),
    /多个同名/,
  );
});

void test('MCP page and panel arguments are strictly validated', () => {
  assert.equal(readPage({ page: 4 }), 4);
  assert.equal(readPage({}, 1), 1);
  assert.throws(() => readPage({ page: 0 }), /正整数/);
  assert.throws(() => readPage({ page: 1.5 }), /正整数/);
  assert.equal(readReaderPanel({ panel: 'mindmap' }), 'mindmap');
  assert.throws(() => readReaderPanel({ panel: 'settings' }), /panel/);
});
