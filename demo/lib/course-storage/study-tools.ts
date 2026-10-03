import type {
  CourseKnowledge,
  CourseStorage,
  DocumentRecord,
  SourceReference,
} from './types.ts';
import type { DocumentProgress } from '../reader-cache.ts';
import { assertSafeArtifactContent, sha256Hex } from './file-utils.ts';

export interface CourseNotesSnapshot {
  content: string;
  token: string;
}
export interface CourseHistoryEntry {
  id: string;
  revision?: number;
  updatedAt: string;
  knowledge: CourseKnowledge;
  summary: string;
  source: 'snapshot' | 'knowledge';
}

const writeTails = new WeakMap<object, Promise<void>>();
export async function withLocalWriteLock<T>(
  owner: object,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = writeTails.get(owner) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeTails.set(owner, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (writeTails.get(owner) === current) writeTails.delete(owner);
  }
}

export async function notesSnapshot(
  content: string,
): Promise<CourseNotesSnapshot> {
  return {
    content,
    token: await sha256Hex(new TextEncoder().encode(content).buffer),
  };
}

export function assertNotesUnchanged(
  current: CourseNotesSnapshot,
  expectedToken: string,
): void {
  if (current.token !== expectedToken)
    throw new Error(
      '课程笔记已在其他窗口或外部修改。你的草稿已保留，请重新加载并合并后保存。',
    );
}

export function noteMarkdown(
  input: { text: string; sources?: SourceReference[]; title?: string },
  now = new Date().toISOString(),
): string {
  if (!input.text.trim()) throw new Error('笔记内容不能为空。');
  const sources = input.sources
    ?.map(
      (source) =>
        `${source.fileName} · 第 ${source.pageStart}${source.pageEnd && source.pageEnd !== source.pageStart ? `–${source.pageEnd}` : ''} 页`,
    )
    .join('；');
  const text = `\n\n## ${(input.title ?? '学习摘记').replace(/[\r\n]+/g, ' ')}\n\n${input.text.trim()}\n\n> 记录时间：${now}${sources ? `\n> 来源：${sources.replace(/[\r\n]+/g, ' ')}` : ''}\n`;
  assertSafeArtifactContent(text);
  return text;
}

export async function appendStudyNote(
  storage: CourseStorage,
  input: { text: string; sources?: SourceReference[]; title?: string },
): Promise<void> {
  if (!storage.loadNotes || !storage.saveNotes)
    throw new Error('此课程暂不支持保存笔记。');
  const current = await storage.loadNotes();
  await storage.saveNotes(current.content + noteMarkdown(input), current.token);
}

export function artifactStatus(
  document: Pick<DocumentRecord, 'hasSummary' | 'hasMindmap'>,
): string {
  if (document.hasSummary && document.hasMindmap) return '总结与脑图已生成';
  if (document.hasSummary) return '总结已生成 · 脑图未生成';
  if (document.hasMindmap) return '脑图已生成 · 总结未生成';
  return '未生成独立成果';
}

export type DocumentSort = 'recent-read' | 'recent-import' | 'name';
export function selectStudyDocuments(
  documents: DocumentRecord[],
  progress: DocumentProgress[],
  query = '',
  sort: DocumentSort = 'recent-read',
): DocumentRecord[] {
  const recent = new Map(
    progress.map((item) => [item.fingerprint, item.updatedAt]),
  );
  const term = query.trim().toLocaleLowerCase();
  return documents
    .filter((doc) => doc.fileName.toLocaleLowerCase().includes(term))
    .sort((a, b) => {
      if (sort === 'name')
        return a.fileName.localeCompare(b.fileName, 'zh-CN', { numeric: true });
      if (sort === 'recent-read') {
        const difference = (recent.get(b.fingerprint) ?? '').localeCompare(
          recent.get(a.fingerprint) ?? '',
        );
        if (difference) return difference;
      }
      return (
        b.importedAt.localeCompare(a.importedAt) ||
        a.fileName.localeCompare(b.fileName)
      );
    });
}

export function compareKnowledge(
  before: CourseKnowledge,
  after: CourseKnowledge,
) {
  const previous = new Map(before.nodes.map((node) => [node.id, node]));
  const current = new Map(after.nodes.map((node) => [node.id, node]));
  const relationKey = (relation: CourseKnowledge['relations'][number]) =>
    JSON.stringify([relation.from, relation.to, relation.label]);
  const beforeRelations = new Set(before.relations.map(relationKey));
  const afterRelations = new Set(after.relations.map(relationKey));
  return {
    added: after.nodes.filter((node) => !previous.has(node.id)),
    removed: before.nodes.filter((node) => !current.has(node.id)),
    changed: after.nodes.filter(
      (node) =>
        previous.has(node.id) &&
        JSON.stringify(previous.get(node.id)) !== JSON.stringify(node),
    ),
    questionsAdded: (after.unresolvedQuestions ?? []).filter(
      (question) => !before.unresolvedQuestions?.includes(question),
    ),
    questionsRemoved: (before.unresolvedQuestions ?? []).filter(
      (question) => !after.unresolvedQuestions?.includes(question),
    ),
    relationsAdded: after.relations.filter(
      (relation) => !beforeRelations.has(relationKey(relation)),
    ),
    relationsRemoved: before.relations.filter(
      (relation) => !afterRelations.has(relationKey(relation)),
    ),
    conflictsChanged:
      JSON.stringify(before.conflicts) !== JSON.stringify(after.conflicts),
    evidenceChanged:
      JSON.stringify(before.evidence ?? []) !==
      JSON.stringify(after.evidence ?? []),
  };
}

export function isHistoryKnowledge(value: unknown): value is CourseKnowledge {
  if (!value || typeof value !== 'object') return false;
  const item = value as CourseKnowledge;
  return (
    typeof item.courseId === 'string' &&
    Number.isInteger(item.version) &&
    typeof item.updatedAt === 'string' &&
    Array.isArray(item.nodes) &&
    item.nodes.every(
      (node) =>
        typeof node.id === 'string' &&
        typeof node.label === 'string' &&
        typeof node.description === 'string' &&
        Array.isArray(node.sources),
    ) &&
    Array.isArray(item.relations) &&
    Array.isArray(item.conflicts)
  );
}
