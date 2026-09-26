export interface PageSize { width: number; height: number }
export interface ProgressivePageSize extends PageSize { ready: boolean; error?: boolean }
interface PageSource {
  numPages: number;
  getPage(page: number): Promise<{ getViewport(options: { scale: number }): PageSize }>;
}

/** Estimates reserve every page's place; only measured pages can render a canvas/text layer. */
export function createProgressivePageSizes(doc: PageSource, first: PageSize, publish: (sizes: ProgressivePageSize[]) => void) {
  const sizes = Array.from({ length: doc.numPages }, (_, i) => ({ ...first, ready: i === 0 } as ProgressivePageSize));
  const pending = new Map<number, Promise<void>>();
  let cancelled = false;
  const load = (page: number): Promise<void> => {
    if (cancelled || !sizes[page - 1] || sizes[page - 1].ready) return Promise.resolve();
    const existing = pending.get(page);
    if (existing) return existing;
    const request = (async () => {
      try {
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale: 1 });
        sizes[page - 1] = { width: viewport.width, height: viewport.height, ready: true };
      } catch {
        if (cancelled) return;
        sizes[page - 1] = { ...sizes[page - 1], error: true };
      }
      publish([...sizes]);
    })().finally(() => pending.delete(page));
    pending.set(page, request);
    return request;
  };
  return {
    initial: [...sizes], load,
    cancel() { cancelled = true; },
    async complete() {
      // Yield before background work so the first page can paint.
      for (let page = 2; page <= doc.numPages && !cancelled; page++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!cancelled && !sizes[page - 1].error) await load(page);
      }
    },
  };
}

export interface ReadingAnchor { page: number; fraction: number }
export function captureReadingAnchor(scrollTop: number, tops: number[], heights: number[], target?: number | null): ReadingAnchor {
  if (target) return { page: target, fraction: 0 };
  let index = 0;
  // scrollTop is rounded to device pixels; keep an aligned page at its top
  // instead of mistaking subpixel rounding for the preceding page/gap.
  while (index + 1 < tops.length && tops[index + 1] <= scrollTop + 1) index++;
  return { page: index + 1, fraction: Math.max(0, Math.min(1, (scrollTop - (tops[index] ?? 0)) / (heights[index] || 1))) };
}
export function restoreReadingAnchor(anchor: ReadingAnchor, tops: number[], heights: number[]): number {
  const index = Math.max(0, Math.min(tops.length - 1, anchor.page - 1));
  return (tops[index] ?? 0) + anchor.fraction * (heights[index] ?? 0);
}
