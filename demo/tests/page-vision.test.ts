import assert from 'node:assert/strict';
import test from 'node:test';

import { computePageImageSize } from '../lib/page-vision.ts';

void test('page vision image respects both dimension and pixel limits', () => {
  const portrait = computePageImageSize(612, 792);
  assert.ok(portrait.width <= 1800);
  assert.ok(portrait.height <= 1800);
  assert.ok(portrait.width * portrait.height <= 3_000_000);
  assert.ok(
    portrait.scale > 1,
    'normal PDF points should render above CSS resolution',
  );

  const poster = computePageImageSize(4000, 2000, {
    maxDimension: 1600,
    maxPixels: 1_500_000,
  });
  assert.equal(poster.width, 1600);
  assert.equal(poster.height, 800);
  assert.ok(poster.width * poster.height <= 1_500_000);
});

void test('page vision keeps aspect ratio when the pixel limit is tighter', () => {
  const size = computePageImageSize(1000, 1000, {
    maxDimension: 4000,
    maxPixels: 1_000_000,
  });
  assert.equal(size.width, 1000);
  assert.equal(size.height, 1000);
  assert.equal(size.scale, 1);
});
