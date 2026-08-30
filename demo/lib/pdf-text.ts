export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LineBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormalizedPageText {
  paragraphs: string[];
  text: string;
}

const MIN_EXTRACTABLE_LENGTH = 24;
const COLUMN_GAP_RATIO = 0.08;
const HYPHEN_PATTERN = /[A-Za-z]-$/;
const SENTENCE_END_PATTERN = /[.!?。！？”"']$/;

export function pageHasText(items: PdfTextItem[]): boolean {
  const length = items.reduce((sum, item) => sum + item.str.trim().length, 0);
  return length >= MIN_EXTRACTABLE_LENGTH;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mergeIntervals(
  intervals: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * Detects a two-column layout by looking for a vertical gutter that no text
 * item crosses. Returns item groups ordered left-to-right; a single-column
 * page yields one group containing every item.
 */
export function splitIntoColumns(items: PdfTextItem[]): PdfTextItem[][] {
  if (items.length < 4) return [items];

  const intervals = items.map((item) => ({ start: item.x, end: item.x + item.width }));
  const merged = mergeIntervals(intervals);
  if (merged.length < 2) return [items];

  const gutter = Math.max(...merged.slice(1).map((column, index) => column.start - merged[index].end));
  const pageWidth = Math.max(...items.map((item) => item.x + item.width)) - Math.min(...items.map((item) => item.x));
  if (gutter < pageWidth * COLUMN_GAP_RATIO) return [items];

  const groups = merged.map(() => [] as PdfTextItem[]);
  for (const item of items) {
    const center = item.x + item.width / 2;
    const index = merged.findIndex((column) => center >= column.start && center <= column.end);
    groups[index === -1 ? 0 : index].push(item);
  }
  return groups.filter((group) => group.length > 0);
}

export function groupLines(items: PdfTextItem[]): LineBox[] {
  if (items.length === 0) return [];
  const tolerance = Math.max(median(items.map((item) => item.height)) * 0.5, 1);
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);

  const lines: Array<{ y: number; items: PdfTextItem[] }> = [];
  for (const item of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(item.y - line.y) <= tolerance) {
      line.items.push(item);
      line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  return lines.map((line) => {
    const ordered = [...line.items].sort((a, b) => a.x - b.x);
    const x = ordered[0].x;
    const end = Math.max(...ordered.map((item) => item.x + item.width));
    return {
      text: lineText(ordered),
      x,
      y: line.y,
      width: end - x,
      height: Math.max(...ordered.map((item) => item.height)),
    };
  });
}

function lineText(items: PdfTextItem[]): string {
  let text = '';
  let previousEnd = 0;
  for (const item of items) {
    const value = item.str;
    if (text === '') {
      text = value;
    } else {
      const gap = item.x - previousEnd;
      const needsSpace =
        gap > item.height * 0.18 &&
        !/\s$/.test(text) &&
        !/^\s/.test(value) &&
        !isCjk(text[text.length - 1]) &&
        !isCjk(value[0]);
      text += `${needsSpace ? ' ' : ''}${value}`;
    }
    previousEnd = item.x + item.width;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function isCjk(char: string | undefined): boolean {
  return char !== undefined && /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char);
}

function joinLines(previous: string, next: string): string {
  if (HYPHEN_PATTERN.test(previous) && /^[a-z]/.test(next)) {
    return `${previous.slice(0, -1)}${next}`;
  }
  const cjkBoundary = isCjk(previous[previous.length - 1]) && isCjk(next[0]);
  return `${previous}${cjkBoundary ? '' : ' '}${next}`;
}

function startsNewParagraph(previous: LineBox, current: LineBox, typicalGap: number, columnRight: number): boolean {
  const gap = current.y - previous.y;
  if (gap > typicalGap * 1.6) return true;
  const indented = current.x > previous.x + current.height * 0.8;
  if (SENTENCE_END_PATTERN.test(previous.text) && indented) return true;
  const previousEndsShort = previous.x + previous.width < columnRight - current.height * 2;
  if (SENTENCE_END_PATTERN.test(previous.text) && previousEndsShort) return true;
  return false;
}

function buildParagraphs(lines: LineBox[]): string[] {
  if (lines.length === 0) return [];
  const lineHeight = median(lines.map((line) => line.height)) || 1;
  const gaps = lines.slice(1).map((line, index) => line.y - lines[index].y).filter((gap) => gap > lineHeight * 0.2);
  const typicalGap = Math.max(gaps.length > 0 ? Math.min(...gaps) : lineHeight, lineHeight * 0.8);
  const columnRight = Math.max(...lines.map((line) => line.x + line.width));

  const paragraphs: string[] = [];
  let current = lines[0].text;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (startsNewParagraph(lines[index - 1], line, typicalGap, columnRight)) {
      paragraphs.push(current);
      current = line.text;
    } else {
      current = joinLines(current, line.text);
    }
  }
  paragraphs.push(current);
  return paragraphs.filter((paragraph) => paragraph.length > 0);
}

/**
 * Normalizes raw PDF text items into paragraphs: lines are grouped by
 * baseline, ordered per detected columns, hyphenated words are rejoined, and
 * paragraph boundaries are inferred from gaps, indents, and sentence ends.
 */
export function normalizePage(items: PdfTextItem[]): NormalizedPageText {
  const usable = items.filter((item) => item.str.trim().length > 0);
  if (usable.length === 0) return { paragraphs: [], text: '' };

  const columns = splitIntoColumns(usable);
  const paragraphs: string[] = [];
  for (const column of columns) {
    paragraphs.push(...buildParagraphs(groupLines(column)));
  }
  return { paragraphs, text: paragraphs.join('\n\n') };
}

export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Converts pdf.js text-content items into page-space items with a top-left
 * origin: pdf.js reports the baseline in PDF coordinates (y grows upward),
 * while the pipeline orders lines top-to-bottom.
 */
export function itemsFromPdfJs(
  items: ReadonlyArray<{
    str?: string;
    transform?: number[];
    width?: number;
    height?: number;
  }>,
  pageHeight: number,
): PdfTextItem[] {
  const converted: PdfTextItem[] = [];
  for (const item of items) {
    if (!item.str || item.str.trim().length === 0) continue;
    const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
    converted.push({
      str: item.str,
      x: transform[4],
      y: pageHeight - transform[5],
      width: item.width ?? 0,
      height: item.height ?? (Math.abs(transform[3]) || 10),
    });
  }
  return converted.sort((a, b) => a.y - b.y || a.x - b.x);
}
