'use client';

import { useMemo, useState } from 'react';
import { BookOpen, CircleHelp, Network, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type {
  CourseKnowledge,
  KnowledgeNode,
} from '@/lib/course-storage/types';
import { formatSource } from '@/lib/knowledge/artifact-renderer';
import {
  buildMindmapLayout,
  computeMindmapGeometry,
  MINDMAP_NODE_HEIGHT,
  MINDMAP_NODE_WIDTH,
} from '@/lib/knowledge/mindmap-layout';

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
  const [selectedId, setSelectedId] = useState('');
  const layout = useMemo(
    () =>
      buildMindmapLayout(knowledge.nodes, knowledge.relations, {
        maxNodes: 60,
      }),
    [knowledge.nodes, knowledge.relations],
  );
  const geometry = useMemo(() => computeMindmapGeometry(layout), [layout]);
  const nodeById = useMemo(
    () => new Map(knowledge.nodes.map((node) => [node.id, node])),
    [knowledge.nodes],
  );
  const selected = nodeById.get(selectedId) ?? knowledge.nodes[0];

  if (!layout.rootId || layout.nodes.length === 0) {
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
        <div
          className="relative mx-auto"
          style={{ width: geometry.width, height: geometry.height, minWidth: 560 }}
        >
          <svg
            className="absolute inset-0"
            width={geometry.width}
            height={geometry.height}
            aria-hidden="true"
          >
            {layout.edges.map((edge, index) => {
              const from = geometry.positions.get(edge.from);
              const to = geometry.positions.get(edge.to);
              if (!from || !to) return null;
              const startX = from.x + MINDMAP_NODE_WIDTH;
              const startY = from.y + MINDMAP_NODE_HEIGHT / 2;
              const endX = to.x;
              const endY = to.y + MINDMAP_NODE_HEIGHT / 2;
              const midX = (startX + endX) / 2;
              const midY = (startY + endY) / 2;
              return (
                <g key={`edge-${edge.from}-${edge.to}-${edge.label}-${index}`}>
                  <path
                    d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
                    fill="none"
                    stroke={edge.cross ? '#a78bda' : '#9fb2cc'}
                    strokeWidth={2}
                    strokeDasharray={edge.cross ? '6 4' : undefined}
                  />
                  {edge.label ? (
                    <text
                      x={midX}
                      y={midY - 6}
                      textAnchor="middle"
                      fontSize={10}
                      fill="#7c68b8"
                    >
                      {edge.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {layout.nodes.map((node) => {
            const position = geometry.positions.get(node.id);
            if (!position) return null;
            const isRoot = node.id === layout.rootId;
            const isSelected = selected?.id === node.id;
            return (
              <button
                key={node.id}
                type="button"
                className={`absolute flex flex-col justify-center gap-1 rounded-xl border px-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${isRoot ? 'border-slate-800 bg-slate-800 text-white' : node.ownership === 'user' ? 'border-amber-300 bg-amber-50 text-slate-800' : 'border-slate-200 bg-white text-slate-800'} ${isSelected ? (isRoot ? 'ring-4 ring-violet-300' : 'border-violet-500 ring-3 ring-violet-100') : ''}`}
                style={{
                  left: position.x,
                  top: position.y,
                  width: MINDMAP_NODE_WIDTH,
                  height: MINDMAP_NODE_HEIGHT,
                }}
                onClick={() => setSelectedId(node.id)}
              >
                <span className="flex items-center gap-2 text-xs font-semibold">
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-lg [&_svg]:size-3 ${isRoot ? 'bg-white/10 text-white' : 'bg-violet-50 text-violet-600'}`}
                  >
                    <NodeIcon node={node} />
                  </span>
                  <span className="line-clamp-1">{node.label}</span>
                </span>
                <span
                  className={`block text-[10px] ${isRoot ? 'text-slate-300' : 'text-slate-500'}`}
                >
                  {node.relationLabel ? `${node.relationLabel} · ` : ''}
                  {node.ownership === 'user' ? '用户节点 · ' : ''}
                  {node.sources.length} 个来源
                </span>
              </button>
            );
          })}
        </div>
        {layout.hiddenCount > 0 ? (
          <p className="mt-3 text-center text-[11px] text-slate-400">
            节点较多，已折叠 {layout.hiddenCount}{' '}
            个；完整结构始终保存在 课程脑图.json 中。
          </p>
        ) : null}
      </div>

      <aside className="border-t border-slate-200 bg-white p-5 lg:border-t-0 lg:border-l">
        <p className="text-[10px] font-bold tracking-[0.12em] text-slate-400 uppercase">
          选中节点
        </p>
        {selected ? (
          <>
            <h3 className="mt-3 text-lg font-semibold text-slate-900">
              {selected.label}
            </h3>
            <p className="mt-3 text-xs leading-6 text-slate-600">
              {selected.description}
            </p>
            <div className="mt-7 space-y-3">
              <p className="text-xs font-semibold text-slate-800">来源</p>
              {selected.sources.length === 0 ? (
                <p className="text-xs text-slate-400">
                  课程根节点没有单独来源。
                </p>
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
          </>
        ) : null}
      </aside>
    </div>
  );
}
