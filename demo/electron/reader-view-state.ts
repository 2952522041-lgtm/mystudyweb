export type ReaderPanelMode = 'translation' | 'chat' | 'summary' | 'mindmap';
export interface ReaderViewState {
  pageFraction?: number;
  rightMode?: ReaderPanelMode;
  pdfPanelPercent?: number;
}
/** Validate optional persisted fields without rejecting records written by older clients. */
export function validReaderView(value: unknown): value is ReaderViewState {
  if (!value || typeof value !== 'object') return false;
  const view = value as Record<string, unknown>;
  return (view.pageFraction === undefined || (typeof view.pageFraction === 'number' && Number.isFinite(view.pageFraction) && view.pageFraction >= 0 && view.pageFraction <= 1)) &&
    (view.pdfPanelPercent === undefined || (typeof view.pdfPanelPercent === 'number' && Number.isFinite(view.pdfPanelPercent) && view.pdfPanelPercent >= 40 && view.pdfPanelPercent <= 70)) &&
    (view.rightMode === undefined || ['translation', 'chat', 'summary', 'mindmap'].includes(view.rightMode as string));
}
export function readerViewFields(view: ReaderViewState): ReaderViewState {
  return {
    ...(view.pageFraction !== undefined ? { pageFraction: view.pageFraction } : {}),
    ...(view.rightMode !== undefined ? { rightMode: view.rightMode } : {}),
    ...(view.pdfPanelPercent !== undefined ? { pdfPanelPercent: view.pdfPanelPercent } : {}),
  };
}
export function readingFraction(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
export function readingPanelPercent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(40, Math.min(70, value)) : 55;
}
export function readingPanelMode(value: unknown, fallback: ReaderPanelMode): ReaderPanelMode {
  return ['translation', 'chat', 'summary', 'mindmap'].includes(value as string) ? value as ReaderPanelMode : fallback;
}
