/**
 * Defensive helpers for retaining detailed original chunk sections instead of
 * letting the final model rewrite them.
 *
 * Chunk ordering is the caller's responsibility: `collectPreservedSections`
 * concatenates in the order it receives, never deduplicating titles.
 */

/** A single preserved point: original Markdown/LaTeX text plus its pages. */
export interface PreservedPoint {
  text: string;
  pageStart: number;
  pageEnd?: number | null;
  [key: string]: unknown;
}

/** A preserved section: title/summary plus optional points and extensions. */
export interface PreservedSection {
  title: string;
  summary: string;
  pageStart: number;
  pageEnd?: number | null;
  points?: PreservedPoint[];
  [key: string]: unknown;
}

type UnknownRecord = Record<string, unknown>;

function isNonArrayObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonBlankString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank string`);
  }
}

function assertPositiveInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

/**
 * Shared page-range protocol: `pageStart` is required and positive; `pageEnd`
 * may be omitted/undefined/null (meaning `pageStart`) or a positive integer
 * `>= pageStart`. The original shape is intentionally left untouched.
 */
function assertValidPageRange(record: UnknownRecord, label: string): void {
  assertPositiveInteger(record.pageStart, `${label}.pageStart`);
  const { pageEnd } = record;
  if (pageEnd === undefined || pageEnd === null) {
    return;
  }
  assertPositiveInteger(pageEnd, `${label}.pageEnd`);
  if (pageEnd < (record.pageStart as number)) {
    throw new TypeError(`${label}.pageEnd must be >= ${label}.pageStart`);
  }
}

function assertValidPreservedPoint(
  value: unknown,
  label: string,
): asserts value is PreservedPoint {
  if (!isNonArrayObject(value)) {
    throw new TypeError(`${label} must be a non-array object`);
  }
  assertNonBlankString(value.text, `${label}.text`);
  assertValidPageRange(value, label);
}

function assertValidPreservedSection(
  value: unknown,
  label: string,
): asserts value is PreservedSection {
  if (!isNonArrayObject(value)) {
    throw new TypeError(`${label} must be a non-array object`);
  }
  assertNonBlankString(value.title, `${label}.title`);
  assertNonBlankString(value.summary, `${label}.summary`);
  assertValidPageRange(value, label);
  const { points } = value;
  if (points === undefined) {
    return;
  }
  if (!Array.isArray(points)) {
    throw new TypeError(`${label}.points must be an array`);
  }
  // Indexed iteration (not forEach) so sparse holes surface as `undefined`
  // and are rejected instead of being silently skipped.
  for (let index = 0; index < points.length; index += 1) {
    assertValidPreservedPoint(points[index], `${label}.points[${index}]`);
  }
}

/**
 * Collect deep copies of every section found in `chunks`, in input chunk order
 * and per-chunk section order. Chunks must be a nonempty array of non-array
 * objects, each carrying a nonempty `sections` array of valid sections.
 */
export function collectPreservedSections(
  chunks: readonly unknown[],
): PreservedSection[] {
  if (!Array.isArray(chunks)) {
    throw new TypeError('chunks must be an array');
  }
  if (chunks.length === 0) {
    throw new TypeError('chunks must be a nonempty array');
  }

  const collected: PreservedSection[] = [];
  // Indexed iteration (not forEach) so sparse holes surface as `undefined`
  // and are rejected instead of being silently skipped.
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const chunkLabel = `chunks[${chunkIndex}]`;
    if (!isNonArrayObject(chunk)) {
      throw new TypeError(`${chunkLabel} must be a non-array object`);
    }
    const { sections } = chunk;
    if (!Array.isArray(sections)) {
      throw new TypeError(`${chunkLabel}.sections must be an array`);
    }
    if (sections.length === 0) {
      throw new TypeError(`${chunkLabel}.sections must be a nonempty array`);
    }
    for (
      let sectionIndex = 0;
      sectionIndex < sections.length;
      sectionIndex += 1
    ) {
      const section = sections[sectionIndex];
      const sectionLabel = `${chunkLabel}.sections[${sectionIndex}]`;
      assertValidPreservedSection(section, sectionLabel);
      collected.push(structuredClone(section) as PreservedSection);
    }
  }

  return collected;
}

/**
 * Replace `raw.sections` with deep clones of `sections` and return `raw`.
 *
 * All validation and cloning completes before the single assignment, so a
 * failure can never leave `raw` partially replaced. The assignment (not an
 * append) makes repeated calls idempotent and discards any existing model
 * sections, even malformed ones. Every other `raw` field keeps its identity.
 */
export function replacePreservedSections<T extends Record<string, unknown>>(
  raw: T,
  sections: readonly PreservedSection[],
): T & { sections: PreservedSection[] } {
  if (!isNonArrayObject(raw)) {
    throw new TypeError('raw must be a non-array object');
  }
  if (!Array.isArray(sections)) {
    throw new TypeError('sections must be an array');
  }
  if (sections.length === 0) {
    throw new TypeError('sections must be a nonempty array');
  }

  const clonedSections: PreservedSection[] = [];
  // Indexed iteration (not forEach) so sparse holes surface as `undefined`
  // and are rejected instead of being silently skipped.
  for (let index = 0; index < sections.length; index += 1) {
    const label = `sections[${index}]`;
    const section = sections[index];
    assertValidPreservedSection(section, label);
    clonedSections.push(structuredClone(section) as PreservedSection);
  }

  // Mutate only after the entire input has validated and cloned. `T`'s
  // constraint only exposes an index signature, so assign through a writable
  // record view rather than widening the public return contract.
  const target: Record<string, unknown> = raw;
  target.sections = clonedSections;
  return raw as T & { sections: PreservedSection[] };
}
