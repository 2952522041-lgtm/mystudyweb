import type {
  AiCourseKnowledge,
  CourseKnowledge,
  DocumentDigest,
  KnowledgeNode,
  SourceReference,
} from '../course-storage/types.ts';
import { KNOWLEDGE_SCHEMA_VERSION } from '../course-storage/types.ts';

function conceptKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function uniqueSources(sources: SourceReference[]): SourceReference[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.documentId}:${source.pageStart}:${source.pageEnd ?? ''}:${source.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function emptyCourseKnowledge(
  courseId: string,
  courseName: string,
  now = new Date().toISOString(),
): CourseKnowledge {
  return {
    schemaVersion: 1,
    courseId,
    version: 0,
    nodes: [
      {
        id: `course-root-${courseId}`,
        label: courseName,
        description: '课程总知识入口。',
        kind: 'course',
        ownership: 'generated',
        sources: [],
      },
    ],
    relations: [],
    conflicts: [],
    updatedAt: now,
  };
}

export function mergeDocumentDigest(
  current: CourseKnowledge,
  digest: DocumentDigest,
  now = new Date().toISOString(),
): CourseKnowledge {
  const nodes = current.nodes.map((node) => ({
    ...node,
    sources: [...node.sources],
  }));
  const root = nodes.find((node) => node.kind === 'course');
  const relations = [...current.relations];

  for (const concept of digest.concepts) {
    const existing = nodes.find(
      (node) =>
        node.kind !== 'course' &&
        conceptKey(node.label) === conceptKey(concept.label),
    );
    let target: KnowledgeNode;
    if (existing) {
      existing.sources = uniqueSources([
        ...existing.sources,
        ...concept.sources,
      ]);
      if (
        existing.ownership === 'generated' &&
        concept.description.length > existing.description.length
      ) {
        existing.description = concept.description;
      }
      target = existing;
    } else {
      target = {
        id: concept.id,
        label: concept.label,
        description: concept.description,
        kind: 'concept',
        ownership: 'generated',
        sources: concept.sources,
      };
      nodes.push(target);
    }
    if (
      root &&
      !relations.some(
        (relation) => relation.from === root.id && relation.to === target.id,
      )
    ) {
      relations.push({ from: root.id, to: target.id, label: '包含' });
    }
  }

  // 摘要里概念之间的真实关系也要进入知识库，脑图才能呈现层次结构。
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const relation of digest.relations) {
    if (!nodeIds.has(relation.from) || !nodeIds.has(relation.to)) continue;
    if (relation.from === relation.to) continue;
    if (
      relations.some(
        (item) =>
          item.from === relation.from &&
          item.to === relation.to &&
          item.label === relation.label,
      )
    ) {
      continue;
    }
    relations.push(relation);
  }

  return {
    ...current,
    version: current.version + 1,
    nodes,
    relations,
    updatedAt: now,
  };
}

/**
 * 用 AI 综合结果重建课程知识库：
 * - 课程根节点更新为主题描述（用户手工编辑过的根节点除外）；
 * - ownership=user 的节点与涉及它们的既有关系原样保留，AI 不得覆盖或删除；
 * - 生成的节点、关系、冲突全部来自 AI 输出。
 */
export function applyAiCourseKnowledge(
  current: CourseKnowledge,
  ai: AiCourseKnowledge,
  now = new Date().toISOString(),
): CourseKnowledge {
  const nodes: KnowledgeNode[] = [];
  const root = current.nodes.find((node) => node.kind === 'course');
  if (root) {
    nodes.push({
      ...root,
      sources: [...root.sources],
      description:
        root.ownership === 'user' || !ai.theme
          ? root.description
          : ai.theme,
    });
  }

  const userNodes = current.nodes.filter(
    (node) => node.kind !== 'course' && node.ownership === 'user',
  );
  const userKeys = new Set(userNodes.map((node) => conceptKey(node.label)));
  for (const userNode of userNodes) {
    nodes.push({ ...userNode, sources: [...userNode.sources] });
  }

  const usedIds = new Set(nodes.map((node) => node.id));
  for (const aiNode of ai.nodes) {
    if (userKeys.has(conceptKey(aiNode.label))) continue;
    let id = aiNode.id;
    while (usedIds.has(id)) id = `${id}-x`;
    usedIds.add(id);
    nodes.push({
      id,
      label: aiNode.label,
      description: aiNode.description,
      kind: 'concept',
      ownership: 'generated',
      sources: uniqueSources(aiNode.sources),
    });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const relations = [...ai.relations].filter(
    (relation) =>
      nodeIds.has(relation.from) &&
      nodeIds.has(relation.to) &&
      relation.from !== relation.to,
  );
  // 用户节点相关的关系不交给 AI，直接保留，避免用户手工整理丢失。
  const ownershipById = new Map(nodes.map((node) => [node.id, node.ownership]));
  for (const relation of current.relations) {
    if (!nodeIds.has(relation.from) || !nodeIds.has(relation.to)) continue;
    const involvesUser = [relation.from, relation.to].some(
      (id) => ownershipById.get(id) === 'user',
    );
    if (!involvesUser) continue;
    if (
      relations.some(
        (item) =>
          item.from === relation.from &&
          item.to === relation.to &&
          item.label === relation.label,
      )
    ) {
      continue;
    }
    relations.push(relation);
  }

  return {
    ...current,
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    version: current.version + 1,
    nodes,
    relations,
    conflicts: ai.conflicts.map((conflict, index) => ({
      id: `${current.courseId}-conflict-${index + 1}`,
      nodeId: conflict.nodeId,
      descriptions: conflict.descriptions,
      sources: uniqueSources(conflict.sources),
    })),
    unresolvedQuestions: ai.unresolvedQuestions,
    provider: ai.provider,
    model: ai.model,
    promptVersion: ai.promptVersion,
    updatedAt: now,
  };
}

export function removeDocumentContribution(
  current: CourseKnowledge,
  documentId: string,
  now = new Date().toISOString(),
): CourseKnowledge {
  const nodes = current.nodes
    .map((node) => ({
      ...node,
      sources: node.sources.filter(
        (source) => source.documentId !== documentId,
      ),
    }))
    .filter(
      (node) =>
        node.kind === 'course' ||
        node.ownership === 'user' ||
        node.sources.length > 0,
    );
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...current,
    version: current.version + 1,
    nodes,
    relations: current.relations.filter(
      (relation) => ids.has(relation.from) && ids.has(relation.to),
    ),
    conflicts: current.conflicts.filter((conflict) => ids.has(conflict.nodeId)),
    updatedAt: now,
  };
}
