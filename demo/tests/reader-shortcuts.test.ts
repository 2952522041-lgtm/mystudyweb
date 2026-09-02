import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isEditableTarget,
  mapShortcut,
  READER_RIGHT_MODES,
  type KeyboardEventLike,
} from '../lib/reader-shortcuts.ts';

const pageSource = await readFile(
  new URL('../app/page.tsx', import.meta.url),
  'utf8',
);

function keyEvent(overrides: Partial<KeyboardEventLike>): KeyboardEventLike {
  return {
    key: '',
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  };
}

function mapKey(keyValue: string, modifiers: Partial<KeyboardEventLike> = {}) {
  return mapShortcut(keyEvent({ key: keyValue, ...modifiers }));
}

void test('arrow and paging keys move between pages', () => {
  assert.deepEqual(mapKey('PageDown'), { action: 'nextPage' });
  assert.deepEqual(mapKey('ArrowRight'), { action: 'nextPage' });
  assert.deepEqual(mapKey('PageUp'), { action: 'prevPage' });
  assert.deepEqual(mapKey('ArrowLeft'), { action: 'prevPage' });
  assert.deepEqual(mapKey('Home'), { action: 'firstPage' });
  assert.deepEqual(mapKey('End'), { action: 'lastPage' });
});

void test('plus, minus and zero step and reset zoom', () => {
  for (const zoomInKey of ['+', '=', 'Add']) {
    assert.deepEqual(mapKey(zoomInKey), { action: 'zoomIn' }, zoomInKey);
  }
  // On many layouts '+' is produced by Shift+'='; the key already reflects it.
  assert.deepEqual(mapShortcut(keyEvent({ key: '+', shiftKey: true })), {
    action: 'zoomIn',
  });
  for (const zoomOutKey of ['-', 'Subtract']) {
    assert.deepEqual(mapKey(zoomOutKey), { action: 'zoomOut' }, zoomOutKey);
  }
  assert.deepEqual(mapKey('0'), { action: 'zoomReset' });
});

void test('Alt+1..4 toggle the right-panel modes in order', () => {
  assert.deepEqual(mapKey('1', { altKey: true }), {
    action: 'toggleRightMode',
    mode: 1,
  });
  assert.deepEqual(mapKey('2', { altKey: true }), {
    action: 'toggleRightMode',
    mode: 2,
  });
  assert.deepEqual(mapKey('3', { altKey: true }), {
    action: 'toggleRightMode',
    mode: 3,
  });
  assert.deepEqual(mapKey('4', { altKey: true }), {
    action: 'toggleRightMode',
    mode: 4,
  });
  assert.deepEqual(READER_RIGHT_MODES[1], 'translation');
  assert.deepEqual(READER_RIGHT_MODES[2], 'chat');
  assert.deepEqual(READER_RIGHT_MODES[3], 'summary');
  assert.deepEqual(READER_RIGHT_MODES[4], 'mindmap');
});

void test('F collapses the right panel and Escape dismisses overlays', () => {
  assert.deepEqual(mapKey('f'), { action: 'collapseRightPanel' });
  assert.deepEqual(mapKey('F', { shiftKey: true }), {
    action: 'collapseRightPanel',
  });
  assert.deepEqual(mapKey('Escape'), { action: 'dismiss' });
});

void test('ctrl and meta chords are never hijacked', () => {
  assert.equal(mapKey('PageDown', { ctrlKey: true }), null);
  assert.equal(mapKey('ArrowRight', { metaKey: true }), null);
  assert.equal(mapKey('=', { ctrlKey: true }), null);
  assert.equal(mapKey('f', { ctrlKey: true }), null);
  assert.equal(mapKey('f', { metaKey: true }), null);
  assert.equal(mapKey('Escape', { ctrlKey: true }), null);
  assert.equal(mapKey('Escape', { metaKey: true }), null);
  assert.equal(mapKey('1', { altKey: true, ctrlKey: true }), null);
  assert.equal(mapKey('ArrowRight', { altKey: true }), null);
});

void test('unrelated keys map to null', () => {
  for (const keyValue of [
    'a',
    'Enter',
    ' ',
    'Tab',
    'F5',
    'Delete',
    '?',
    'ArrowUp',
    'ArrowDown',
  ]) {
    assert.equal(mapKey(keyValue), null, keyValue);
  }
  // Digits only work as mode toggles with Alt held.
  assert.equal(mapKey('1'), null);
  assert.equal(mapKey('5', { altKey: true }), null);
});

void test('typing targets are recognized for the input exemption', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'input' }), true);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isEditableTarget({}), false);
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget(undefined), false);
  assert.equal(isEditableTarget('input'), false);
});

// No React component test framework is installed; follow the repo convention
// (see reader-layout.test.ts) of asserting the wiring in the page source.
void test('PdfReader wires window keydown to the pure shortcut mapping', () => {
  assert.match(pageSource, /from '@\/lib\/reader-shortcuts'/);
  assert.match(pageSource, /const shortcut = mapShortcut\(event\)/);
  assert.match(
    pageSource,
    /window\.addEventListener\('keydown', handleKeyDown\)/,
  );
  assert.match(
    pageSource,
    /window\.removeEventListener\('keydown', handleKeyDown\)/,
  );
});

void test('PdfReader exempts typing targets but still dismisses and respects suspending', () => {
  assert.match(pageSource, /isEditableTarget\(event\.target\)/);
  assert.match(
    pageSource,
    /shortcut\.action !== 'dismiss' && isEditableTarget\(event\.target\)/,
  );
  assert.match(pageSource, /settingsOpenRef\.current/);
  assert.match(pageSource, /suspendedRef\.current/);
});

void test('PdfReader executes every shortcut action', () => {
  assert.match(pageSource, /goToPage\(pageRef\.current \+ 1\)/);
  assert.match(pageSource, /goToPage\(pageRef\.current - 1\)/);
  assert.match(pageSource, /goToPage\(Number\.MAX_SAFE_INTEGER\)/);
  assert.match(
    pageSource,
    /case 'zoomIn':\s*setZoom\(\(current\) => stepZoom\(current, 1\)\)/,
  );
  assert.match(
    pageSource,
    /case 'zoomOut':\s*setZoom\(\(current\) => stepZoom\(current, -1\)\)/,
  );
  assert.match(pageSource, /case 'zoomReset':\s*setZoom\(DEFAULT_ZOOM\)/);
  assert.match(
    pageSource,
    /case 'toggleRightMode':\s*setRightMode\(READER_RIGHT_MODES\[shortcut\.mode\]\)/,
  );
  assert.match(
    pageSource,
    /case 'collapseRightPanel':\s*setTranslationVisible\(false\)/,
  );
  assert.match(pageSource, /case 'dismiss':\s*setSettingsOpen\(false\)/);
});
