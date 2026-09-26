import assert from 'node:assert/strict';
import test from 'node:test';
import { revealParagraph, sourceParagraphIndices } from '../lib/paragraph-dom.ts';

function fixture(top: number, bottom: number, left = 10, right = 90) {
  const pane = { scrollTop: 0, scrollLeft: 0, clientHeight: 100, clientWidth: 100,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, right: 100 }) };
  const element = { closest: () => pane, getBoundingClientRect: () => ({ top, bottom, left, right }) } as unknown as HTMLElement;
  return { pane, element };
}
void test('visible paragraphs do not move the reader pane', () => {
  const { pane, element } = fixture(20, 60);
  revealParagraph(element, '.document-stage');
  assert.equal(pane.scrollTop, 0);
  assert.equal(pane.scrollLeft, 0);
  revealParagraph(null, '.document-stage');
});
void test('reveal includes every line and confines vertical/horizontal scrolling to the owning pane', () => {
  const { pane, element } = fixture(80, 95, 140, 180);
  const second = fixture(96, 115, 140, 180).element;
  revealParagraph(element, '.document-stage', [element, second]);
  assert.equal(pane.scrollTop, 47.5);
  assert.equal(pane.scrollLeft, 110);
});
void test('oversized groups reveal their start, and paragraph tags reject invalid indices', () => {
  const { pane, element } = fixture(80, 280);
  revealParagraph(element, '.document-stage');
  assert.equal(pane.scrollTop, 72);
  assert.deepEqual(sourceParagraphIndices({ getAttribute: () => '0 2 -1 NaN 1.5' } as unknown as Element), [0, 2]);
  assert.deepEqual(sourceParagraphIndices({ getAttribute: () => null } as unknown as Element), []);
});
