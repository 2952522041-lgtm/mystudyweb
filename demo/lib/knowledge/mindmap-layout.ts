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
  options?: {
    maxNodes?: number;
    maxDepth?: number;
    collapsedIds?: ReadonlySet<string>;
    maxEdges?: number;
  },
): MindmapLayout {
  const maxNodes = options?.maxNodes ?? MINDMAP_DEFAULT_MAX_NODES;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root =
    nodes.find((node) => node.kind === 'course') ??
    (nodes[0] as KnowledgeNode | undefined);
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

  const allNodes = new Map<string, MindmapLayoutNode>();
  const add = (node: KnowledgeNode, parentId: string | null, label: string) => {
    allNodes.set(node.id, {
      ...node,
      depth: parentId ? (allNodes.get(parentId)?.depth ?? 0) + 1 : 0,
      parentId,
      relationLabel: label,
    });
  };
  add(root, null, '');
  const incoming = new Set(
    relations
      .filter(
        (edge) =>
          edge.from !== root.id && edge.from !== edge.to && byId.has(edge.from),
      )
      .map((edge) => edge.to),
  );
  // Prefer topic roots, then traverse their actual relations. Previously disconnected
  // topics were all attached to the root without traversing their children.
  const queue = [root.id];
  let cursor = 0;
  const drain = () => {
    for (; cursor < queue.length; cursor += 1) {
      const parentId = queue[cursor];
      const children = [...(adjacency.get(parentId) ?? [])].sort(
        (a, b) =>
          Number(b.label === '包含' || b.label === '组成') -
          Number(a.label === '包含' || a.label === '组成'),
      );
      for (const edge of children) {
        if (
          allNodes.has(edge.to) ||
          (parentId === root.id && incoming.has(edge.to))
        )
          continue;
        add(byId.get(edge.to)!, parentId, edge.label);
        queue.push(edge.to);
      }
    }
  };
  drain();
  for (const node of nodes) {
    if (allNodes.has(node.id) || incoming.has(node.id)) continue;
    add(node, root.id, '关联');
    queue.push(node.id);
    drain();
  }
  // Cycles and remaining components: choose a deterministic first node, visit once.
  for (const node of nodes) {
    if (allNodes.has(node.id)) continue;
    add(node, root.id, '关联');
    queue.push(node.id);
    drain();
  }
  const layoutNodes = new Map<string, MindmapLayoutNode>();
  for (const node of allNodes.values()) {
    if (layoutNodes.size >= maxNodes) break;
    if (node.depth > (options?.maxDepth ?? Infinity)) continue;
    if (
      node.parentId &&
      (!layoutNodes.has(node.parentId) ||
        options?.collapsedIds?.has(node.parentId))
    )
      continue;
    layoutNodes.set(node.id, node);
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
    if (edges.length >= (options?.maxEdges ?? 120)) break;
    if (!layoutNodes.has(relation.from) || !layoutNodes.has(relation.to))
      continue;
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

  const width = MINDMAP_MARGIN * 2 + (maxDepth + 1) * stepX - MINDMAP_GAP_X;
  const height = contentHeight + MINDMAP_MARGIN * 2;
  return {
    positions,
    width: Math.max(width, 720),
    height: Math.max(height, 240),
  };
}
