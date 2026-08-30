import type { PDFDocumentProxy, RenderTask } from './pdfjs.ts';
import { itemsFromPdfJs, normalizePage } from './pdf-text.ts';
import type { PageImageInput } from './chat.ts';

export interface PageImageLimits {
  maxDimension?: number;
  maxPixels?: number;
}

export interface PageImageSize {
  width: number;
  height: number;
  scale: number;
}

const DEFAULT_MAX_DIMENSION = 1800;
const DEFAULT_MAX_PIXELS = 3_000_000;

export function computePageImageSize(
  width: number,
  height: number,
  limits: PageImageLimits = {},
): PageImageSize {
  const maxDimension = limits.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxPixels = limits.maxPixels ?? DEFAULT_MAX_PIXELS;
  const dimensionScale = maxDimension / Math.max(width, height);
  const pixelScale = Math.sqrt(maxPixels / (width * height));
  const scale = Math.max(0.1, Math.min(dimensionScale, pixelScale));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

export async function extractPageText(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
): Promise<string> {
  const pdfPage = await pdfDoc.getPage(pageNumber);
  const viewport = pdfPage.getViewport({ scale: 1 });
  const content = await pdfPage.getTextContent();
  return normalizePage(
    itemsFromPdfJs(
      content.items as Array<{
        str?: string;
        transform?: number[];
        width?: number;
        height?: number;
      }>,
      viewport.height,
    ),
  ).text;
}

export async function renderPageImage(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
  options: PageImageLimits & { signal?: AbortSignal } = {},
): Promise<PageImageInput> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const pdfPage = await pdfDoc.getPage(pageNumber);
  const base = pdfPage.getViewport({ scale: 1 });
  const size = computePageImageSize(base.width, base.height, options);
  const viewport = pdfPage.getViewport({ scale: size.scale });
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法创建页面图像画布。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  let task: RenderTask | null = null;
  const abort = () => task?.cancel();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    task = pdfPage.render({ canvas, canvasContext: context, viewport });
    await task.promise;
    if (options.signal?.aborted)
      throw new DOMException('Aborted', 'AbortError');
    return {
      mimeType: 'image/png',
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    canvas.width = 1;
    canvas.height = 1;
  }
}
