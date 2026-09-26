import type { SourceReference } from '../course-storage/types.ts';

/** Root/theme is depth 0; branches, subbranches and points are depths 1–3. */
export const MINDMAP_MAX_CHILDREN = 9;
export const MINDMAP_MAX_DEPTH = 3;
export const MINDMAP_MAX_CONCEPTS = 60;
export interface HierarchyNode {
  id: string;
  parentId?: string | null;
  sources: SourceReference[];
}

export function inspectHierarchy(nodes: HierarchyNode[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const levels = [1]; // implicit document/course theme
  const children = new Map<string | null, number>();
  const orphans: string[] = [];
  const cycles = new Set<string>();
  const missingSources: string[] = [];
  for (const node of nodes) {
    if (!node.sources?.length) missingSources.push(node.id);
    if (node.parentId === undefined || (node.parentId !== null && !byId.has(node.parentId))) orphans.push(node.id);
    children.set(node.parentId ?? null, (children.get(node.parentId ?? null) ?? 0) + 1);
    const seen = new Set<string>([node.id]);
    let parent = node.parentId;
    let depth = 1;
    while (parent != null && byId.has(parent)) {
      if (seen.has(parent)) { cycles.add(node.id); break; }
      seen.add(parent);
      depth++;
      parent = byId.get(parent)!.parentId;
    }
    levels[depth] = (levels[depth] ?? 0) + 1;
  }
  return { maxDepth: levels.length - 1, levels: Array.from(levels, n => n ?? 0),
    maxChildren: Math.max(0, ...children.values()), children, orphans, cycles: [...cycles], missingSources };
}

export function hierarchyIssues(nodes: HierarchyNode[], minimumDepth: number): string[] {
  const stats = inspectHierarchy(nodes);
  const issues: string[] = [];
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) issues.push('id 重复，请为不同节点使用唯一 id');
  if (nodes.length > MINDMAP_MAX_CONCEPTS) issues.push(`概念超过 ${MINDMAP_MAX_CONCEPTS} 个，请依据原文归纳`);
  if (stats.orphans.length) issues.push(`孤立节点/缺少 parentId：${stats.orphans.join(', ')}；每个节点须显式指定父 id，一级分支用 null`);
  if (stats.cycles.length) issues.push(`父子循环：${stats.cycles.join(', ')}；请按原文从属关系解除循环`);
  if (stats.missingSources.length) issues.push(`无来源节点：${stats.missingSources.join(', ')}；补齐 documentId、fileName 和实际页码`);
  if (stats.maxDepth < minimumDepth) issues.push(`最大深度 ${stats.maxDepth} < ${minimumDepth}；请恢复材料中的章→小节→要点，不要平铺或虚构层级`);
  if (stats.maxDepth > MINDMAP_MAX_DEPTH) issues.push(`最大深度 ${stats.maxDepth} > ${MINDMAP_MAX_DEPTH}；请合并冗余层级，保留要点及来源`);
  for (const [parent, count] of stats.children) if (count > MINDMAP_MAX_CHILDREN) issues.push(`节点 ${parent ?? '主题根'} 有 ${count} 个子节点，超过 ${MINDMAP_MAX_CHILDREN}；请按原文主题拆分该层`);
  return issues;
}

/** Conservative, observable chapter + subsection evidence; not a general document classifier. */
export function hasExplicitChapterHierarchy(pages: string[]): boolean {
  const text = pages.join('\n');
  return /(?:^|\n)\s*(?:第[一二三四五六七八九十百\d]+章|chapter\s+\d+)/im.test(text)
    && /(?:^|\s)\d+\.\d+\s+\S/m.test(text);
}
