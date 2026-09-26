import assert from 'node:assert/strict';
import test from 'node:test';
import { createProgressivePageSizes, captureReadingAnchor, restoreReadingAnchor } from '../lib/progressive-page-sizes.ts';

void test('first page is available while delayed dimensions reserve all page slots; jumps load the target immediately', async () => {
  const resolvers = new Map<number, () => void>();
  const calls: number[] = [];
  const snapshots: boolean[][] = [];
  const loader = createProgressivePageSizes({ numPages: 4, getPage: (page) => {
    calls.push(page);
    return new Promise((resolve) => resolvers.set(page, () => resolve({getViewport: () => ({width: 600, height: page * 200})})));
  } }, {width: 600, height: 800}, (sizes) => snapshots.push(sizes.map((s) => s.ready)));
  assert.deepEqual(loader.initial.map((s) => s.ready), [true, false, false, false]);
  const background = loader.complete();
  const jump = loader.load(4);
  assert.equal(calls[0], 4, 'jump must not wait behind all preceding page sizes');
  const sameJump = loader.load(4); assert.equal(jump, sameJump);
  resolvers.get(4)!(); await jump;
  assert.deepEqual(snapshots[0], [true, false, false, true]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  loader.cancel(); resolvers.get(2)?.(); await background;
  assert.equal(snapshots.length, 1, 'late dimensions cannot publish after replacement');
});

void test('jump target stays at the viewport top as preceding estimates are replaced, and reading position stays within its page', () => {
  const estimatedTops = [12, 820, 1628, 2436]; const estimatedHeights = [800,800,800,800];
  const jump = captureReadingAnchor(0, estimatedTops, estimatedHeights, 4);
  assert.equal(restoreReadingAnchor(jump, estimatedTops, estimatedHeights), 2436);
  const measuredTops = [12,420,1628,2236]; const measuredHeights = [400,1200,600,1000];
  assert.equal(restoreReadingAnchor(jump, measuredTops, measuredHeights), 2236);
  assert.deepEqual(captureReadingAnchor(2436, [12, 820, 1628, 2436.4], estimatedHeights), {page:4,fraction:0});
  const reading = captureReadingAnchor(2636, estimatedTops, estimatedHeights);
  assert.equal(restoreReadingAnchor(reading, measuredTops, measuredHeights), 2486);
});

void test('failed dimensions retain an estimate and can be retried without replacing the PDF', async () => {
  let calls = 0;
  const results: {ready:boolean; error?:boolean}[] = [];
  const loader = createProgressivePageSizes({numPages:2, getPage: async () => {
    if (++calls === 1) throw new Error('page read failed');
    return { getViewport: () => ({width:400,height:200}) };
  }}, {width:600,height:800}, (sizes) => results.push(sizes[1]));
  await loader.load(2); assert.equal(results[0].error, true); assert.equal(results[0].ready, false);
  await loader.load(2); assert.equal(results[1].ready, true); assert.equal(results[1].error, undefined);
});
