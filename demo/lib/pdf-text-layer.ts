import { pageHasText, type PdfTextItem } from './pdf-text.ts';

/**
 * Only pages with real extractable text get an interactive TextLayer; scanned
 * or handwritten pages have nothing to select and stay canvas-only.
 */
export function shouldBuildTextLayer(items: PdfTextItem[]): boolean {
  return pageHasText(items);
}

/**
 * CSS scale mapping PDF page units to the rendered page box. TextLayer
 * positions glyphs as page fractions and sizes them through this scale, so
 * the canvas backing store (scale × DPR) and the text layer must both derive
 * from the same ratio or selection highlights drift off the glyphs.
 */
export function textLayerScale(
  displayWidth: number,
  basePageWidth: number,
): number {
  if (basePageWidth <= 0 || displayWidth <= 0) return 1;
  return displayWidth / basePageWidth;
}
