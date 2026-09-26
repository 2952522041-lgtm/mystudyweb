/** Reveal the highlighted paragraph/group only in its owning pane. Geometry
 * comes from rendered spans, so rotation, zoom and device scale need no guesses.
 */
export function revealParagraph(
  element: HTMLElement | undefined | null,
  paneSelector: string,
  group: readonly HTMLElement[] = element ? [element] : [],
): void {
  const pane = element?.closest<HTMLElement>(paneSelector);
  if (!element || !pane || !group.length) return;
  const rects = group.map((node) => node.getBoundingClientRect());
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  const viewport = pane.getBoundingClientRect();
  if (top < viewport.top || bottom > viewport.bottom) {
    pane.scrollTop += top - viewport.top - Math.max(8, (pane.clientHeight - (bottom - top)) / 2);
  }
  if (left < viewport.left || right > viewport.right) {
    pane.scrollLeft += left - viewport.left - Math.max(8, (pane.clientWidth - (right - left)) / 2);
  }
}

export function sourceParagraphIndices(element: Element): number[] {
  return (element.getAttribute('data-source-paragraphs') ?? '').split(' ')
    .filter(Boolean).map(Number).filter((index) => Number.isInteger(index) && index >= 0);
}
