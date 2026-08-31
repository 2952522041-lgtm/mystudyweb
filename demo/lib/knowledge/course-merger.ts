import type {
  CourseKnowledge,
  DocumentDigest,
  KnowledgeNode,
  SourceReference,
} from '../course-storage/types.ts';

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

  return {
    ...current,
    version: current.version + 1,
    nodes,
    relations,
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
