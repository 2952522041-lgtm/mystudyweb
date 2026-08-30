declare module 'pdfjs-dist/build/pdf.mjs' {
  import type { PDFDocumentProxy } from 'pdfjs-dist';

  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(src: { data: Uint8Array }): {
    promise: Promise<PDFDocumentProxy>;
  };
}
