export interface PageRect {
  page: number;
  /** Top edge relative to the reading viewport, in viewport pixels. */
  top: number;
  /** Bottom edge relative to the reading viewport, in viewport pixels. */
  bottom: number;
}

/**
 * Picks the page the reader is currently looking at: the page with the largest
 * visible area inside the viewport; near-ties are broken by whose center is
 * closest to the viewport center (per the technical solution, section 4.3).
 */
export function pickCurrentPage(rects: PageRect[], viewportHeight: number): number | null {
  let bestPage: number | null = null;
  let bestVisible = 0;
  let bestCenterDistance = Number.POSITIVE_INFINITY;

  for (const rect of rects) {
    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.bottom, viewportHeight);
    const visible = Math.max(visibleBottom - visibleTop, 0);
    if (visible <= 0) continue;

    const centerDistance = Math.abs((rect.top + rect.bottom) / 2 - viewportHeight / 2);
    const strictlyLarger = visible > bestVisible * 1.05;
    const nearTie = bestPage !== null && visible > bestVisible * 0.95;
    if (strictlyLarger || (nearTie && centerDistance < bestCenterDistance) || bestPage === null) {
      bestPage = rect.page;
      bestVisible = visible;
      bestCenterDistance = centerDistance;
    }
  }
  return bestPage;
}

export interface ScrollReaderGeometry {
  scrollTop: number;
  clientHeight: number;
  pageTops: number[];
}

/**
 * Converts scroll-container geometry into viewport-relative page rects for
 * pickCurrentPage. pageTops holds each page's offset within the content.
 */
export function measurePageRects(geometry: ScrollReaderGeometry, pageHeights: number[]): PageRect[] {
  return pageHeights.map((height, index) => ({
    page: index + 1,
    top: geometry.pageTops[index] - geometry.scrollTop,
    bottom: geometry.pageTops[index] + height - geometry.scrollTop,
  }));
}
