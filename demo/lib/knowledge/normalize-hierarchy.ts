import type { SourceReference } from '../course-storage/types.ts';
import { conceptKey } from './concept-identity.ts';
import {
  MINDMAP_MAX_CHILDREN,
  MINDMAP_MAX_CONCEPTS,
  MINDMAP_MAX_DEPTH,
} from './mindmap-structure.ts';

type HierarchyNode = {
  id: string;
  parentId: string | null;
  label: string;
  sources: SourceReference[];
};

export interface PromotedHierarchyNode {
  id: string;
  from: string;
  to: string | null;
}

export interface NormalizedHierarchy<T extends HierarchyNode> {
  nodes: T[];
  promoted: PromotedHierarchyNode[];
}

type ParentId = string | null;

function sourcePageLabel(sources: SourceReference[]): string {
  const ranges = new Set<string>();
  for (const source of sources) {
    const start = source.pageStart;
    const end = source.pageEnd ?? start;
    ranges.add(start === end ? `${start}` : `${start}-${end}`);
  }
  return `第${[...ranges]
    .sort((a, b) => {
      const aStart = Number.parseInt(a, 10);
      const bStart = Number.parseInt(b, 10);
      return aStart - bStart || a.localeCompare(b);
    })
    .join('、')}页`;
}

function cloneNode<T extends HierarchyNode>(node: T): T {
  // Clone the sources array as well, so callers can safely compare or reuse
  // their input even though the generic node may carry additional fields.
  return { ...node, sources: [...node.sources] } as T;
}

/**
 * Make a small, deterministic repair to a model-produced hierarchy.
 *
 * The original parent map is deliberately kept separate from the mutable map:
 * a node may only be promoted to an ancestor it had in the model output. This
 * prevents a capacity repair from inventing a new semantic branch.
 */
export function normalizeHierarchy<T extends HierarchyNode>(
  nodes: T[],
): NormalizedHierarchy<T> | undefined {
  if (nodes.length > MINDMAP_MAX_CONCEPTS) return undefined;

  const byId = new Map<string, T>();
  const originalIndex = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    if (
      !node ||
      typeof node.id !== 'string' ||
      node.id.length === 0 ||
      typeof node.label !== 'string' ||
      byId.has(node.id)
    )
      return undefined;
    if (!Array.isArray(node.sources) || node.sources.length === 0)
      return undefined;
    byId.set(node.id, node);
    originalIndex.set(node.id, index);
  }

  const originalParent = new Map<string, ParentId>();
  for (const node of nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) return undefined;
    originalParent.set(node.id, node.parentId);
  }

  const originalDepth = new Map<string, number>();
  for (const node of nodes) {
    let current: ParentId = node.id;
    let depth = 1;
    const visited = new Set<string>();
    while (current !== null) {
      if (visited.has(current)) return undefined;
      visited.add(current);
      const parent = originalParent.get(current);
      if (parent === undefined && current !== node.id) return undefined;
      current = parent ?? null;
      if (current !== null) depth += 1;
    }
    originalDepth.set(node.id, depth);
  }

  const normalized = nodes.map(cloneNode);
  const currentParent = new Map<string, ParentId>(originalParent);
  const children = new Map<ParentId, string[]>();
  const rebuildChildren = () => {
    children.clear();
    for (const node of nodes) {
      const parent = currentParent.get(node.id) ?? null;
      const list = children.get(parent) ?? [];
      list.push(node.id);
      children.set(parent, list);
    }
    for (const list of children.values())
      list.sort((a, b) => originalIndex.get(a)! - originalIndex.get(b)!);
  };
  rebuildChildren();

  const currentDepth = (id: string): number | undefined => {
    let current: ParentId = id;
    let depth = 1;
    const visited = new Set<string>();
    while (current !== null) {
      if (visited.has(current)) return undefined;
      visited.add(current);
      const parent = currentParent.get(current);
      if (parent === undefined) return undefined;
      current = parent;
      if (current !== null) depth += 1;
    }
    return depth;
  };

  const ancestorTargets = (id: string): ParentId[] => {
    const originalParentId = originalParent.get(id);
    if (originalParentId === undefined || originalParentId === null)
      return [null];

    // Start at the original parent's parent. The original parent itself is
    // not a promotion target; every target is a genuine older ancestor.
    let ancestor = originalParent.get(originalParentId);
    if (ancestor === undefined) return [];
    const targets: ParentId[] = [];
    while (true) {
      targets.push(ancestor);
      if (ancestor === null) break;
      ancestor = originalParent.get(ancestor);
      if (ancestor === undefined) return [];
    }
    return targets;
  };

  const findPromotionTarget = (id: string): ParentId | undefined => {
    const from = currentParent.get(id);
    if (from === undefined || from === null) return undefined;
    for (const target of ancestorTargets(id)) {
      if (target === from) continue;
      const targetDepth = target === null ? 0 : currentDepth(target);
      if (targetDepth === undefined || targetDepth + 1 > MINDMAP_MAX_DEPTH)
        continue;
      if ((children.get(target)?.length ?? 0) >= MINDMAP_MAX_CHILDREN) continue;
      return target;
    }
    return undefined;
  };

  const promoted: PromotedHierarchyNode[] = [];
  const move = (id: string, target: ParentId): boolean => {
    const from = currentParent.get(id);
    if (from === undefined || from === null || from === target) return false;
    const targetDepth = target === null ? 0 : currentDepth(target);
    if (targetDepth === undefined || targetDepth + 1 > MINDMAP_MAX_DEPTH)
      return false;
    if ((children.get(target)?.length ?? 0) >= MINDMAP_MAX_CHILDREN)
      return false;

    const oldChildren = children.get(from);
    if (!oldChildren) return false;
    const oldIndex = oldChildren.indexOf(id);
    if (oldIndex < 0) return false;
    oldChildren.splice(oldIndex, 1);
    const newChildren = children.get(target) ?? [];
    newChildren.push(id);
    newChildren.sort((a, b) => originalIndex.get(a)! - originalIndex.get(b)!);
    children.set(target, newChildren);
    currentParent.set(id, target);
    normalized[originalIndex.get(id)!].parentId = target;
    promoted.push({ id, from, to: target });
    return true;
  };

  const deepestFirst = [...nodes]
    .sort(
      (a, b) =>
        originalDepth.get(b.id)! - originalDepth.get(a.id)! ||
        originalIndex.get(a.id)! - originalIndex.get(b.id)!,
    )
    .map((node) => node.id);
  for (const id of deepestFirst) {
    while ((currentDepth(id) ?? MINDMAP_MAX_DEPTH + 1) > MINDMAP_MAX_DEPTH) {
      const target = findPromotionTarget(id);
      if (target === undefined || !move(id, target)) return undefined;
    }
  }

  // Promotions can fill an ancestor, so inspect every current parent in
  // source order until all capacity violations have been discharged.
  let changed = true;
  while (changed) {
    changed = false;
    const parentIds: ParentId[] = [null, ...nodes.map((node) => node.id)];
    for (const parent of parentIds) {
      const list = children.get(parent);
      if (!list || list.length <= MINDMAP_MAX_CHILDREN) continue;
      const overflowing = [...list]
        .sort((a, b) => originalIndex.get(a)! - originalIndex.get(b)!)
        .slice(MINDMAP_MAX_CHILDREN);
      for (const id of overflowing) {
        const target = findPromotionTarget(id);
        if (target === undefined || !move(id, target)) return undefined;
        changed = true;
      }
    }
  }

  for (const node of nodes) {
    const depth = currentDepth(node.id);
    if (depth === undefined || depth > MINDMAP_MAX_DEPTH) return undefined;
  }
  for (const list of children.values())
    if (list.length > MINDMAP_MAX_CHILDREN) return undefined;

  const originalLabelGroups = new Map<string, string[]>();
  for (const node of nodes) {
    const key = conceptKey(node.label);
    const ids = originalLabelGroups.get(key) ?? [];
    ids.push(node.id);
    originalLabelGroups.set(key, ids);
  }

  const parentPath = (id: string): string => {
    const labels: string[] = [];
    let parent = originalParent.get(id) ?? null;
    while (parent !== null) {
      const parentNode = byId.get(parent);
      if (!parentNode) return '';
      labels.unshift(parentNode.label);
      parent = originalParent.get(parent) ?? null;
    }
    return labels.join(' / ');
  };

  const baseLabels = new Map<string, string>();
  for (const node of nodes) {
    const duplicate =
      (originalLabelGroups.get(conceptKey(node.label))?.length ?? 0) > 1;
    if (!duplicate) {
      baseLabels.set(node.id, node.label);
      continue;
    }
    const context = [
      parentPath(node.id) || '根',
      sourcePageLabel(node.sources),
    ].join('；');
    baseLabels.set(node.id, `${node.label}（${context}）`);
  }
  const baseLabelCounts = new Map<string, number>();
  for (const label of baseLabels.values()) {
    const key = conceptKey(label);
    baseLabelCounts.set(key, (baseLabelCounts.get(key) ?? 0) + 1);
  }
  const finalLabels = new Set<string>();
  for (const node of nodes) {
    const base = baseLabels.get(node.id)!;
    const baseKey = conceptKey(base);
    const label =
      baseLabelCounts.get(baseKey)! > 1 ? `${base}（${node.id}）` : base;
    const key = conceptKey(label);
    if (finalLabels.has(key)) return undefined;
    finalLabels.add(key);
    normalized[originalIndex.get(node.id)!].label = label;
  }

  return { nodes: normalized, promoted };
}
