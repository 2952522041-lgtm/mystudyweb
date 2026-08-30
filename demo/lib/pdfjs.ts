import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: Uint8Array }): { promise: Promise<PDFDocumentProxy> };
}

let modulePromise: Promise<PdfjsModule> | null = null;

/**
 * Loads pdf.js lazily so SSR never touches browser globals, and points the
 * parser at a bundled worker instead of the network.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!modulePromise) {
    modulePromise = import('pdfjs-dist/build/pdf.mjs').then((module) => {
      const pdfjs = module as unknown as PdfjsModule;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }
  return modulePromise;
}

export type { PDFDocumentProxy, RenderTask };
