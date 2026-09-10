import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
const [reader, viewer] = await Promise.all([
  read('../components/shared-pdf-reader.tsx'),
  read('../components/shared-course-viewer.tsx'),
]);

void test('shared source links scroll the actual rendered PDF page after layout', () => {
  assert.match(
    reader,
    /pendingPageRef = useRef<number \| null>\(initialPage\)/,
  );
  assert.match(reader, /useLayoutEffect\(\(\) => \{/);
  assert.match(
    reader,
    /const element = pageRefs\.current\.get\(target\);[\s\S]*?element\.scrollIntoView\(\{ behavior: 'auto', block: 'start' \}\)/,
  );
  assert.match(reader, /pendingPageRef\.current = firstPage/);
});

void test('shared reader re-subscribes lazy pages after zoom or resize', () => {
  assert.match(reader, /\}, \[pdfDoc, pageSizes\.length, pageWidth\]\);/);
  assert.match(reader, /key=\{number\}/);
  assert.doesNotMatch(
    reader,
    /key=\{`\$\{number\}-\$\{Math\.round\(width\)\}`\}/,
  );
  assert.match(reader, /rootMargin: '1000px 0px'/);
});

void test('shared reader keeps PDF artifacts reachable in narrow windows', () => {
  assert.match(reader, /aria-label="已有课程成果（窄窗口）"/);
  assert.match(reader, /className="flex max-h-\[38vh\][\s\S]*lg:hidden"/);
  assert.match(reader, /窄窗口可在下方切换查看 PDF 总结或脑图/);
  assert.match(reader, /<TabsTrigger value="summary">[\s\S]*PDF 总结/);
  assert.match(reader, /<TabsTrigger value="mindmap">[\s\S]*PDF 脑图/);
});

void test('shared course switching clears stale content and ignores late responses', () => {
  assert.match(viewer, /const requestVersionRef = useRef\(0\)/);
  assert.match(viewer, /const requestVersion = \+\+requestVersionRef\.current/);
  assert.match(viewer, /setDetail\(null\);[\s\S]*?setReader\(null\);/);
  assert.match(
    viewer,
    /if \(requestVersion !== requestVersionRef\.current\) return;/,
  );
  assert.match(viewer, /const courseId = selectedId;/);
  assert.match(viewer, /loadSharedPdf\(\s*courseId,/);

  const selectCourse = viewer.slice(
    viewer.indexOf('const selectCourse'),
    viewer.indexOf('const login'),
  );
  assert.match(
    selectCourse,
    /setDetail\(null\);[\s\S]*await loadSharedCourse\(course\.id\)[\s\S]*if \(requestVersion !== requestVersionRef\.current\) return;[\s\S]*setDetail\(nextDetail\)/,
  );
  assert.match(
    selectCourse,
    /catch \(requestError\)[\s\S]*if \(requestVersion !== requestVersionRef\.current\) return;[\s\S]*handleRequestError\(requestError\)/,
  );
});
