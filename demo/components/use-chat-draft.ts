'use client';

import { useCallback, useSyncExternalStore } from 'react';

const memoryDrafts = new Map<string, string>();

/** Drafts have their own namespace: they never overwrite saved conversations. */
export function useChatDraft(key: string) {
  const subscribe = useCallback((onChange: () => void) => {
    const synchronize = (event: Event) => {
      if ((event as CustomEvent<{key:string}>).detail?.key === key) onChange();
    };
    const fromOtherWindow = (event: StorageEvent) => {
      if (event.key === `yeyu:chat-draft:v1:${key}`) { memoryDrafts.delete(key); onChange(); }
    };
    window.addEventListener('yeyu-chat-draft-changed', synchronize);
    window.addEventListener('storage', fromOtherWindow);
    return () => { window.removeEventListener('yeyu-chat-draft-changed', synchronize); window.removeEventListener('storage', fromOtherWindow); };
  }, [key]);
  const getSnapshot = useCallback(() => {
    if (!key) return '';
    if (!memoryDrafts.has(key)) {
      let saved = '';
      try { saved = localStorage.getItem(`yeyu:chat-draft:v1:${key}`) ?? ''; } catch { /* In-memory editing remains available. */ }
      memoryDrafts.set(key, saved);
    }
    return memoryDrafts.get(key)!;
  }, [key]);
  const draft = useSyncExternalStore(subscribe, getSnapshot, () => '');
  const setDraft = useCallback((value: string) => {
    if (!key) return;
    memoryDrafts.set(key, value);
    try {
      if (value) localStorage.setItem(`yeyu:chat-draft:v1:${key}`, value);
      else localStorage.removeItem(`yeyu:chat-draft:v1:${key}`);
    } catch { /* A full/disabled store must not prevent sending a question. */ }
    window.dispatchEvent(new CustomEvent('yeyu-chat-draft-changed', { detail: { key, value } }));
  }, [key]);
  return [draft, setDraft] as const;
}

export interface QuestionDraft { id: string; text: string; pageNumber?: number }
