import type { SourceReference } from '../course-storage/types.ts';

interface PageRange {
  start: number;
  end: number;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRange(value: RecordValue): PageRange | undefined {
  if (typeof value.pageStart !== 'number' || !Number.isSafeInteger(value.pageStart) || value.pageStart < 1) return undefined;
  const pageEnd = value.pageEnd === undefined || value.pageEnd === null ? value.pageStart : value.pageEnd;
  if (typeof pageEnd !== 'number' || !Number.isSafeInteger(pageEnd) || pageEnd < value.pageStart) return undefined;
  return { start: value.pageStart, end: pageEnd };
}

function mergeRanges(ranges: PageRange[]): PageRange[] {
  const sorted = ranges
    .map(range => ({ ...range }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: PageRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function indexAllowedRanges(allowed: readonly SourceReference[]): Map<string, Map<string, PageRange[]>> {
  const byDocument = new Map<string, Map<string, PageRange[]>>();
  for (const source of allowed) {
    if (!source || typeof source.documentId !== 'string' || typeof source.fileName !== 'string') continue;
    const range = readRange(source as unknown as RecordValue);
    if (!range) continue;
    let byFile = byDocument.get(source.documentId);
    if (!byFile) {
      byFile = new Map<string, PageRange[]>();
      byDocument.set(source.documentId, byFile);
    }
    const ranges = byFile.get(source.fileName) ?? [];
    ranges.push(range);
    byFile.set(source.fileName, ranges);
  }
  for (const byFile of byDocument.values()) {
    for (const [fileName, ranges] of byFile) byFile.set(fileName, mergeRanges(ranges));
  }
  return byDocument;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!isRecord(value)) return value;
  const result: RecordValue = {};
  for (const [key, child] of Object.entries(value)) result[key] = cloneJson(child);
  return result;
}

function groundSource(source: RecordValue, allowed: Map<string, Map<string, PageRange[]>>): { sources: RecordValue[]; didSplit: boolean } {
  if (typeof source.documentId !== 'string') return { sources: [source], didSplit: false };
  const sourceRange = readRange(source);
  if (!sourceRange) return { sources: [source], didSplit: false };
  const byFile = allowed.get(source.documentId);
  if (!byFile) return { sources: [source], didSplit: false };
  const fileName = source.fileName === undefined
    ? byFile.size === 1 ? byFile.keys().next().value : undefined
    : typeof source.fileName === 'string' ? source.fileName : undefined;
  if (typeof fileName !== 'string') return { sources: [source], didSplit: false };
  const ranges = byFile.get(fileName);
  if (!ranges?.length) return { sources: [source], didSplit: false };
  const covers = (page: number) => ranges.some(range => range.start <= page && page <= range.end);
  if (!covers(sourceRange.start) || !covers(sourceRange.end)) return { sources: [source], didSplit: false };
  const intersections = ranges
    .filter(range => range.end >= sourceRange.start && range.start <= sourceRange.end)
    .map(range => ({
      start: Math.max(sourceRange.start, range.start),
      end: Math.min(sourceRange.end, range.end),
    }));
  if (intersections.length <= 1) return { sources: [source], didSplit: false };
  return {
    sources: intersections.map(intersection => ({ ...source, pageStart: intersection.start, pageEnd: intersection.end })),
    didSplit: true,
  };
}

function groundValue(value: unknown, allowed: Map<string, Map<string, PageRange[]>>, state: { splitCount: number }): unknown {
  if (Array.isArray(value)) return value.map(child => groundValue(child, allowed, state));
  if (!isRecord(value)) return value;
  const result: RecordValue = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'provenance') {
      result[key] = cloneJson(child);
    } else if (key === 'sources' && Array.isArray(child)) {
      const sources: unknown[] = [];
      for (const source of child) {
        if (!isRecord(source)) {
          sources.push(cloneJson(source));
          continue;
        }
        const grounded = groundSource(source, allowed);
        if (grounded.didSplit) state.splitCount += 1;
        for (const item of grounded.sources) sources.push(cloneJson(item));
      }
      result[key] = sources;
    } else {
      result[key] = groundValue(child, allowed, state);
    }
  }
  return result;
}

export function groundSourceRanges(
  raw: unknown,
  allowed: readonly SourceReference[],
): { raw: unknown; splitCount: number } {
  const state = { splitCount: 0 };
  return { raw: groundValue(raw, indexAllowedRanges(allowed), state), splitCount: state.splitCount };
}
