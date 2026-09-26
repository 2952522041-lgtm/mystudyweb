import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  getSelectionText,
  selectionBox,
  selectionInLayer,
  type ContainerLike,
  type RangeLike,
  type SelectionLike,
} from '../lib/selection.ts';

const pageSource = await readFile(
  new URL('../app/page.tsx', import.meta.url),
  'utf8',
);

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height };
}

function range(overrides: Partial<RangeLike>): RangeLike {
  return {
    commonAncestorContainer: null,
    getBoundingClientRect: () => rect(0, 0, 0, 0),
    getClientRects: () => [],
    ...overrides,
  };
}

function selection(overrides: Partial<SelectionLike>): SelectionLike {
  return {
    rangeCount: 1,
    getRangeAt: () => range({ commonAncestorContainer: {} }),
    toString: () => '',
    ...overrides,
  };
}

function container(overrides: Partial<ContainerLike>): ContainerLike {
  return { contains: () => false, ...overrides };
}

void test('getSelectionText trims and normalizes whitespace', () => {
  assert.equal(getSelectionText(selection({ toString: () => '  hello   world  ' })), 'hello world');
  assert.equal(getSelectionText(selection({ toString: () => '\n\tfoo\n' })), 'foo');
});

void test('getSelectionText is empty for null/empty selections', () => {
  assert.equal(getSelectionText(null), '');
  assert.equal(getSelectionText(undefined), '');
  assert.equal(getSelectionText(selection({ toString: () => '' })), '');
});

void test('selectionInLayer is false for null/empty selection or container', () => {
  assert.equal(selectionInLayer(null, container({})), false);
  assert.equal(selectionInLayer(undefined, container({})), false);
  assert.equal(selectionInLayer(selection({}), null), false);
  assert.equal(selectionInLayer(selection({ rangeCount: 0 }), container({})), false);
});

void test('selectionInLayer true when the shared ancestor is inside the container', () => {
  const ancestor = {};
  const rangeWithAncestor = range({ commonAncestorContainer: ancestor });
  const sel = selection({
    rangeCount: 1,
    getRangeAt: () => rangeWithAncestor,
  });
  assert.equal(
    selectionInLayer(sel, container({ contains: (node) => node === ancestor })),
    true,
  );
});

void test('selectionInLayer rejects visible selections outside the page', () => {
  const sel = selection({
    rangeCount: 1,
    getRangeAt: () => range({ commonAncestorContainer: null, getClientRects: () => [rect(1, 1, 10, 10)] }),
  });
  assert.equal(selectionInLayer(sel, container({ contains: () => false })), false);
});

void test('selectionBox returns null for empty or collapsed selections', () => {
  assert.equal(selectionBox(null), null);
  assert.equal(selectionBox(selection({ rangeCount: 0 })), null);
  const collapsed = selection({
    getRangeAt: () => range({ getClientRects: () => [], getBoundingClientRect: () => rect(0, 0, 0, 0) }),
  });
  assert.equal(selectionBox(collapsed), null);
});

void test('selectionBox returns the first non-empty client rect', () => {
  const sel = selection({
    getRangeAt: () =>
      range({
        getClientRects: () => [rect(0, 0, 0, 0), rect(20, 30, 100, 14)],
      }),
  });
  assert.deepEqual(selectionBox(sel), { x: 20, y: 30, w: 100, h: 14 });
});

void test('selectionBox falls back to bounding rect when no client rect', () => {
  const sel = selection({
    getRangeAt: () => range({ getClientRects: () => [], getBoundingClientRect: () => rect(5, 6, 50, 20) }),
  });
  assert.deepEqual(selectionBox(sel), { x: 5, y: 6, w: 50, h: 20 });
});

// Repository convention: assert the wiring in the page source (no jsdom).
void test('PdfReader mounts SelectionToolbar only when a document is open', () => {
  assert.match(pageSource, /SelectionToolbar/);
  assert.match(pageSource, /pdfDoc && docMeta && !suspended && !settingsOpen && !importOpen \? <SelectionToolbar/);
});
