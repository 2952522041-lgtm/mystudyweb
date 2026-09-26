import type { DocumentDigest } from '../../lib/course-storage/types.ts';
export const formula = '$$E = mc^2$$';
export const table = '| 条件 | 结果 |\n| --- | --- |\n| m=1 | E=c² |';
export const paperPages = [
  `定义：质量 m 为正。\n\n${formula}\n\n${table}\n\n结论：能量正比于质量。`,
];
export const lecturePages = Array.from(
  { length: 6 },
  (_, index) => `第 ${index + 1} 页材料\n` + '讲义内容及适用条件。'.repeat(850),
);
export const settings = {
  baseUrl: 'https://hierarchy.test/v1',
  apiKey: 'mock-only',
  model: 'mock-knowledge',
};
export function source(documentId = 'lecture', pageStart = 1) {
  return {
    documentId,
    fileName: `${documentId}.pdf`,
    pageStart,
    pageEnd: pageStart,
    type: 'pdf' as const,
  };
}
export function reply(documentId = 'lecture', pageStart = 1, verbose = false) {
  return {
    hierarchy: { mode: 'flat', reason: '单一主题，无从属章节' },
    title: documentId,
    overview: '材料概述',
    theme: '课程主题',
    sections: Array.from({ length: verbose ? 3 : 1 }, (_, index) => ({
      title: `主题 ${index}`,
      summary: verbose ? '讲义中的详细实验分析。'.repeat(130) : '简短概括',
      pageStart,
      pageEnd: pageStart,
    })),
    concepts: [
      {
        id: 'c1',
        parentId: null,
        label: '能量',
        description: '能量关系与条件',
        sources: [source(documentId, pageStart)],
      },
    ],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
  };
}
export function legacyLongDigest(id: string): DocumentDigest {
  return {
    schemaVersion: 3,
    documentId: id,
    fingerprint: id,
    title: id,
    overview: '历史长讲义',
    sections: Array.from({ length: 12 }, (_, index) => ({
      id: `s${index}`,
      title: `段落 ${index}`,
      summary: '长讲义的详细叙述。'.repeat(300),
      pageStart: index + 1,
      pageEnd: index + 1,
    })),
    concepts: reply(id).concepts,
    relations: [],
    sourcePages: Array.from({ length: 12 }, (_, i) => i + 1),
    unresolvedQuestions: [],
    promptVersion: 'old',
    updatedAt: '',
  };
}
