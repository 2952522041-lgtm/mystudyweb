import assert from 'node:assert/strict';
import test from 'node:test';
import { mathSpans, protectScientificText, safeScientificCut, splitScientificParagraphs } from '../lib/scientific-text.ts';

void test('nested environments and blank lines are atomic, escaped currency is prose', () => {
  const formula = String.raw`\begin{align}A=\begin{matrix}1&2\\

3&4\end{matrix}\end{align}`;
  const text = `Before ${formula}\n\nAfter \\$5`;
  assert.deepEqual(splitScientificParagraphs(text), [`Before ${formula}`, 'After \\$5']);
  assert.equal(mathSpans(text)[0].value, formula);
  assert.equal(mathSpans(text).length, 1);
});

void test('colliding placeholder text, code wrappers and every scientific symbol round trip', () => {
  const source = 'YYKEEP0ZZ $x$ H_2O x^2 α β γ θ μ Ω ≈ ≤ ≥ ± × ÷ → ∑ ∫ ∂ m/s² N·m ℃ - – —';
  const protectedText = protectScientificText(source);
  assert.equal(protectedText.restore(protectedText.text), source);
  assert.equal(protectedText.restore(protectedText.text.replace(/(YYKEEPX\d+ZZ)/g, '`$1`')), source);
});

void test('chunk boundaries do not cut placeholders or Unicode surrogate pairs', () => {
  assert.equal(safeScientificCut('text YYKEEP12ZZ after', 8), 5);
  assert.equal(safeScientificCut('𝜑value', 1), 2);
});

void test('Latin-1 superscripts and micro/degree symbols are protected as well as Greek Unicode', () => {
  const source = 'x² y³ z¹ 25 °C 4 µm';
  const protectedText = protectScientificText(source);
  assert.doesNotMatch(protectedText.text, /[²³¹µ°]/u);
  assert.equal(protectedText.restore(protectedText.text), source);
  assert.throws(() => protectedText.restore(protectedText.text.replace(/YYKEEP\d+ZZ/, '')));
});
