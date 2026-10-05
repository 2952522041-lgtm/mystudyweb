'use client';

import { useEffect, useRef, useState } from 'react';
import { MarkdownOutput } from '@/components/markdown-output';

/** Closed sections do not mount the math/table renderer. */
export function KnowledgeSection({
  title,
  children,
  initiallyOpen = false,
  focusOnMount = false,
}: {
  title: string;
  children: React.ReactNode;
  initiallyOpen?: boolean;
  focusOnMount?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const element = useRef<HTMLElement>(null);
  useEffect(() => { if (focusOnMount) { element.current?.scrollIntoView({block:'center'}); element.current?.focus({preventScroll:true}); } }, [focusOnMount]);
  return (
    <section ref={element} tabIndex={-1} className="rounded-xl border border-slate-200 p-4">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          className="w-full text-left text-sm font-semibold text-slate-900"
          onClick={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'} {title}
        </button>
      </h3>
      {open ? <div className="mt-3 space-y-3">{children}</div> : null}
    </section>
  );
}

export function KnowledgeMarkdown({
  children,
  onNavigate,
}: {
  children: string;
  onNavigate?: (page: number) => void;
}) {
  return (
    <div className="ai-markdown overflow-x-auto [&_h3]:font-semibold [&_h4]:font-semibold">
      <MarkdownOutput onNavigate={onNavigate}>{children}</MarkdownOutput>
    </div>
  );
}
