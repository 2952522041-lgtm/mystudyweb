import assert from 'node:assert/strict';
import test from 'node:test';

import { measurePageRects, pickCurrentPage } from '../lib/current-page.ts';

function rects(entries: Array<[number, number, number]>) {
  return entries.map(([page, top, bottom]) => ({ page, top, bottom }));
}

void test('a fully visible page is the current page', () => {
  assert.equal(pickCurrentPage(rects([[1, 0, 800]]), 800), 1);
});

void test('the page with the largest visible area wins', () => {
  const current = pickCurrentPage(
    rects([
      [1, -500, 300],
      [2, 320, 1100],
    ]),
    800,
  );
  assert.equal(current, 2);
});

void test('near-ties break toward the page centered in the viewport', () => {
  const current = pickCurrentPage(
    rects([
      [1, -350, 450],
      [2, 470, 1270],
    ]),
    800,
  );
  // Page 1 shows 450px, page 2 shows 330px, but page 1's center (50) is much
  // closer to the viewport center (400) than page 2's (870).
  assert.equal(current, 1);
});

void test('no visible page yields null', () => {
  assert.equal(pickCurrentPage(rects([[1, -900, -100]]), 800), null);
  assert.equal(pickCurrentPage([], 800), null);
});

void test('pages beyond the viewport bottom are ignored', () => {
  const current = pickCurrentPage(
    rects([
      [1, -800, 0],
      [2, 900, 1700],
    ]),
    800,
  );
  assert.equal(current, null);
});

void test('measurePageRects maps scroll offsets to viewport-relative rects', () => {
  const measured = measurePageRects(
    { scrollTop: 400, clientHeight: 800, pageTops: [0, 900, 1800] },
    [900, 900, 900],
  );
  assert.deepEqual(measured[0], { page: 1, top: -400, bottom: 500 });
  assert.deepEqual(measured[1], { page: 2, top: 500, bottom: 1400 });
  assert.deepEqual(measured[2], { page: 3, top: 1400, bottom: 2300 });
});
