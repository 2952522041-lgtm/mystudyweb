/**
 * Pure keyboard-shortcut mapping for the PDF reader. It only depends on a
 * minimal KeyboardEventLike shape, so every rule is testable in plain Node.
 */

export type ReaderShortcutAction =
  | 'nextPage'
  | 'prevPage'
  | 'firstPage'
  | 'lastPage'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'toggleRightMode'
  | 'toggleRightPanel'
  | 'dismiss';

/** Right-panel tabs addressed by Alt+1..Alt+4. */
export type ReaderRightModeIndex = 1 | 2 | 3 | 4;

export type ReaderRightModeName =
  | 'translation'
  | 'chat'
  | 'summary'
  | 'mindmap';

export const READER_RIGHT_MODES: Record<
  ReaderRightModeIndex,
  ReaderRightModeName
> = {
  1: 'translation',
  2: 'chat',
  3: 'summary',
  4: 'mindmap',
};

/** Minimal subset of the DOM KeyboardEvent that the mapping needs. */
export interface KeyboardEventLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
}

/** Every action is data-free except toggleRightMode, which carries the mode. */
export type ReaderShortcut =
  | { action: Exclude<ReaderShortcutAction, 'toggleRightMode'> }
  | { action: 'toggleRightMode'; mode: ReaderRightModeIndex };

const PLAIN_KEY_ACTIONS: Record<string, ReaderShortcut> = {
  PageDown: { action: 'nextPage' },
  ArrowRight: { action: 'nextPage' },
  PageUp: { action: 'prevPage' },
  ArrowLeft: { action: 'prevPage' },
  Home: { action: 'firstPage' },
  End: { action: 'lastPage' },
  '+': { action: 'zoomIn' },
  '=': { action: 'zoomIn' },
  Add: { action: 'zoomIn' },
  '-': { action: 'zoomOut' },
  Subtract: { action: 'zoomOut' },
  '0': { action: 'zoomReset' },
  Escape: { action: 'dismiss' },
};

const ALT_MODE_KEYS: Record<string, ReaderRightModeIndex> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
};

export function mapShortcut(event: KeyboardEventLike): ReaderShortcut | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.key !== 'Escape' && isEditableTarget(event.target)) return null;
  if (
    event.key.toLowerCase() === 'f' && event.ctrlKey && event.shiftKey &&
    !event.altKey && !event.metaKey
  ) return { action: 'toggleRightPanel' };
  // Never compete with browser or application chords (Ctrl+R, Cmd+Plus, ...).
  if (event.ctrlKey || event.metaKey) return null;

  if (event.altKey) {
    if (event.shiftKey) return null;
    const mode = ALT_MODE_KEYS[event.key];
    return mode ? { action: 'toggleRightMode', mode } : null;
  }

  // Shift only changes the produced character ('f' vs 'F'); both collapse.
  if (event.key === 'f' || event.key === 'F') {
    return { action: 'toggleRightPanel' };
  }

  if (event.shiftKey && event.key !== '+') return null;
  return PLAIN_KEY_ACTIONS[event.key] ?? null;
}

/** True for targets that swallow typing: inputs, textareas, rich editors. */
export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const node = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    closest?: (selector: string) => unknown;
  };
  const tagName =
    typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    Boolean(node.closest?.('[role="textbox"], [role="slider"], [role="tablist"], [role="menu"], [role="listbox"]')) ||
    node.isContentEditable === true
  );
}
