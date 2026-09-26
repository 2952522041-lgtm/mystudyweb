import { conceptKey } from './concept-identity.ts';
import type {
  AiCourseKnowledge,
  CourseKnowledge,
  DocumentDigest,
  KnowledgeNode,
  SourceReference,
} from '../course-storage/types.ts';
import { KNOWLEDGE_SCHEMA_VERSION } from '../course-storage/types.ts';

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

  const idMap = new Map<string, string>();
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
    idMap.set(concept.id, target.id);
    if (
      root &&
      (concept.parentId === undefined || concept.parentId === null) &&
      !relations.some(
        (relation) => relation.from === root.id && relation.to === target.id,
      )
    ) {
      relations.push({ from: root.id, to: target.id, label: '包含' });
    }
  }

  for (const concept of digest.concepts) {
    const target = nodes.find(node => node.id === idMap.get(concept.id));
    if (target && target.ownership !== 'user' && concept.parentId !== undefined) {
      target.parentId = concept.parentId === null ? null : idMap.get(concept.parentId) ?? concept.parentId;
    }
  }

  // 摘要里概念之间的真实关系也要进入知识库，脑图才能呈现层次结构。
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const raw of digest.relations) {
    const relation = { ...raw, from: idMap.get(raw.from) ?? raw.from, to: idMap.get(raw.to) ?? raw.to };
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
  for (const userNode of userNodes) {
    nodes.push({ ...userNode, sources: [...userNode.sources] });
  }

  const byKey = new Map(nodes.filter((node) => node.kind !== 'course').map((node) => [conceptKey(node.label), node]));
  const previousByKey = new Map(current.nodes.filter((node) => node.kind !== 'course').map((node) => [conceptKey(node.label), node]));
  // Reserve every old ID so a reordered model response cannot steal another concept's ID.
  const usedIds = new Set(current.nodes.map((node) => node.id));
  const idMap = new Map<string, string>();
  for (const aiNode of ai.nodes) {
    const key = conceptKey(aiNode.label);
    let target = byKey.get(key);
    if (target) {
      target.sources = uniqueSources([...target.sources, ...aiNode.sources]);
    } else {
      const previous = previousByKey.get(key);
      let id = previous?.id ?? aiNode.id;
      if (!previous) while (usedIds.has(id)) id = `${id}-x`;
      usedIds.add(id);
      target = { ...aiNode, id, kind: 'concept', ownership: 'generated', sources: uniqueSources(aiNode.sources) };
      nodes.push(target);
      byKey.set(key, target);
    }
    idMap.set(aiNode.id, target.id);
  }

  for (const aiNode of ai.nodes) {
    const target = nodes.find(node => node.id === idMap.get(aiNode.id));
    if (target && target.ownership !== 'user' && aiNode.parentId !== undefined) {
      target.parentId = aiNode.parentId === null ? null : idMap.get(aiNode.parentId) ?? aiNode.parentId;
    }
  }

  // Keep user-authored relationships even when the model omits their generated endpoint.
  const userIds = new Set(current.nodes.filter((node) => node.ownership === 'user').map((node) => node.id));
  const userRelations = current.relations.filter((relation) => userIds.has(relation.from) || userIds.has(relation.to));
  for (const relation of userRelations) {
    for (const id of [relation.from, relation.to]) {
      if (nodes.some((node) => node.id === id)) continue;
      const previous = current.nodes.find((node) => node.id === id);
      if (previous) nodes.push({ ...previous, sources: [...previous.sources] });
    }
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const relations = [
    ...ai.relations.map((relation) => ({ ...relation, from: idMap.get(relation.from) ?? relation.from, to: idMap.get(relation.to) ?? relation.to })),
    ...userRelations,
  ].filter((relation) => {
    const key = JSON.stringify([relation.from, relation.to, relation.label]);
    if (!nodeIds.has(relation.from) || !nodeIds.has(relation.to) || relation.from === relation.to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    ...current,
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    version: current.version + 1,
    nodes,
    relations,
    conflicts: ai.conflicts.filter((conflict) => nodeIds.has(idMap.get(conflict.nodeId) ?? conflict.nodeId)).map((conflict, index) => ({
      id: `${current.courseId}-conflict-${index + 1}`,
      nodeId: idMap.get(conflict.nodeId) ?? conflict.nodeId,
      descriptions: conflict.descriptions,
      sources: uniqueSources(conflict.sources),
    })),
    unresolvedQuestions: ai.unresolvedQuestions,
    evidence: ai.evidence,
    diagnostics: ai.diagnostics,
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
    evidence: current.evidence?.map(item => ({ ...item, sources: item.sources.filter(source => source.documentId !== documentId) })).filter(item => item.sources.length),
    version: current.version + 1,
    nodes: nodes.map(node => node.parentId && !ids.has(node.parentId) ? { ...node, parentId: null } : node),
    relations: current.relations.filter(
      (relation) => ids.has(relation.from) && ids.has(relation.to),
    ),
    conflicts: current.conflicts.filter((conflict) => ids.has(conflict.nodeId)),
    updatedAt: now,
  };
}
