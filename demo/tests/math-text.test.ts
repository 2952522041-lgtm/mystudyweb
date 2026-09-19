import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMathText } from '../lib/math-text.ts';

void test('mathematical alphanumeric symbols fold to plain equivalents', () => {
  // Office equation exports: italic phi/theta/psi are U+1D711/U+1D703/U+1D713.
  assert.equal(
    normalizeMathText('R = Rotz(\u{1D711})Roty(\u{1D703})Rotz(\u{1D713})'),
    'R = Rotz(φ)Roty(θ)Rotz(ψ)',
  );
  assert.equal(normalizeMathText('\u{1D445} = \u{1D465}\u{1D706}'), 'R = xλ');
  assert.equal(normalizeMathText('\u{1D7CF}\u{1D7D0}\u{1D7D1}'), '123');
  assert.equal(normalizeMathText('\u{1D73D}\u{1D713}'), 'θψ');
});

void test('ligatures and letterlike symbols fold to plain text', () => {
  assert.equal(normalizeMathText('\uFB01le and \uFB00'), 'file and ff');
  assert.equal(
    normalizeMathText('\u2113 is the length symbol'),
    'l is the length symbol',
  );
});

void test('plain text is returned unchanged, including hard characters', () => {
  const preserved = [
    'φ θ ψ α β γ ω', // plain Greek already survives translation
    '中文段落，全角标点！？：', // full-width punctuation must not become half-width
    '①②③ ②〇二五年', // enclosed digits stay
    'x² + y³ = z', // superscripts stay
    '± × ÷ ≤ ≥ ≠ ≈ ∑ ∫ √ ∂ −', // operators stay
  ];
  for (const text of preserved) {
    assert.equal(normalizeMathText(text), text);
  }
});

void test('private use area characters are left untouched', () => {
  // PUA mappings are font-specific; guessing would corrupt text.
  const pua = 'broken export \uE00B\uE010';
  assert.equal(normalizeMathText(pua), pua);
});

void test('normalization is idempotent and works on mixed pages', () => {
  const mixed =
    '绕 \u{1D703} 轴旋转，R = Rotz(\u{1D711})Roty(\u{1D703})Rotz(\u{1D713})\n\nc\u{1D711}c\u{1D703}c\u{1D713} \u2212 s\u{1D711}s\u{1D713}';
  const once = normalizeMathText(mixed);
  assert.equal(once, '绕 θ 轴旋转，R = Rotz(φ)Roty(θ)Rotz(ψ)\n\ncφcθcψ − sφsψ');
  assert.equal(normalizeMathText(once), once);
});

void test('empty and ASCII-only text skip normalization work', () => {
  assert.equal(normalizeMathText(''), '');
  assert.equal(normalizeMathText('plain ascii only'), 'plain ascii only');
});
