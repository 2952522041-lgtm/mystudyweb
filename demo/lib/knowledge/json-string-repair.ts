import { jsonrepair } from 'jsonrepair';

const SIMPLE_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

const CONTROL_ESCAPES: Record<string, string> = {
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function isHexDigit(char: string | undefined): boolean {
  return char !== undefined && /^[0-9a-fA-F]$/.test(char);
}

/**
 * Repair malformed escape bytes inside JSON strings without changing JSON
 * structure or guessing the intended meaning of document text.
 */
export function repairJsonStringEscapes(text: string): string {
  let inString = false;
  let repaired = '';

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === '\\') {
      const next = text[index + 1];
      if (next !== undefined && SIMPLE_JSON_ESCAPES.has(next)) {
        repaired += char + next;
        index += 1;
        continue;
      }
      if (
        next === 'u' &&
        isHexDigit(text[index + 2]) &&
        isHexDigit(text[index + 3]) &&
        isHexDigit(text[index + 4]) &&
        isHexDigit(text[index + 5])
      ) {
        repaired += text.slice(index, index + 6);
        index += 5;
        continue;
      }

      // Keep the original backslash as a literal character in the decoded
      // value, then process the following character normally.
      repaired += '\\\\';
      continue;
    }

    const code = char.charCodeAt(0);
    if (code <= 0x1f) {
      repaired +=
        CONTROL_ESCAPES[char] ?? `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    repaired += char;
  }

  return repaired;
}

/** Accept only character-preserving string repairs, never reconstructed JSON. */
export function parseJsonPreservingText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    /* Try string escapes only. */
  }
  const escaped = repairJsonStringEscapes(text);
  try {
    return JSON.parse(escaped) as unknown;
  } catch (syntaxError) {
    let candidate: string;
    try {
      candidate = jsonrepair(escaped);
    } catch {
      candidate = escapeEmbeddedValueQuotes(escaped);
    }
    let cursor = 0;
    for (let index = 0; index < escaped.length; index++, cursor++) {
      if (candidate[cursor] === escaped[index]) continue;
      // The library may propose broad repairs. Only insertion of a backslash
      // before an existing quote is allowed here; no changed/deleted text,
      // fabricated delimiters, missing fields or truncated objects are accepted.
      if (
        escaped[index] === '"' &&
        candidate[cursor] === '\\' &&
        candidate[cursor + 1] === '"'
      ) {
        // An unescaped "key": fragment could be a damaged object field.
        // Refuse to silently fold it into a preceding prose value.
        let next = index + 1;
        while (next < escaped.length && /\s/.test(escaped[next])) next++;
        if (escaped[next] === ':') throw syntaxError;
        cursor++;
      } else throw syntaxError;
    }
    if (cursor !== candidate.length) throw syntaxError;
    return JSON.parse(candidate) as unknown;
  }
}

/** Paired quotes in code-valued strings, e.g. str="hello" inside a summary. */
function escapeEmbeddedValueQuotes(text: string): string {
  let result = '';
  let inString = false;
  let valueString = false;
  let innerQuote = false;
  let previousToken = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!inString) {
      result += char;
      if (char === '"') {
        inString = true;
        valueString = previousToken === ':';
        innerQuote = false;
      }
      if (!/\s/.test(char)) previousToken = char;
      continue;
    }
    if (char === '\\') {
      result += text.slice(index, index + 2);
      index++;
      continue;
    }
    if (char !== '"') {
      result += char;
      continue;
    }
    if (valueString) {
      let after = index + 1;
      while (after < text.length && /\s/.test(text[after])) after++;
      const next = text[after];
      if (innerQuote) {
        result += '\\"';
        innerQuote = false;
        continue;
      }
      // An adjacent quoted field or a colon may be missing JSON punctuation;
      // never hide such structure errors by turning fields into prose.
      if (next === '"' || next === ':') return text;
      if (next !== undefined && ![',', '}', ']'].includes(next)) {
        result += '\\"';
        innerQuote = true;
        continue;
      }
    }
    result += char;
    inString = false;
    previousToken = char;
  }
  return result;
}
