/**
 * Pure helpers for capturing a text selection inside the PDF reader's text
 * layer. Every function uses only the minimal shape it needs so each rule is
 * testable in plain Node without DOM types.
 */

/** Minimal shape of a DOM Range that the helpers need. */
export interface RangeLike {
  commonAncestorContainer: unknown;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  getClientRects(): ArrayLike<{ left: number; top: number; width: number; height: number }>;
}

/** Minimal shape of a Selection (or the subset we consume). */
export interface SelectionLike {
  rangeCount: number;
  getRangeAt(index: number): RangeLike;
  toString(): string;
}

/** Minimal shape of a container element (the text-layer div). */
export interface ContainerLike {
  contains(node: unknown): boolean;
}

/** Returns the trimmed selected text, or '' when nothing is selected. */
export function getSelectionText(selection: SelectionLike | null | undefined): string {
  if (!selection) return '';
  return selection.toString().replace(/\s+/g, ' ').trim();
}

/** A selection belongs to exactly one page layer; visible rects alone are not ownership. */
export function selectionInLayer(
  selection: SelectionLike | null | undefined,
  container: ContainerLike | null | undefined,
): boolean {
  if (!selection || !container || selection.rangeCount !== 1) return false;
  const ancestor = selection.getRangeAt(0).commonAncestorContainer;
  return Boolean(ancestor && container.contains(ancestor));
}

/** World-coordinate box of the selection (first client rect), or null if empty. */
export function selectionBox(
  selection: SelectionLike | null | undefined,
): { x: number; y: number; w: number; h: number } | null {
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  // Prefer the collision of client rects; a collapsed range has a zero box.
  let box: { left: number; top: number; width: number; height: number } | null = null;
  for (let i = 0; i < range.getClientRects().length; i += 1) {
    const rect = range.getClientRects()[i];
    if (rect.width > 0 && rect.height > 0) {
      box = rect;
      break;
    }
  }
  if (!box) box = range.getBoundingClientRect();
  if (!box || (box.width <= 0 || box.height <= 0)) return null;
  return { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) };
}

export interface SelectionSnapshot {
  text: string;
  pageNumber: number;
  box: { x: number; y: number; w: number; h: number };
  /** Fractions of the displayed page, independent of zoom and canvas DPR. */
  pageBox: { x: number; y: number; w: number; h: number };
}

export interface SelectionLayer {
  pageNumber: number;
  container: ContainerLike;
  bounds: { left: number; top: number; width: number; height: number };
}

export function capturePageSelection(
  selection: SelectionLike | null,
  layers: SelectionLayer[],
): SelectionSnapshot | null {
  const text = getSelectionText(selection);
  const box = selectionBox(selection);
  if (!text || !box) return null;
  const layer = layers.find(({ container }) => selectionInLayer(selection, container));
  if (!layer || !Number.isInteger(layer.pageNumber) || layer.pageNumber < 1) return null;
  const { left, top, width, height } = layer.bounds;
  if (width <= 0 || height <= 0) return null;
  const x = Math.max(0, box.x - left);
  const y = Math.max(0, box.y - top);
  const right = Math.min(width, box.x + box.w - left);
  const bottom = Math.min(height, box.y + box.h - top);
  if (right <= x || bottom <= y) return null;
  return { text, pageNumber: layer.pageNumber, box,
    pageBox: { x: x / width, y: y / height, w: (right - x) / width, h: (bottom - y) / height } };
}

export function selectionToolbarPosition(
  box: SelectionSnapshot['box'],
  viewport: { width: number; height: number },
  toolbar: { width: number; height: number },
): { left: number; top: number } {
  const gap = 8;
  const desiredTop = box.y >= toolbar.height + gap ? box.y - toolbar.height - gap : box.y + box.h + gap;
  return {
    left: Math.max(gap, Math.min(box.x, viewport.width - toolbar.width - gap)),
    top: Math.max(gap, Math.min(desiredTop, viewport.height - toolbar.height - gap)),
  };
}
