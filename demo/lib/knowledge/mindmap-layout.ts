import type {
  ConceptRelation,
  KnowledgeNode,
  SourceReference,
} from '../course-storage/types.ts';

/**
 * 课程脑图与 SVG 渲染共用的层次布局：
 * 以 relations 建树（BFS），未连通的节点挂到根节点，支持按节点数折叠。
 */

export const MINDMAP_NODE_WIDTH = 208;
export const MINDMAP_NODE_HEIGHT = 64;
export const MINDMAP_GAP_X = 104;
export const MINDMAP_GAP_Y = 24;
export const MINDMAP_MARGIN = 28;
export const MINDMAP_DEFAULT_MAX_NODES = 48;

export const RELATION_LABELS = [
  '包含',
  '依赖',
  '导致',
  '对比',
  '组成',
  '应用',
  '冲突',
  '关联',
] as const;

export interface MindmapLayoutNode {
  id: string;
  label: string;
  description: string;
  kind: KnowledgeNode['kind'];
  ownership: KnowledgeNode['ownership'];
  sources: SourceReference[];
  depth: number;
  parentId: string | null;
  /** 指向父节点的关系标签；隐式挂到根的节点为“关联”。 */
  relationLabel: string;
}

export interface MindmapLayoutEdge {
  from: string;
  to: string;
  label: string;
  /** true 表示不是父子树边，而是概念之间的横向关系（虚线渲染）。 */
  cross: boolean;
}

export interface MindmapLayout {
  rootId: string | null;
  nodes: MindmapLayoutNode[];
  edges: MindmapLayoutEdge[];
  hiddenCount: number;
}

function relationKey(relation: ConceptRelation): string {
  return `${relation.from}\u0000${relation.to}\u0000${relation.label}`;
}

export function buildMindmapLayout(
  nodes: KnowledgeNode[],
  relations: ConceptRelation[],
  options?: { maxNodes?: number },
): MindmapLayout {
  const maxNodes = options?.maxNodes ?? MINDMAP_DEFAULT_MAX_NODES;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root =
    nodes.find((node) => node.kind === 'course') ?? (nodes[0] as KnowledgeNode | undefined);
  if (!root) {
    return { rootId: null, nodes: [], edges: [], hiddenCount: 0 };
  }

  const adjacency = new Map<string, Array<{ to: string; label: string }>>();
  for (const relation of relations) {
    if (!byId.has(relation.from) || !byId.has(relation.to)) continue;
    if (relation.from === relation.to) continue;
    const list = adjacency.get(relation.from) ?? [];
    list.push({ to: relation.to, label: relation.label });
    adjacency.set(relation.from, list);
  }

  const layoutNodes = new Map<string, MindmapLayoutNode>();
  const queue: string[] = [root.id];
  layoutNodes.set(root.id, {
    id: root.id,
    label: root.label,
    description: root.description,
    kind: root.kind,
    ownership: root.ownership,
    sources: root.sources,
    depth: 0,
    parentId: null,
    relationLabel: '',
  });

  const parentEdge = new Map<string, { from: string; label: string }>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentId = queue[cursor];
    if (layoutNodes.size >= maxNodes && currentId !== root.id) continue;
    for (const next of adjacency.get(currentId) ?? []) {
      if (layoutNodes.has(next.to)) continue;
      if (layoutNodes.size >= maxNodes) break;
      parentEdge.set(next.to, { from: currentId, label: next.label });
      const node = byId.get(next.to)!;
      layoutNodes.set(next.to, {
        id: node.id,
        label: node.label,
        description: node.description,
        kind: node.kind,
        ownership: node.ownership,
        sources: node.sources,
        depth: (layoutNodes.get(currentId)?.depth ?? 0) + 1,
        parentId: currentId,
        relationLabel: next.label,
      });
      queue.push(next.to);
    }
  }

  // 未被任何 relation 连通的节点仍需展示：挂到根节点，避免丢失。
  for (const node of nodes) {
    if (layoutNodes.size >= maxNodes) break;
    if (layoutNodes.has(node.id)) continue;
    layoutNodes.set(node.id, {
      id: node.id,
      label: node.label,
      description: node.description,
      kind: node.kind,
      ownership: node.ownership,
      sources: node.sources,
      depth: 1,
      parentId: root.id,
      relationLabel: '关联',
    });
  }

  const hiddenCount = Math.max(0, nodes.length - layoutNodes.size);

  const edges: MindmapLayoutEdge[] = [];
  const seenEdges = new Set<string>();
  for (const node of layoutNodes.values()) {
    if (node.parentId === null) continue;
    const edge: MindmapLayoutEdge = {
      from: node.parentId,
      to: node.id,
      label: node.relationLabel,
      cross: false,
    };
    edges.push(edge);
    seenEdges.add(relationKey(edge));
  }
  for (const relation of relations) {
    if (!layoutNodes.has(relation.from) || !layoutNodes.has(relation.to)) continue;
    const cross: MindmapLayoutEdge = {
      from: relation.from,
      to: relation.to,
      label: relation.label,
      cross: true,
    };
    if (seenEdges.has(relationKey(cross))) continue;
    seenEdges.add(relationKey(cross));
    edges.push(cross);
  }

  return {
    rootId: root.id,
    nodes: [...layoutNodes.values()],
    edges,
    hiddenCount,
  };
}

export interface MindmapPosition {
  x: number;
  y: number;
}

export interface MindmapGeometry {
  positions: Map<string, MindmapPosition>;
  width: number;
  height: number;
}

/** 按深度分列、列内堆叠并垂直居中；SVG 与界面脑图共用同一份坐标。 */
export function computeMindmapGeometry(layout: MindmapLayout): MindmapGeometry {
  const stepX = MINDMAP_NODE_WIDTH + MINDMAP_GAP_X;
  const stepY = MINDMAP_NODE_HEIGHT + MINDMAP_GAP_Y;
  const columns = new Map<number, MindmapLayoutNode[]>();
  for (const node of layout.nodes) {
    const column = columns.get(node.depth) ?? [];
    column.push(node);
    columns.set(node.depth, column);
  }

  const maxColumnSize = Math.max(
    1,
    ...[...columns.values()].map((column) => column.length),
  );
  const contentHeight = maxColumnSize * stepY - MINDMAP_GAP_Y;
  const positions = new Map<string, MindmapPosition>();
  let maxDepth = 0;
  for (const [depth, column] of columns) {
    maxDepth = Math.max(maxDepth, depth);
    const columnHeight = column.length * stepY - MINDMAP_GAP_Y;
    const offsetY = (contentHeight - columnHeight) / 2;
    column.forEach((node, index) => {
      positions.set(node.id, {
        x: MINDMAP_MARGIN + depth * stepX,
        y: MINDMAP_MARGIN + offsetY + index * stepY,
      });
    });
  }

  const width =
    MINDMAP_MARGIN * 2 + (maxDepth + 1) * stepX - MINDMAP_GAP_X;
  const height = contentHeight + MINDMAP_MARGIN * 2;
  return { positions, width: Math.max(width, 720), height: Math.max(height, 240) };
}
