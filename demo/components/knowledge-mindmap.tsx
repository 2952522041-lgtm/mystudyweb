'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CircleHelp, Network, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { StudyActions } from '@/components/study-actions';
import type {
  CourseKnowledge,
  KnowledgeNode,
  SourceReference,
} from '@/lib/course-storage/types';
import { KnowledgeMarkdown } from '@/components/knowledge-section';
import {
  formatSource,
  renderMindmapMarkdown,
} from '@/lib/knowledge/artifact-renderer';
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
  onAskQuestion,
  onSaveNote,
}: {
  knowledge: CourseKnowledge;
  onOpenSource: (documentId: string, page: number) => void;
  onAskQuestion?: (question: {
    text: string;
    sources: SourceReference[];
  }) => void;
  onSaveNote?: (text: string, sources: SourceReference[]) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(1);
  const [maxDepth, setMaxDepth] = useState(3);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [copyStatus, setCopyStatus] = useState('');
  const canvasRef = useRef<HTMLElement>(null);
  const rootNodeRef = useRef<HTMLButtonElement>(null);
  const positionedMap = useRef<string | null>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? knowledge.nodes.filter((node) =>
          `${node.label} ${node.description}`
            .toLocaleLowerCase()
            .includes(term),
        )
      : [];
  }, [knowledge.nodes, query]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(renderMindmapMarkdown(knowledge));
      setCopyStatus('已复制完整脑图');
    } catch {
      setCopyStatus('复制失败，请使用下载 Markdown');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([renderMindmapMarkdown(knowledge)], {
        type: 'text/markdown;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = '脑图.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const layout = useMemo(
    () =>
      buildMindmapLayout(knowledge.nodes, knowledge.relations, {
        maxNodes: 60,
        maxDepth,
        collapsedIds,
      }),
    [knowledge.nodes, knowledge.relations, maxDepth, collapsedIds],
  );
  const geometry = useMemo(() => computeMindmapGeometry(layout), [layout]);
  const nodeById = useMemo(
    () => new Map(knowledge.nodes.map((node) => [node.id, node])),
    [knowledge.nodes],
  );
  const selected = nodeById.get(selectedId) ?? knowledge.nodes[0];
  const mapIdentity = `${knowledge.courseId}:${layout.rootId}`;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || positionedMap.current === mapIdentity) return;
    let frame = 0;
    const positionRoot = () => {
      if (positionedMap.current === mapIdentity) return;
      const root = rootNodeRef.current;
      if (!root || !canvas.clientWidth || !canvas.clientHeight || drag.current) return;
      const view = canvas.getBoundingClientRect();
      const node = root.getBoundingClientRect();
      // Scroll only this canvas; hidden reader tabs wait until they have size.
      canvas.scrollLeft += node.left - view.left - 24;
      canvas.scrollTop += node.top - view.top - (canvas.clientHeight - node.height) / 2;
      positionedMap.current = mapIdentity;
      observer.disconnect();
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(positionRoot);
    });
    observer.observe(canvas);
    frame = requestAnimationFrame(positionRoot);
    return () => {cancelAnimationFrame(frame);observer.disconnect();};
  }, [mapIdentity]);

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
    <div className="@container/mindmap min-w-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
        <input
          aria-label="搜索脑图节点"
          placeholder="搜索全部节点（含已折叠）"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 rounded border px-2 py-1 text-xs"
        />
        <Button
          size="xs"
          variant="outline"
          aria-label="缩小脑图"
          onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
        >
          −
        </Button>
        <span aria-label="脑图缩放比例">{Math.round(zoom * 100)}%</span>
        <Button
          size="xs"
          variant="outline"
          aria-label="放大脑图"
          onClick={() => setZoom((value) => Math.min(2, value + 0.25))}
        >
          +
        </Button>
        <Button size="xs" variant="outline" onClick={() => setZoom(1)}>
          重置缩放
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setCollapsedIds(new Set());
            setMaxDepth(Infinity);
          }}
        >
          展开层级
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setCollapsedIds(new Set());
            setMaxDepth(2);
          }}
        >
          折叠到主题
        </Button>
        <Button size="xs" variant="outline" onClick={() => void copy()}>
          复制脑图
        </Button>
        <Button size="xs" variant="outline" onClick={download}>
          下载 Markdown
        </Button>
        <output className="text-xs">{copyStatus}</output>
      </div>
      {query.trim() ? (
        <div
          className="max-h-40 overflow-auto border-b p-3 text-xs"
          aria-label="脑图搜索结果"
        >
          <p>
            {results.length} 个匹配，显示前 50 项；选择后查看完整说明与来源。
          </p>
          {results.slice(0, 50).map((node) => (
            <button
              type="button"
              key={node.id}
              className="m-1 rounded border px-2 py-1"
              onClick={() => setSelectedId(node.id)}
            >
              {node.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid min-h-[520px] @[900px]/mindmap:grid-cols-[minmax(0,1fr)_310px]">
        <section
          ref={canvasRef}
          aria-label="脑图画布"
          onPointerDown={(event) => {
            if (
              event.button !== 0 ||
              (event.target as HTMLElement).closest('button')
            )
              return;
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              left: event.currentTarget.scrollLeft,
              top: event.currentTarget.scrollTop,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            event.currentTarget.scrollLeft =
              drag.current.left - event.clientX + drag.current.x;
            event.currentTarget.scrollTop =
              drag.current.top - event.clientY + drag.current.y;
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          className="max-h-[680px] min-w-0 touch-none overflow-auto bg-[radial-gradient(circle_at_center,#e5e7eb_1px,transparent_1px)] bg-[size:22px_22px] p-6"
        >
          <div
            style={{
              width: geometry.width * zoom,
              height: geometry.height * zoom,
            }}
          >
            <div
              className="relative origin-top-left"
              style={{
                width: geometry.width,
                height: geometry.height,
                transform: `scale(${zoom})`,
              }}
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
                    <g
                      key={`edge-${edge.from}-${edge.to}-${edge.label}-${index}`}
                    >
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
                    ref={isRoot ? rootNodeRef : undefined}
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
          </div>
          {layout.hiddenCount > 0 ? (
            <p className="mt-3 text-center text-[11px] text-slate-400">
              节点较多，已折叠 {layout.hiddenCount} 个；画布最多显示 60
              个节点，可搜索全部节点或下载完整 Markdown。
            </p>
          ) : null}
        </section>

        <aside className="border-t border-slate-200 bg-white p-5 @[900px]/mindmap:border-t-0 @[900px]/mindmap:border-l">
          <p className="text-[10px] font-bold tracking-[0.12em] text-slate-400 uppercase">
            选中节点
          </p>
          {selected ? (
            <>
              <h3 className="mt-3 text-lg font-semibold text-slate-900">
                {selected.label}
              </h3>
              <KnowledgeMarkdown>{selected.description}</KnowledgeMarkdown>
              <StudyActions
                onAsk={
                  onAskQuestion
                    ? () =>
                        onAskQuestion({
                          text: `请解释“${selected.label}”：${selected.description}`,
                          sources: selected.sources,
                        })
                    : undefined
                }
                onSave={
                  onSaveNote
                    ? () =>
                        onSaveNote(
                          `${selected.label}\n\n${selected.description}`,
                          selected.sources,
                        )
                    : undefined
                }
              />
              <Button
                variant="outline"
                size="xs"
                className="mt-3"
                aria-expanded={!collapsedIds.has(selected.id)}
                onClick={() =>
                  setCollapsedIds((previous) => {
                    const next = new Set(previous);
                    if (next.has(selected.id)) next.delete(selected.id);
                    else next.add(selected.id);
                    return next;
                  })
                }
              >
                {collapsedIds.has(selected.id) ? '展开此分支' : '折叠此分支'}
              </Button>
              <div className="mt-7 space-y-3">
                <p className="text-xs font-semibold text-slate-800">来源</p>
                {selected.sources.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    课程根节点没有单独来源。
                  </p>
                ) : (
                  selected.sources.map((source) => (
                    <div
                      key={`${source.documentId}-${source.pageStart}-${source.pageEnd}-${source.type}`}
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
    </div>
  );
}
