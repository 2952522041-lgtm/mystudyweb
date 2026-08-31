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
const MIN_COLUMN_SIDE_RATIO = 0.16;
const MAX_GUTTER_CROSSING_RATIO = 0.25;
const HYPHEN_PATTERN = /[A-Za-z]-$/;
const SENTENCE_END_PATTERN = /[.!?。！？”"']$/;
const RUNNING_HEADER_PATTERN = /\(\d{4}\).*\d+\s*[:：]\s*\d+\s*[–—-]\s*\d+/u;

export function pageHasText(items: PdfTextItem[]): boolean {
  const length = items.reduce((sum, item) => sum + item.str.trim().length, 0);
  return length >= MIN_EXTRACTABLE_LENGTH;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function withoutPageFurniture(items: PdfTextItem[]): PdfTextItem[] {
  if (items.length === 0) return [];
  const lineHeight = median(items.map((item) => item.height)) || 1;
  const top = Math.min(...items.map((item) => item.y));
  const bottom = Math.max(...items.map((item) => item.y));
  const edgeSize = lineHeight * 1.8;

  return items.filter((item) => {
    const text = item.str.trim();
    const atTop = item.y <= top + edgeSize;
    const atBottom = item.y >= bottom - edgeSize;
    if ((atTop || atBottom) && /^\d{1,4}$/.test(text)) return false;
    if (atTop && RUNNING_HEADER_PATTERN.test(text)) return false;
    return true;
  });
}

function detectColumnGutter(items: PdfTextItem[]): number | null {
  if (items.length < 4) return null;
  const pageLeft = Math.min(...items.map((item) => item.x));
  const pageRight = Math.max(...items.map((item) => item.x + item.width));
  const pageWidth = pageRight - pageLeft;
  if (pageWidth <= 0) return null;

  const minimumSideItems = Math.max(
    2,
    Math.floor(items.length * MIN_COLUMN_SIDE_RATIO),
  );
  const pageCenter = pageLeft + pageWidth / 2;
  const searchStart = pageLeft + pageWidth * 0.3;
  const searchEnd = pageLeft + pageWidth * 0.7;
  const step = Math.max(pageWidth / 240, 0.5);
  let best: { x: number; score: number } | null = null;

  for (let x = searchStart; x <= searchEnd; x += step) {
    const left = items.filter((item) => item.x + item.width <= x);
    const right = items.filter((item) => item.x >= x);
    if (left.length < minimumSideItems || right.length < minimumSideItems) {
      continue;
    }
    const crossing = items.length - left.length - right.length;
    const crossingRatio = crossing / items.length;
    if (crossingRatio > MAX_GUTTER_CROSSING_RATIO) continue;

    const leftTop = Math.min(...left.map((item) => item.y));
    const leftBottom = Math.max(...left.map((item) => item.y));
    const rightTop = Math.min(...right.map((item) => item.y));
    const rightBottom = Math.max(...right.map((item) => item.y));
    const overlap = Math.max(
      0,
      Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop),
    );
    const shorterSpan = Math.min(leftBottom - leftTop, rightBottom - rightTop);
    if (shorterSpan > 0 && overlap / shorterSpan < 0.35) continue;

    const imbalance = Math.abs(left.length - right.length) / items.length;
    const centerDistance = Math.abs(x - pageCenter) / pageWidth;
    const score = crossingRatio + imbalance * 0.04 + centerDistance * 0.01;
    if (!best || score < best.score) best = { x, score };
  }
  return best?.x ?? null;
}

function clusterSpanningItems(items: PdfTextItem[]): PdfTextItem[][] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const threshold = (median(sorted.map((item) => item.height)) || 1) * 2.2;
  const clusters: PdfTextItem[][] = [];
  for (const item of sorted) {
    const cluster = clusters[clusters.length - 1];
    const previous = cluster?.[cluster.length - 1];
    if (cluster && previous && item.y - previous.y <= threshold) {
      cluster.push(item);
    } else {
      clusters.push([item]);
    }
  }
  return clusters;
}

/**
 * Detects a two-column layout from a low-occupancy vertical gutter. A real
 * journal gutter can be only 3–4% of the page width, and full-width titles or
 * abstracts may cross it, so requiring a wide completely empty strip causes
 * dense papers to be read as interleaved single-column text.
 *
 * Groups are returned in reading order. Full-width blocks split the page into
 * vertical bands; each band is read left column first, then right column.
 */
export function splitIntoColumns(items: PdfTextItem[]): PdfTextItem[][] {
  const usable = withoutPageFurniture(items);
  if (usable.length < 4) return [usable];
  const gutter = detectColumnGutter(usable);
  if (gutter === null) return [usable];

  let left = usable.filter((item) => item.x + item.width <= gutter);
  let right = usable.filter((item) => item.x >= gutter);
  const spanning = usable.filter(
    (item) => item.x < gutter && item.x + item.width > gutter,
  );
  if (spanning.length === 0) return [left, right];

  const groups: PdfTextItem[][] = [];
  for (const cluster of clusterSpanningItems(spanning)) {
    const clusterTop = Math.min(...cluster.map((item) => item.y));
    const beforeLeft = left.filter((item) => item.y < clusterTop);
    const beforeRight = right.filter((item) => item.y < clusterTop);
    if (beforeLeft.length > 0) groups.push(beforeLeft);
    if (beforeRight.length > 0) groups.push(beforeRight);
    groups.push(cluster);
    left = left.filter((item) => item.y >= clusterTop);
    right = right.filter((item) => item.y >= clusterTop);
  }
  if (left.length > 0) groups.push(left);
  if (right.length > 0) groups.push(right);
  return groups;
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
  return (
    char !== undefined && /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)
  );
}

function joinLines(previous: string, next: string): string {
  if (HYPHEN_PATTERN.test(previous) && /^[a-z]/.test(next)) {
    return `${previous.slice(0, -1)}${next}`;
  }
  const cjkBoundary = isCjk(previous[previous.length - 1]) && isCjk(next[0]);
  return `${previous}${cjkBoundary ? '' : ' '}${next}`;
}

function startsNewParagraph(
  previous: LineBox,
  current: LineBox,
  typicalGap: number,
  columnRight: number,
): boolean {
  const gap = current.y - previous.y;
  if (gap > typicalGap * 1.6) return true;
  const indented = current.x > previous.x + current.height * 0.8;
  if (SENTENCE_END_PATTERN.test(previous.text) && indented) return true;
  const previousEndsShort =
    previous.x + previous.width < columnRight - current.height * 2;
  if (SENTENCE_END_PATTERN.test(previous.text) && previousEndsShort)
    return true;
  return false;
}

function buildParagraphs(lines: LineBox[]): string[] {
  if (lines.length === 0) return [];
  const lineHeight = median(lines.map((line) => line.height)) || 1;
  const gaps = lines
    .slice(1)
    .map((line, index) => line.y - lines[index].y)
    .filter((gap) => gap > lineHeight * 0.2);
  const typicalGap = Math.max(
    gaps.length > 0 ? Math.min(...gaps) : lineHeight,
    lineHeight * 0.8,
  );
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
  const data =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
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
