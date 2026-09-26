import { normalizeMathText } from './math-text.ts';
import { splitIntoColumns, type PdfTextItem } from './pdf-text.ts';

export interface ParagraphAlignment {
  sourceToTarget: number[][];
  targetToSource: number[][];
  mode: 'index' | 'estimated' | 'unavailable';
}

// Numbering is only ignored for scoring; displayed text and cache stay intact.
function scoringText(text: string): string {
  return text.trim().replace(/^(?:\d+[.)、]\s*|\[\d+\]\s*|[（(]\d+[)）]\s*)/u, '');
}

function entries(paragraphs: readonly string[]) {
  return paragraphs.map((text, index) => ({ text: scoringText(text), index }))
    .filter(({ text }) => text.length > 0);
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z][a-z\d]{2,}|\d+(?:\.\d+)?/g) ?? []);
}

/** No cross-language semantic claims: equal counts use order. Unequal counts
 * partition the longer array into contiguous, non-empty groups, minimizing
 * relative-length error with a small shared-token bonus. Empty entries retain
 * their original indices but have no links. Merged output can highlight a group.
 * Reordered/omitted model output cannot be reliably recovered without metadata.
 */
export function alignParagraphs(source: readonly string[], target: readonly string[]): ParagraphAlignment {
  const result: ParagraphAlignment = {
    sourceToTarget: source.map(() => []), targetToSource: target.map(() => []), mode: 'unavailable',
  };
  const left = entries(source);
  const right = entries(target);
  if (!left.length || !right.length) return result;
  const link = (s: number, t: number) => {
    result.sourceToTarget[s].push(t);
    result.targetToSource[t].push(s);
  };
  if (left.length === right.length) {
    result.mode = 'index';
    left.forEach((item, index) => link(item.index, right[index].index));
    return result;
  }
  result.mode = 'estimated';
  const longer = left.length > right.length ? left : right;
  const shorter = left.length > right.length ? right : left;
  const weights = (items: typeof left) => {
    const lengths = items.map(({ text }) => Math.max(1, text.replace(/\s/g, '').length));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    return lengths.map((length) => length / total);
  };
  const longWeights = weights(longer);
  const shortWeights = weights(shorter);
  const prefix = [0];
  longWeights.forEach((weight) => prefix.push(prefix.at(-1)! + weight));
  let boundaries: number[];
  // Bound pathological model output. This fallback remains ordered and covers
  // every non-empty paragraph; it is still explicitly labelled an estimate.
  if (longer.length > 200) {
    boundaries = Array.from({ length: shorter.length + 1 }, (_, i) => Math.round(i * longer.length / shorter.length));
  } else {
    const costs = Array.from({ length: shorter.length + 1 }, () => Array(longer.length + 1).fill(Infinity) as number[]);
    const previous = costs.map((row) => row.map(() => -1));
    costs[0][0] = 0;
    const longTokens = longer.map(({ text }) => tokens(text));
    const shortTokens = shorter.map(({ text }) => tokens(text));
    for (let group = 1; group <= shorter.length; group++) {
      for (let end = group; end <= longer.length - (shorter.length - group); end++) {
        const combined = new Set<string>();
        for (let start = end - 1; start >= group - 1; start--) {
          longTokens[start].forEach((token) => combined.add(token));
          const shared = [...shortTokens[group - 1]].filter((token) => combined.has(token)).length;
          const similarity = shared / Math.max(1, shortTokens[group - 1].size, combined.size);
          const cost = costs[group - 1][start]
            + Math.abs(prefix[end] - prefix[start] - shortWeights[group - 1]) - similarity * 0.15;
          if (cost < costs[group][end]) {
            costs[group][end] = cost;
            previous[group][end] = start;
          }
        }
      }
    }
    boundaries = [longer.length];
    for (let group = shorter.length; group > 0; group--) {
      boundaries.unshift(previous[group][boundaries[0]]);
    }
  }
  shorter.forEach((item, group) => {
    for (let index = boundaries[group]; index < boundaries[group + 1]; index++) {
      if (left.length > right.length) link(longer[index].index, item.index);
      else link(item.index, longer[index].index);
    }
  });
  return result;
}

function canonicalText(text: string): string {
  return normalizeMathText(text).normalize('NFKC').replace(/[\s\-\u00ad]/gu, '');
}

/** Map raw text items (original PDF.js order) back to normalized paragraph
 * indices. Reuse the existing column/furniture rules without changing parsing.
 * Match in reading order, consuming repeated strings once. Missing matches
 * remain untagged; never guess geometry from paragraph indices or page width.
 */
export function mapTextItemsToParagraphs(paragraphs: readonly string[], items: readonly PdfTextItem[]): number[][] {
  const result = items.map(() => [] as number[]);
  const indices = new Map(items.map((item, index) => [item, index]));
  let offset = 0;
  const ranges = paragraphs.map((text) => {
    const start = offset;
    offset += canonicalText(text).length;
    return { start, end: offset };
  });
  const text = paragraphs.map(canonicalText).join('');
  let cursor = 0;
  const ordered = splitIntoColumns(items.filter((item) => item.str.trim()))
    .flatMap((column) => [...column].sort((a, b) => a.y - b.y || a.x - b.x));
  for (const item of ordered) {
    const token = canonicalText(item.str);
    if (!token) continue;
    const start = text.indexOf(token, cursor);
    if (start < 0) continue;
    const end = start + token.length;
    result[indices.get(item)!] = ranges.flatMap((range, index) => range.start < end && range.end > start ? [index] : []);
    cursor = end;
  }
  return result;
}
