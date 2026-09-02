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

/**
 * True when the selection range's shared ancestor is inside the provided
 * container (the text layer). Falls back to a client-rect check so ranges that
 * cross plain-but-empty text still count as inside.
 */
export function selectionInLayer(
  selection: SelectionLike | null | undefined,
  container: ContainerLike | null | undefined,
): boolean {
  if (!selection || !container || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  if (ancestor && typeof ancestor === 'object' && container.contains(ancestor)) {
    return true;
  }
  // Fall back: a selection with visible client rects is certainly interactive.
  return range.getClientRects().length > 0;
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
    if (rect.width > 0 || rect.height > 0) {
      box = rect;
      break;
    }
  }
  if (!box) box = range.getBoundingClientRect();
  if (!box || (box.width <= 0 && box.height <= 0)) return null;
  return { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) };
}
