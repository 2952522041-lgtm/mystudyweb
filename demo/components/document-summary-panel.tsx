'use client';

import { BookOpenText, ExternalLink } from 'lucide-react';

import {
  KnowledgeMarkdown,
  KnowledgeSection,
} from '@/components/knowledge-section';
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
        {digest.promptVersion === 'local-structure-v1'
          ? '本地结构化摘要'
          : `AI 生成${digest.model ? ` · ${digest.model}` : ''}`}{' '}
        · {digest.sourcePages.length} 页 · 来源可追溯
      </p>

      <section className="mt-8">
        <h3 className="text-sm font-semibold text-slate-900">内容概览</h3>
        <KnowledgeMarkdown onNavigate={onOpenSource}>
          {digest.overview}
        </KnowledgeMarkdown>
      </section>

      <div className="mt-8 space-y-8">
        {digest.sections.map((section, index) => (
          <KnowledgeSection
            key={section.id}
            title={section.title}
            initiallyOpen={index < 2}
          >
            <KnowledgeMarkdown onNavigate={onOpenSource}>
              {section.summary}
            </KnowledgeMarkdown>
            {section.points?.map((point, pointIndex) => (
              <div
                key={pointIndex}
                className="space-y-2 border-l-2 border-violet-200 pl-3"
              >
                <KnowledgeMarkdown onNavigate={onOpenSource}>
                  {point.text}
                </KnowledgeMarkdown>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => onOpenSource(point.pageStart)}
                >
                  要点来源 · 第 {point.pageStart}
                  {point.pageEnd !== point.pageStart
                    ? `–${point.pageEnd}`
                    : ''}{' '}
                  页
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="xs"
              className="mt-3 text-blue-700"
              onClick={() => onOpenSource(section.pageStart)}
            >
              <ExternalLink /> 章节来源 · 第 {section.pageStart}
              {section.pageEnd !== section.pageStart
                ? `–${section.pageEnd}`
                : ''}{' '}
              页
            </Button>
          </KnowledgeSection>
        ))}
      </div>
      {digest.unresolvedQuestions.length > 0 ? (
        <KnowledgeSection title="待解决问题">
          {digest.unresolvedQuestions.map((question, index) => (
            <KnowledgeMarkdown key={index}>{question}</KnowledgeMarkdown>
          ))}
        </KnowledgeSection>
      ) : null}
    </article>
  );
}
