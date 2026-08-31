'use client';

import { useMemo, useState } from 'react';
import { BookOpen, CircleHelp, Network, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type {
  CourseKnowledge,
  KnowledgeNode,
} from '@/lib/course-storage/types';
import { formatSource } from '@/lib/knowledge/artifact-renderer';

function NodeIcon({ node }: { node: KnowledgeNode }) {
  if (node.kind === 'course') return <Network />;
  if (node.kind === 'insight') return <Sparkles />;
  if (node.kind === 'question') return <CircleHelp />;
  return <BookOpen />;
}

export function KnowledgeMindmap({
  knowledge,
  onOpenSource,
}: {
  knowledge: CourseKnowledge;
  onOpenSource: (documentId: string, page: number) => void;
}) {
  const [selectedId, setSelectedId] = useState(knowledge.nodes[0]?.id ?? '');
  const selected = useMemo(
    () =>
      knowledge.nodes.find((node) => node.id === selectedId) ??
      knowledge.nodes[0],
    [knowledge.nodes, selectedId],
  );
  const root = knowledge.nodes.find((node) => node.kind === 'course');
  const children = knowledge.nodes.filter((node) => node.kind !== 'course');

  if (!root || children.length === 0) {
    return (
      <div className="flex min-h-[430px] flex-col items-center justify-center px-6 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-violet-50 text-violet-600">
          <Network className="size-6" />
        </span>
        <h2 className="mt-5 text-base font-semibold text-slate-800">
          课程脑图还是空的
        </h2>
        <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">
          至少将一份 PDF 纳入课程知识库后，这里才会出现带页码来源的概念节点。
        </p>
      </div>
    );
  }

  return (
    <div className="grid min-h-[520px] lg:grid-cols-[minmax(0,1fr)_310px]">
      <div className="overflow-auto bg-[radial-gradient(circle_at_center,#e5e7eb_1px,transparent_1px)] bg-[size:22px_22px] p-6">
        <div className="mx-auto flex min-w-[520px] max-w-4xl flex-col items-center py-5">
          <button
            type="button"
            className={`flex w-64 items-center gap-3 rounded-2xl bg-slate-800 px-4 py-4 text-left text-white shadow-lg transition ${selected.id === root.id ? 'ring-4 ring-violet-300' : ''}`}
            onClick={() => setSelectedId(root.id)}
          >
            <span className="flex size-9 items-center justify-center rounded-xl bg-white/10 [&_svg]:size-4">
              <NodeIcon node={root} />
            </span>
            <span>
              <span className="block font-semibold">{root.label}</span>
              <span className="mt-0.5 block text-[11px] text-slate-300">
                课程总脑图
              </span>
            </span>
          </button>
          <span className="h-10 w-px bg-slate-300" aria-hidden="true" />
          <div className="relative grid w-full grid-cols-2 gap-4 border-t border-slate-300 pt-8 md:grid-cols-3">
            {children.slice(0, 18).map((node) => (
              <button
                key={node.id}
                type="button"
                className={`relative min-h-24 rounded-xl border bg-white p-3 text-left shadow-sm transition before:absolute before:-top-8 before:left-1/2 before:h-8 before:w-px before:bg-slate-300 hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-md ${selected.id === node.id ? 'border-violet-500 ring-3 ring-violet-100' : 'border-slate-200'}`}
                onClick={() => setSelectedId(node.id)}
              >
                <span className="flex items-center gap-2 text-xs font-semibold text-slate-800">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-violet-50 text-violet-600 [&_svg]:size-3.5">
                    <NodeIcon node={node} />
                  </span>
                  <span className="line-clamp-2">{node.label}</span>
                </span>
                <span className="mt-2 block text-[10px] text-slate-500">
                  {node.sources.length} 个来源
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <aside className="border-t border-slate-200 bg-white p-5 lg:border-t-0 lg:border-l">
        <p className="text-[10px] font-bold tracking-[0.12em] text-slate-400 uppercase">
          选中节点
        </p>
        <h3 className="mt-3 text-lg font-semibold text-slate-900">
          {selected.label}
        </h3>
        <p className="mt-3 text-xs leading-6 text-slate-600">
          {selected.description}
        </p>
        <div className="mt-7 space-y-3">
          <p className="text-xs font-semibold text-slate-800">来源</p>
          {selected.sources.length === 0 ? (
            <p className="text-xs text-slate-400">课程根节点没有单独来源。</p>
          ) : (
            selected.sources.map((source) => (
              <div
                key={`${source.documentId}-${source.pageStart}-${source.type}`}
                className="rounded-xl border border-slate-200 bg-slate-50 p-3"
              >
                <p className="text-[11px] leading-5 text-slate-600">
                  {formatSource(source)}
                </p>
                <Button
                  variant="link"
                  size="xs"
                  className="mt-1 h-auto px-0 text-blue-700"
                  onClick={() =>
                    onOpenSource(source.documentId, source.pageStart)
                  }
                >
                  跳转到来源 →
                </Button>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
