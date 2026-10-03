export const MAX_DIFF_CELLS = 40_000;

export interface SummaryDiffSegment {
  kind: 'equal' | 'added' | 'removed';
  text: string;
}

export interface SummaryDiff {
  segments: SummaryDiffSegment[];
  added: number;
  removed: number;
  unchanged: number;
  coarse: boolean;
}

interface Fence {
  character: '`' | '~';
  length: number;
}

function openingFence(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;

  const marker = match[1];
  const info = match[2];
  if (marker.startsWith('`') && info.includes('`')) return undefined;

  return { character: marker[0] as '`' | '~', length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[\t ]*$/.exec(line);
  if (!match) return false;

  const marker = match[1];
  return marker[0] === fence.character && marker.length >= fence.length;
}

export function splitSummaryParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fence: Fence | undefined;
  let inMath = false;

  const finishParagraph = () => {
    const paragraph = current.join('\n').trim();
    if (paragraph) paragraphs.push(paragraph);
    current = [];
  };

  for (const line of lines) {
    if (fence) {
      current.push(line);
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }

    if (!inMath && line.trim() === '') {
      finishParagraph();
      continue;
    }

    current.push(line);
    if (inMath) {
      if (line.trim() === '$$') inMath = false;
      continue;
    }

    if (line.trim() === '$$') {
      inMath = true;
      continue;
    }

    fence = openingFence(line);
  }

  finishParagraph();
  return paragraphs;
}

function segment(
  kind: SummaryDiffSegment['kind'],
  text: string,
): SummaryDiffSegment {
  return { kind, text };
}

function summarize(
  segments: SummaryDiffSegment[],
  coarse: boolean,
): SummaryDiff {
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  for (const item of segments) {
    if (item.kind === 'added') added += 1;
    else if (item.kind === 'removed') removed += 1;
    else unchanged += 1;
  }

  return { segments, added, removed, unchanged, coarse };
}

export function compareSummaryParagraphs(
  before: string,
  after: string,
): SummaryDiff {
  const oldParagraphs = splitSummaryParagraphs(before);
  const newParagraphs = splitSummaryParagraphs(after);
  let prefixLength = 0;

  while (
    prefixLength < oldParagraphs.length &&
    prefixLength < newParagraphs.length &&
    oldParagraphs[prefixLength] === newParagraphs[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldParagraphs.length - prefixLength &&
    suffixLength < newParagraphs.length - prefixLength &&
    oldParagraphs[oldParagraphs.length - suffixLength - 1] ===
      newParagraphs[newParagraphs.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const oldEnd = oldParagraphs.length - suffixLength;
  const newEnd = newParagraphs.length - suffixLength;
  const oldLength = oldEnd - prefixLength;
  const newLength = newEnd - prefixLength;
  const segments: SummaryDiffSegment[] = [];

  for (let index = 0; index < prefixLength; index += 1) {
    segments.push(segment('equal', oldParagraphs[index]));
  }

  const tooLarge =
    newLength > 0 && oldLength > Math.floor(MAX_DIFF_CELLS / newLength);
  if (tooLarge) {
    for (let index = prefixLength; index < oldEnd; index += 1) {
      segments.push(segment('removed', oldParagraphs[index]));
    }
    for (let index = prefixLength; index < newEnd; index += 1) {
      segments.push(segment('added', newParagraphs[index]));
    }
    for (
      let index = oldParagraphs.length - suffixLength;
      index < oldParagraphs.length;
      index += 1
    ) {
      segments.push(segment('equal', oldParagraphs[index]));
    }
    return summarize(segments, true);
  }

  // Store exactly oldLength * newLength cells so the allocation follows the
  // public bound, including the empty-row/column cases without extra sentinels.
  const lcs = new Uint32Array(oldLength * newLength);
  const valueAt = (oldIndex: number, newIndex: number) => {
    if (oldIndex >= oldLength || newIndex >= newLength) return 0;
    return lcs[oldIndex * newLength + newIndex];
  };

  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
      const cellIndex = oldIndex * newLength + newIndex;
      if (
        oldParagraphs[prefixLength + oldIndex] ===
        newParagraphs[prefixLength + newIndex]
      ) {
        lcs[cellIndex] = valueAt(oldIndex + 1, newIndex + 1) + 1;
      } else {
        lcs[cellIndex] = Math.max(
          valueAt(oldIndex + 1, newIndex),
          valueAt(oldIndex, newIndex + 1),
        );
      }
    }
  }

  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLength && newIndex < newLength) {
    const oldText = oldParagraphs[prefixLength + oldIndex];
    const newText = newParagraphs[prefixLength + newIndex];
    if (oldText === newText) {
      segments.push(segment('equal', oldText));
      oldIndex += 1;
      newIndex += 1;
    } else if (
      valueAt(oldIndex + 1, newIndex) >= valueAt(oldIndex, newIndex + 1)
    ) {
      // On an LCS tie, consume the before paragraph first.
      segments.push(segment('removed', oldText));
      oldIndex += 1;
    } else {
      segments.push(segment('added', newText));
      newIndex += 1;
    }
  }

  while (oldIndex < oldLength) {
    segments.push(segment('removed', oldParagraphs[prefixLength + oldIndex]));
    oldIndex += 1;
  }
  while (newIndex < newLength) {
    segments.push(segment('added', newParagraphs[prefixLength + newIndex]));
    newIndex += 1;
  }
  for (
    let index = oldParagraphs.length - suffixLength;
    index < oldParagraphs.length;
    index += 1
  ) {
    segments.push(segment('equal', oldParagraphs[index]));
  }

  return summarize(segments, false);
}
