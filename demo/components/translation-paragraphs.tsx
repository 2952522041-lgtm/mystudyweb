'use client';

import { useEffect, useRef } from 'react';
import type { ParagraphAlignment } from '@/lib/paragraph-alignment';
import { revealParagraph } from '@/lib/paragraph-dom';

export function TranslationParagraphs({ paragraphs, alignment, active = [], onActivate, revealRequest = null }: {
  paragraphs: string[];
  alignment?: ParagraphAlignment;
  active?: number[];
  onActivate?: (index: number) => void;
  revealRequest?: object | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const revealedRequestRef = useRef<object | null>(null);
  useEffect(() => {
    const first = root.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (first && revealRequest && revealedRequestRef.current !== revealRequest) {
      revealParagraph(first, '.translation-scroll', Array.from(root.current?.querySelectorAll<HTMLElement>('p[data-active="true"]') ?? []));
      revealedRequestRef.current = revealRequest;
    }
  }, [active, revealRequest]);
  return <div ref={root}>
    {paragraphs.map((paragraph, index) => {
      const enabled = Boolean(alignment?.targetToSource[index]?.length && onActivate);
      return <p key={index} data-paragraph-index={index} data-active={active.includes(index)}>
        {enabled ? <button type="button" className="translation-paragraph"
        data-active={active.includes(index)} aria-pressed={active.includes(index)}
        title="定位对应原文段落"
        onClick={() => {
          if (enabled && !window.getSelection()?.toString().trim()) onActivate?.(index);
        }}
        onKeyDown={(event) => {
          if (enabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault(); onActivate?.(index);
          }
        }}>{paragraph}</button> : paragraph}</p>;
    })}
  </div>;
}
