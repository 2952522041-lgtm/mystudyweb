import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePageSelection, selectionToolbarPosition, type SelectionLike } from '../lib/selection.ts';
import { textLayerTotalScale } from '../lib/pdf-text-layer.ts';

const ancestor = {};
function selected(left = 120, top = 240, width = 80, height = 20): SelectionLike {
  const rect = { left, top, width, height };
  return { rangeCount: 1, toString: () => ' hello  world ', getRangeAt: () => ({
    commonAncestorContainer: ancestor, getClientRects: () => [rect], getBoundingClientRect: () => rect,
  }) };
}
const layer = { pageNumber: 3, container: { contains: (node: unknown) => node === ancestor },
  bounds: { left: 100, top: 200, width: 400, height: 800 } };

void test('capture finds the selected page beyond the first layer with page-relative coordinates', () => {
  const snapshot = capturePageSelection(selected(), [
    { ...layer, pageNumber: 1, container: { contains: () => false } }, layer,
  ]);
  assert.equal(snapshot?.pageNumber, 3);
  assert.equal(snapshot?.text, 'hello world');
  assert.deepEqual(snapshot?.pageBox, { x: .05, y: .05, w: .2, h: .025 });
  assert.deepEqual(capturePageSelection(selected(140, 280, 160, 40), [
    { ...layer, bounds: { ...layer.bounds, width: 800, height: 1600 } },
  ])?.pageBox, snapshot?.pageBox);
});

void test('capture excludes outside/cross-page, collapsed, empty and invalid layers', () => {
  assert.equal(capturePageSelection(selected(), []), null);
  assert.equal(capturePageSelection(selected(), [{ ...layer, container: { contains: () => false } }]), null);
  assert.equal(capturePageSelection(selected(120, 240, 0, 20), [layer]), null);
  assert.equal(capturePageSelection({ ...selected(), toString: () => ' ' }, [layer]), null);
  assert.equal(capturePageSelection({ ...selected(), rangeCount: 2 }, [layer]), null);
  assert.equal(capturePageSelection(selected(), [{ ...layer, pageNumber: NaN }]), null);
});

void test('floating toolbar stays within viewport edges above or below the selection', () => {
  assert.deepEqual(selectionToolbarPosition({ x: 900, y: 600, w: 60, h: 20 },
    { width: 1000, height: 700 }, { width: 300, height: 100 }), { left: 692, top: 492 });
  assert.deepEqual(selectionToolbarPosition({ x: -10, y: 2, w: 60, h: 20 },
    { width: 400, height: 300 }, { width: 300, height: 100 }), { left: 8, top: 30 });
});

void test('text layer CSS accounts for PDF UserUnit without device pixel ratio', () => {
  assert.equal(textLayerTotalScale(600, 1200, 2), 1);
  assert.equal(textLayerTotalScale(900, 1200, 2), 1.5);
  assert.equal(textLayerTotalScale(600, 600), 1);
});
