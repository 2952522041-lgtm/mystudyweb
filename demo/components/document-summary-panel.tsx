'use client';

import { BookOpenText, ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { DocumentDigest } from '@/lib/course-storage/types';

export function DocumentSummaryPanel({
  digest,
  onOpenSource,
}: {
  digest: DocumentDigest;
  onOpenSource: (page: number) => void;
}) {
  return (
    <article className="mx-auto max-w-3xl px-6 py-7 sm:px-10">
      <p className="flex items-center gap-2 text-xs font-bold tracking-[0.12em] text-violet-600 uppercase">
        <BookOpenText className="size-4" /> 单 PDF 总结
      </p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
        {digest.title}
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        本地结构化摘要 · {digest.sourcePages.length} 页 · 来源可追溯
      </p>

      <section className="mt-8">
        <h3 className="text-sm font-semibold text-slate-900">内容概览</h3>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          {digest.overview}
        </p>
      </section>

      <div className="mt-8 space-y-8">
        {digest.sections.slice(0, 12).map((section) => (
          <section key={section.id}>
            <h3 className="text-sm font-semibold text-slate-900">
              {section.title}
            </h3>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              {section.summary}
            </p>
            <Button
              variant="outline"
              size="xs"
              className="mt-3 text-blue-700"
              onClick={() => onOpenSource(section.pageStart)}
            >
              <ExternalLink /> 第 {section.pageStart} 页
            </Button>
          </section>
        ))}
      </div>
    </article>
  );
}
