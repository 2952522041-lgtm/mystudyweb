'use client';

import { MarkdownOutput } from '@/components/markdown-output';
import { repairCrossParagraphMath } from '@/lib/output-markdown';
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
      revealParagraph(first, '.translation-scroll', Array.from(root.current?.querySelectorAll<HTMLElement>('[data-paragraph-index][data-active="true"]') ?? []));
      revealedRequestRef.current = revealRequest;
    }
  }, [active, revealRequest]);
  return <div ref={root}>
    {repairCrossParagraphMath(paragraphs).map((paragraph, index) => {
      const enabled = Boolean(alignment?.targetToSource[index]?.length && onActivate);
      const activate = () => {
        if (enabled && !window.getSelection()?.toString().trim()) onActivate?.(index);
      };
      return <div key={index} data-paragraph-index={index} data-active={active.includes(index)}
        className={enabled ? 'translation-paragraph mb-6' : 'mb-6'}
        onClick={(event) => {
          if (!(event.target as Element).closest('a, button, input')) activate();
        }}>
        <div className="ai-markdown"><MarkdownOutput>{paragraph}</MarkdownOutput></div>
        {enabled ? <button type="button" className="mt-1 rounded px-1 text-[11px] text-slate-500 hover:text-amber-800 focus-visible:outline-2 focus-visible:outline-amber-600"
          aria-label={`定位第 ${index + 1} 段原文`} aria-pressed={active.includes(index)} title="定位对应原文段落"
          onClick={activate}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
          }}>定位原文</button> : null}
      </div>;
    })}
  </div>;
}
