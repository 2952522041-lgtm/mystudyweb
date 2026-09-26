/**
 * PDF exports of Office/PowerPoint equations encode letters as Mathematical
 * Alphanumeric Symbols (U+1D400–U+1D7FF), e.g. `𝜑` instead of `φ`, and some
 * producers map ligatures (`ﬁ`) or letterlike symbols (`ℓ`) the same way.
 * Translation models corrupt or silently drop these codepoints, which turns
 * `R = Rotz(𝜑)` into `R = Rotz()` in the translation. Plain Greek letters
 * survive, so compatibility characters are folded to their plain equivalents
 * before extracted text reaches a model.
 *
 * Normalization is deliberately limited to these ranges: full NFKC would also
 * rewrite full-width CJK punctuation, enclosed digits, and superscripts that
 * models already handle correctly.
 */
const COMPATIBILITY_CHARACTER =
  /[\u2100-\u214F\uFB00-\uFB4F\u{1D400}-\u{1D7FF}]/u;
const COMPATIBILITY_CHARACTERS =
  /[\u2100-\u214F\uFB00-\uFB4F\u{1D400}-\u{1D7FF}]/gu;

/**
 * Folds mathematical/compatibility characters to plain text: `𝜑` → `φ`,
 * `𝑥` → `x`, `𝟏` → `1`, `ﬁ` → `fi`, `ℓ` → `l`. Everything else — CJK,
 * full-width punctuation, enclosed digits, superscripts, operators — is
 * returned unchanged.
 */
export function normalizeMathText(text: string): string {
  if (!COMPATIBILITY_CHARACTER.test(text)) return text;
  return text.replace(COMPATIBILITY_CHARACTERS, (character) =>
    // Temperature and electrical units are meaningful symbols, not ligatures.
    /[℃℉Ω]/u.test(character) ? character : character.normalize('NFKC'),
  );
}
