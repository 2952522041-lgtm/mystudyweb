'use client';

import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  getSelectionText,
  selectionBox,
  selectionInLayer,
} from '@/lib/selection';

/**
 * Floating toolbar shown when the reader's text layer has a text selection.
 * It reads the current document selection, detects whether it lies inside a
 * `.pdf-text-layer`, positions itself near the selection box, and offers a
 * Copy action. Pure geometry/text logic lives in lib/selection.ts so the
 * interaction here stays thin.
 */
export function SelectionToolbar() {
  const [rect, setRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onSelectionChange = () => {
      const selection = window.getSelection();
      const layer = document.querySelector<HTMLElement>('.pdf-text-layer');
      if (selection && layer && selectionInLayer(selection, layer)) {
        const value = getSelectionText(selection);
        if (value) {
          const box = selectionBox(selection);
          if (box) {
            setText(value);
            setRect(box);
            return;
          }
        }
      }
      setRect(null);
      setText('');
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 1400);
      return () => clearTimeout(timer);
    }
  }, [copied]);

  if (!rect || !text) return null;

  const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;

  const copySelection = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (permissions); the button still reacts.
      setCopied(false);
    }
  };

  // Keep the toolbar just above the selection, clamping within the viewport so
  // it never escapes past the right/bottom edges.
  const top = Math.max(rect.y - 44, 6);
  const left = Math.min(rect.x, Math.max((window.innerWidth ?? 0) - 260, 6));

  return (
    <div
      ref={hostRef}
      className="fixed z-50 flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 shadow-lg"
      style={{ top, left }}
      role="toolbar"
      aria-label="选中文字操作"
    >
      <span
        className="max-w-[180px] truncate px-1.5 text-xs text-slate-500"
        title={preview}
      >
        {preview}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? '已复制' : '复制选中文字'}
        onClick={copySelection}
      >
        {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}
