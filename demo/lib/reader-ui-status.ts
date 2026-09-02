/**
 * Pure presentation helpers for the reader's translation-status UI: the
 * thumbnail badge text/tone per translation status, the translated-page
 * counter shown at the top of the right panel, and the read-only facts
 * summarized in the bottom status bar.
 */

import type { ReaderRightModeName } from './reader-shortcuts.ts';

export type TranslationStatus =
  | 'recognizing'
  | 'translating'
  | 'complete'
  | 'cached'
  | 'error';

export type TranslationBadgeTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'error';

export interface TranslationBadge {
  label: string;
  tone: TranslationBadgeTone;
}

const BADGES: Record<TranslationStatus, TranslationBadge> = {
  recognizing: { label: '识别中', tone: 'info' },
  translating: { label: '翻译中', tone: 'warning' },
  complete: { label: '已翻译', tone: 'success' },
  cached: { label: '已缓存', tone: 'neutral' },
  error: { label: '失败', tone: 'error' },
};

/** Minimal shape of a per-page translation state that the counter needs. */
export interface TranslationStateLike {
  status: TranslationStatus;
}

/** Statuses that mean the page already shows a usable translation. */
const TRANSLATED_STATUSES: ReadonlySet<TranslationStatus> = new Set([
  'complete',
  'cached',
]);

export function statusToBadge(status: TranslationStatus): TranslationBadge {
  return BADGES[status];
}

/**
 * Count distinct pages that already have a translation (complete or cached),
 * ignoring entries outside 1..pageCount. A page counts once even if several
 * target languages have a state for it.
 */
export function countTranslated(
  translationStates: Record<string, TranslationStateLike>,
  pageCount: number,
): { done: number; total: number } {
  const translatedPages = new Set<number>();
  for (const [key, state] of Object.entries(translationStates)) {
    if (!state || !TRANSLATED_STATUSES.has(state.status)) continue;
    const pageNumber = Number.parseInt(key.split(':')[0] ?? '', 10);
    if (pageNumber >= 1 && pageNumber <= pageCount) {
      translatedPages.add(pageNumber);
    }
  }
  return { done: translatedPages.size, total: pageCount };
}

/** Chinese labels for the right-panel modes, matching the tab trigger text. */
const MODE_LABELS: Record<ReaderRightModeName, string> = {
  translation: '页面翻译',
  chat: 'AI 答疑',
  summary: 'PDF 总结',
  mindmap: 'PDF 脑图',
};

/** Chinese label of the active right-panel mode. */
export function modeLabel(mode: ReaderRightModeName): string {
  return MODE_LABELS[mode];
}

/** Read-only facts the bottom status bar summarizes. */
export interface StatusBarFacts {
  /** Current page, 1-based. */
  page: number;
  /** Total pages; 0 means no document is open. */
  pageCount: number;
  zoom: number;
  mode: ReaderRightModeName;
  translated: { done: number; total: number };
}

/**
 * The status bar's read-only facts as display strings, in fixed order: page
 * position, zoom, mode, translation progress. Page position and progress are
 * omitted while no document is open.
 */
export function statusBarParts(facts: StatusBarFacts): string[] {
  const parts: string[] = [];
  if (facts.pageCount > 0) {
    parts.push(`第 ${facts.page}/${facts.pageCount} 页`);
  }
  parts.push(`${facts.zoom}%`);
  parts.push(MODE_LABELS[facts.mode]);
  if (facts.pageCount > 0) {
    parts.push(`已翻译 ${facts.translated.done}/${facts.translated.total}`);
  }
  return parts;
}
