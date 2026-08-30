import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: Uint8Array }): { promise: Promise<PDFDocumentProxy> };
}

let modulePromise: Promise<PdfjsModule> | null = null;

/**
 * Loads pdf.js lazily so SSR never touches browser globals. The worker file
 * is copied into public/ by scripts/copy-pdf-worker.mjs (predev/prebuild) so
 * the parser never loads code from the network.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!modulePromise) {
    modulePromise = import('pdfjs-dist/build/pdf.mjs').then((module) => {
      const pdfjs = module as unknown as PdfjsModule;
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      return pdfjs;
    });
  }
  return modulePromise;
}

export type { PDFDocumentProxy, RenderTask };
