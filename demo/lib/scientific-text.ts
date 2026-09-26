/** Delimited math is atomic even when it contains blank lines or nested environments. */
export interface MathSpan { start: number; end: number; value: string; body: string; display: boolean; closed: boolean }

export function mathSpans(text: string): MathSpan[] {
  const result: MathSpan[] = [];
  const opening = /\$\$|\$|\\\[|\\\(|\\begin\{([A-Za-z*]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text))) {
    const start = match.index;
    if ((text.slice(0, start).match(/\\+$/)?.[0].length ?? 0) % 2) continue;
    const delimiter = match[0];
    let end = -1;
    let bodyEnd = -1;
    if (match[1]) {
      const stack = [match[1]];
      const env = /\\(begin|end)\{([A-Za-z*]+)\}/g;
      env.lastIndex = opening.lastIndex;
      let next: RegExpExecArray | null;
      while ((next = env.exec(text))) {
        if (next[1] === 'begin') stack.push(next[2]);
        else if (stack.at(-1) === next[2]) stack.pop();
        else break;
        if (!stack.length) { end = env.lastIndex; bodyEnd = end; break; }
      }
    } else {
      const closing = delimiter === '\\[' ? '\\]' : delimiter === '\\(' ? '\\)' : delimiter;
      for (let index = opening.lastIndex; index < text.length; index++) {
        if (text.startsWith(closing, index) && (text.slice(0, index).match(/\\+$/)?.[0].length ?? 0) % 2 === 0) {
          end = index + closing.length; bodyEnd = index; break;
        }
      }
    }
    // Unmatched single dollars usually denote currency, not broken TeX.
    if (end < 0 && delimiter === '$') continue;
    const closed = end >= 0;
    if (!closed) { end = text.length; bodyEnd = end; }
    const value = text.slice(start, end);
    result.push({ start, end, value, body: match[1] ? value : text.slice(start + delimiter.length, bodyEnd),
      display: delimiter !== '$' && delimiter !== '\\(', closed });
    opening.lastIndex = end;
  }
  return result;
}

export function splitScientificParagraphs(text: string): string[] {
  const spans = mathSpans(text);
  const boundaries = [...text.matchAll(/\n\s*\n/g)].filter((match) => !spans.some((span) => match.index >= span.start && match.index < span.end));
  const parts: string[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    parts.push(text.slice(start, boundary.index).trim());
    start = boundary.index + boundary[0].length;
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

// Keep explicit notation and units out of the model's editable text. This is
// deliberately not a parser that guesses formulas from arbitrary prose.
const SCIENTIFIC = /[A-Za-z][A-Za-z0-9]*(?:[_^](?:\{[^{}\n]+\}|[A-Za-z0-9+−-]+))+[A-Za-z0-9]*|\b(?:m\/s[²³]?|N·m)\b[²³]?|[\u0370-\u03ff\u2070-\u209f℃℉Ω]|[≈≤≥±×÷→∑∫∂≠√∞−–—-]/gu;

export function protectScientificText(source: string) {
  let prefix = 'YYKEEP';
  while (source.includes(prefix)) prefix += 'X';
  const values = new Map<string, string>();
  const save = (value: string) => {
    const token = `${prefix}${values.size}ZZ`;
    values.set(token, value);
    return token;
  };
  let text = '';
  let cursor = 0;
  for (const span of mathSpans(source)) {
    text += source.slice(cursor, span.start).replace(SCIENTIFIC, save) + save(span.value);
    cursor = span.end;
  }
  text += source.slice(cursor).replace(SCIENTIFIC, save);
  const tokens = (value: string) => value.match(new RegExp(`${prefix}\\d+ZZ`, 'g')) ?? [];
  return {
    text,
    restore(output: string, input = text): string {
      const expected = tokens(input);
      const actual = tokens(output);
      if (expected.join('|') !== actual.join('|') || output.replace(new RegExp(`${prefix}\\d+ZZ`, 'g'), '').includes(prefix)) {
        throw new Error('公式或特殊字符的保护标记缺失、重复或顺序改变。');
      }
      // A model may wrap a marker in inline code. Restore math, not code.
      let restored = output.replace(new RegExp('`(' + prefix + '\\d+ZZ)`', 'g'), '$1');
      for (const token of expected) restored = restored.replace(token, () => values.get(token)!);
      return restored;
    },
  };
}

/** Never split a placeholder or a surrogate pair at a chunk boundary. */
export function safeScientificCut(text: string, cut: number): number {
  for (const span of mathSpans(text)) {
    if (span.start < cut && span.end > cut) return span.start || span.end;
  }
  for (const match of text.matchAll(/YYKEEPX*\d+ZZ/g)) {
    if (match.index < cut && match.index + match[0].length > cut) return match.index || match[0].length;
  }
  if (/[\uD800-\uDBFF]/.test(text[cut - 1] ?? '')) return cut - 1 || 2;
  return cut;
}
