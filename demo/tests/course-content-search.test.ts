import assert from 'node:assert/strict';
import test from 'node:test';
import {
  searchCourseContent,
  type CourseContentSearchInput,
  type CourseSearchHit,
} from '../lib/course-content-search.ts';
import type {
  CourseBundle,
  CourseKnowledge,
  CourseManifest,
  DigestSection,
  DocumentDigest,
  DocumentRecord,
  KnowledgeNode,
} from '../lib/course-storage/types.ts';

function node(
  id: string,
  label: string,
  description: string,
  parentId?: string | null,
): KnowledgeNode {
  return {
    id,
    label,
    description,
    kind: 'concept',
    ownership: 'generated',
    sources: [],
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function document(
  id: string,
  fileName: string,
  pageCount = 1,
  includedInCourse = true,
): DocumentRecord {
  return {
    id,
    fingerprint: `fp-${id}`,
    fileName,
    storedFileName: `${id}.pdf`,
    pageCount,
    status: 'course-merged',
    includedInCourse,
    includeConversationInsights: true,
    hasSummary: true,
    hasMindmap: true,
    importedAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  };
}

function section(
  id: string,
  title: string,
  summary: string,
  pageStart: number,
  pageEnd = pageStart,
): DigestSection {
  return { id, title, summary, pageStart, pageEnd };
}

function digest(
  documentId: string,
  title: string,
  overview: string,
  sections: DigestSection[] = [],
): DocumentDigest {
  return {
    schemaVersion: 3,
    documentId,
    fingerprint: `fp-${documentId}`,
    title,
    overview,
    sections,
    concepts: [],
    relations: [],
    unresolvedQuestions: [],
    sourcePages: sections.map((item) => item.pageStart),
    promptVersion: 'local-structure-v1',
    updatedAt: '2024-01-03T00:00:00.000Z',
  };
}

function bundle(input: {
  documents?: DocumentRecord[];
  nodes?: KnowledgeNode[];
  digests?: Record<string, DocumentDigest>;
}): CourseBundle {
  const manifest: CourseManifest = {
    schemaVersion: 1,
    id: 'course-1',
    name: '测试课程',
    revision: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    activeKnowledgeVersion: 1,
    documents: input.documents ?? [],
  };
  const knowledge: CourseKnowledge = {
    schemaVersion: 3,
    courseId: 'course-1',
    version: 1,
    nodes: input.nodes ?? [],
    relations: [],
    conflicts: [],
    updatedAt: '2024-01-02T00:00:00.000Z',
  };
  return { manifest, knowledge, digests: input.digests ?? {} };
}

function run(
  input: Omit<CourseContentSearchInput, 'bundle'> & { bundle: CourseBundle },
) {
  return searchCourseContent(input);
}

const ids = (hits: CourseSearchHit[]) => hits.map((hit) => hit.id);
const kinds = (hits: CourseSearchHit[]) => hits.map((hit) => hit.kind);

void test('empty and whitespace-only queries return no hits', () => {
  const course = bundle({
    nodes: [node('n1', '电阻', '导体对电流的阻碍作用')],
  });
  assert.deepEqual(run({ bundle: course, query: '' }), []);
  assert.deepEqual(run({ bundle: course, query: '   ' }), []);
  assert.deepEqual(run({ bundle: course, query: '\u3000\t\n' }), []);
});

void test('multi-term queries require every term in combined title and text', () => {
  const course = bundle({
    nodes: [
      node('n1', '欧姆定律', '电压等于电流乘以电阻'),
      node('n2', '电功率', '电流做功的快慢'),
    ],
  });
  const both = run({ bundle: course, query: '电流 电压' });
  assert.deepEqual(ids(both), ['knowledge:n1']);
  assert.deepEqual(run({ bundle: course, query: '电流 磁场' }), []);
});

void test('matching is case-insensitive and NFKC normalizes full-width and compatibility text', () => {
  const course = bundle({
    documents: [document('d1', 'ＣＡＴ Notes.pdf')],
    nodes: [node('n1', 'ＲＥＳＩＳＴＯＲ', 'ＦＵＬＬｗｉｄｔｈ　ｓｐａｃｅ')],
  });
  assert.deepEqual(ids(run({ bundle: course, query: 'cat notes' })), [
    'document:d1',
  ]);
  assert.deepEqual(ids(run({ bundle: course, query: 'resistor' })), [
    'knowledge:n1',
  ]);
  assert.deepEqual(ids(run({ bundle: course, query: 'fullwidth' })), [
    'knowledge:n1',
  ]);
});

void test('Chinese substring search works without word boundaries', () => {
  const course = bundle({
    nodes: [node('n1', '串联电路', '串联电路中各处电流相等')],
  });
  assert.deepEqual(ids(run({ bundle: course, query: '串联' })), [
    'knowledge:n1',
  ]);
  assert.deepEqual(ids(run({ bundle: course, query: '各处 电流' })), [
    'knowledge:n1',
  ]);
});

void test('all knowledge nodes are searchable, including nested and folded descendants', () => {
  const course = bundle({
    nodes: [
      node('root', '电路基础', '课程根节点'),
      node('child', '基尔霍夫定律', '节点电流之和为零', 'root'),
      node('grandchild', '回路电压定律', '沿闭合回路电压降代数和为零', 'child'),
    ],
  });
  const hits = run({ bundle: course, query: '代数和' });
  assert.deepEqual(ids(hits), ['knowledge:grandchild']);
  assert.equal(hits[0].kind, 'knowledge');
  assert.equal(hits[0].nodeId, 'grandchild');
});

void test('digest titles and overviews are document hits while sections carry page destinations', () => {
  const course = bundle({
    documents: [document('d1', 'chapter.pdf', 4)],
    digests: {
      d1: digest('d1', '第一章 静电场', '电荷周围存在电场', [
        section('s1', '库仑定律', '点电荷之间的作用力', 2),
      ]),
    },
  });
  const docHits = run({ bundle: course, query: '静电场' });
  assert.deepEqual(ids(docHits), ['digest:d1']);
  assert.equal(docHits[0].kind, 'document');
  assert.equal(docHits[0].documentId, 'd1');

  const sectionHits = run({ bundle: course, query: '库仑' });
  assert.deepEqual(ids(sectionHits), ['digest:d1:section:s1']);
  assert.equal(sectionHits[0].kind, 'page');
  assert.equal(sectionHits[0].documentId, 'd1');
  assert.equal(sectionHits[0].page, 2);
  assert.equal(sectionHits[0].title, '库仑定律');
});

void test('note paragraphs report one-based start lines across blank-line paragraphs', () => {
  const course = bundle({});
  const notes = [
    '## 学习摘记', // line 1
    '', // line 2
    '第一行内容', // line 3
    '第二行内容', // line 4
    '', // line 5
    '另一段：欧姆定律', // line 6
  ].join('\n');
  const hits = run({ bundle: course, notes, query: '第二行' });
  assert.deepEqual(ids(hits), ['note:3']);
  assert.equal(hits[0].kind, 'note');
  assert.equal(hits[0].line, 3);
  assert.equal(hits[0].title, '第一行内容');
  assert.match(hits[0].excerpt, /第一行内容 第二行内容/u);

  const second = run({ bundle: course, notes, query: '另一段' });
  assert.deepEqual(ids(second), ['note:6']);
  assert.equal(second[0].line, 6);
});

void test('supplied pages match every manifest document, rejecting unknown ids and out-of-range indices', () => {
  const course = bundle({
    documents: [
      document('d1', 'included.pdf', 2, true),
      document('d2', 'pdf-only.pdf', 2, false),
    ],
  });
  const pages = [
    {
      documentId: 'd1',
      pages: ['第一页提到电阻', '第二页提到电压', '第三页越界'],
    },
    { documentId: 'd2', pages: ['未纳入课程但含磁场', '第二页含电容'] },
    { documentId: 'orphan', pages: ['孤立文档含电感'] },
  ];
  assert.deepEqual(ids(run({ bundle: course, pages, query: '电阻' })), [
    'page:d1:1',
  ]);
  assert.deepEqual(ids(run({ bundle: course, pages, query: '电压' })), [
    'page:d1:2',
  ]);
  assert.deepEqual(run({ bundle: course, pages, query: '越界' }), []);
  assert.deepEqual(ids(run({ bundle: course, pages, query: '磁场' })), [
    'page:d2:1',
  ]);
  assert.deepEqual(ids(run({ bundle: course, pages, query: '电容' })), [
    'page:d2:2',
  ]);
  assert.deepEqual(run({ bundle: course, pages, query: '电感' }), []);

  const hit = run({ bundle: course, pages, query: '电阻' })[0];
  assert.equal(hit.kind, 'page');
  assert.equal(hit.documentId, 'd1');
  assert.equal(hit.page, 1);
  assert.equal(hit.title, 'included.pdf');
});

void test('PDF-only imports excluded from the course are still searchable via supplied pages', () => {
  const course = bundle({
    documents: [document('pdf-only', '仅导入的讲义.pdf', 2, false)],
  });
  const pages = [
    { documentId: 'pdf-only', pages: ['', '第二页的磁场公式', '第三页越界'] },
  ];
  const hits = run({ bundle: course, pages, query: '磁场公式' });
  assert.deepEqual(ids(hits), ['page:pdf-only:2']);
  assert.equal(hits[0].kind, 'page');
  assert.equal(hits[0].documentId, 'pdf-only');
  assert.equal(hits[0].page, 2);
  assert.equal(hits[0].title, '仅导入的讲义.pdf');
  assert.deepEqual(run({ bundle: course, pages, query: '越界' }), []);
  assert.deepEqual(run({ bundle: course, pages, query: '电感' }), []);
});

void test('digests are matched only for actual manifest documents with valid section pages', () => {
  const course = bundle({
    documents: [
      document('d1', 'chapter.pdf', 4, true),
      document('pdf-only', 'pdf-only.pdf', 2, false),
    ],
    digests: {
      d1: digest('d1', '第一章', '正文综述', [
        section('s1', '有效小节', '小节摘要', 2),
        section('s2', '越界小节', '越界摘要', 9),
      ]),
      'pdf-only': digest('pdf-only', '仅导入摘要', '仅导入综述', [
        section('s3', 'PDF小节', 'PDF小节摘要', 1),
      ]),
      ghost: digest('ghost', '幽灵文档摘要', '幽灵文档综述', [
        section('s4', '幽灵小节', '幽灵内容', 1),
      ]),
    },
  });

  assert.deepEqual(ids(run({ bundle: course, query: '正文综述' })), [
    'digest:d1',
  ]);
  assert.deepEqual(ids(run({ bundle: course, query: '有效小节' })), [
    'digest:d1:section:s1',
  ]);
  assert.deepEqual(run({ bundle: course, query: '越界摘要' }), []);
  assert.deepEqual(ids(run({ bundle: course, query: '仅导入综述' })), [
    'digest:pdf-only',
  ]);
  assert.deepEqual(ids(run({ bundle: course, query: 'PDF小节摘要' })), [
    'digest:pdf-only:section:s3',
  ]);
  assert.deepEqual(run({ bundle: course, query: '幽灵' }), []);
});

void test('section point text is searchable and appears in the excerpt', () => {
  const course = bundle({
    documents: [document('d1', 'physics.pdf', 3)],
    digests: {
      d1: digest('d1', '物理摘要', '概要内容', [
        {
          id: 's1',
          title: '公式小节',
          summary: '本节列出关键公式',
          pageStart: 2,
          pageEnd: 2,
          points: [
            { text: '欧姆定律 U = I × R', pageStart: 2, pageEnd: 2 },
            { text: '电功率 P = U × I', pageStart: 3, pageEnd: 3 },
          ],
        },
      ]),
    },
  });
  const formula = run({ bundle: course, query: '欧姆定律' });
  assert.deepEqual(ids(formula), ['digest:d1:section:s1']);
  assert.equal(formula[0].kind, 'page');
  assert.equal(formula[0].page, 2);
  assert.match(formula[0].excerpt, /欧姆定律/u);

  const combined = run({ bundle: course, query: '关键公式 欧姆定律' });
  assert.deepEqual(ids(combined), ['digest:d1:section:s1']);

  const secondPoint = run({ bundle: course, query: '电功率' });
  assert.deepEqual(ids(secondPoint), ['digest:d1:section:s1']);
  assert.equal(secondPoint[0].page, 2);
  assert.match(secondPoint[0].excerpt, /电功率/u);
});

void test('results are ordered filename then knowledge then digests then notes then pages', () => {
  const course = bundle({
    documents: [document('d1', '共享主题.pdf', 1)],
    nodes: [node('n1', '共享主题概念', '共享主题说明')],
    digests: { d1: digest('d1', '共享主题摘要', '共享主题综述') },
  });
  const notes = '共享主题笔记';
  const pages = [{ documentId: 'd1', pages: ['共享主题页面'] }];
  const hits = run({ bundle: course, notes, pages, query: '共享主题' });
  assert.deepEqual(kinds(hits), [
    'document',
    'knowledge',
    'document',
    'note',
    'page',
  ]);
  assert.deepEqual(ids(hits), [
    'document:d1',
    'knowledge:n1',
    'digest:d1',
    'note:1',
    'page:d1:1',
  ]);
});

void test('hits have unique ids and a repeated call yields an identical order', () => {
  const course = bundle({
    documents: [document('d1', '电路.pdf', 1)],
    nodes: [
      node('n1', '电路概念', '电路描述'),
      node('n2', '电路应用', '电路应用描述'),
    ],
    digests: { d1: digest('d1', '电路摘要', '电路综述') },
  });
  const input = {
    bundle: course,
    notes: '电路笔记\n\n电路补充',
    pages: [{ documentId: 'd1', pages: ['电路页面'] }],
    query: '电路',
  };
  const first = run(input);
  const second = run(input);
  assert.deepEqual(first, second);
  assert.equal(new Set(ids(first)).size, first.length);
});

void test('excerpts are whitespace-normalized, bounded to 180 characters and centered on the body match', () => {
  const prefix = '前'.repeat(120);
  const suffix = '后'.repeat(120);
  const course = bundle({
    nodes: [node('n1', '标题', `${prefix} 目标词 ${suffix}`)],
  });
  const hits = run({ bundle: course, query: '目标词' });
  assert.equal(hits.length, 1);
  assert.ok(
    hits[0].excerpt.length <= 180,
    `excerpt length ${hits[0].excerpt.length}`,
  );
  assert.ok(hits[0].excerpt.includes('目标词'));
  assert.doesNotMatch(hits[0].excerpt, /\s{2,}/u);

  const noisy = bundle({
    nodes: [node('n2', '标题', '  第一行\n\n第二行\t第三行  ')],
  });
  const noisyHit = run({ bundle: noisy, query: '第三行' })[0];
  assert.equal(noisyHit.excerpt, '第一行 第二行 第三行');
});

void test('a title-only match still yields a bounded excerpt from the body', () => {
  const course = bundle({
    nodes: [node('n1', '仅标题命中', '正文从这里开始并且不包含那个词')],
  });
  const hits = run({ bundle: course, query: '仅标题命中' });
  assert.deepEqual(ids(hits), ['knowledge:n1']);
  assert.equal(hits[0].excerpt, '正文从这里开始并且不包含那个词');
});

void test('limit defaults to 50, is capped at 200 and clamps invalid input safely', () => {
  const nodes = Array.from({ length: 260 }, (_, index) =>
    node(`n${index}`, `节点${index}`, `描述${index}`),
  );
  const course = bundle({ nodes });
  assert.equal(run({ bundle: course, query: '节点' }).length, 50);
  assert.equal(run({ bundle: course, query: '节点', limit: 10 }).length, 10);
  assert.equal(run({ bundle: course, query: '节点', limit: 500 }).length, 200);
  assert.equal(run({ bundle: course, query: '节点', limit: 0 }).length, 0);
  assert.equal(run({ bundle: course, query: '节点', limit: -5 }).length, 0);
  assert.equal(
    run({ bundle: course, query: '节点', limit: Number.NaN }).length,
    50,
  );
  assert.equal(run({ bundle: course, query: '节点', limit: 2.9 }).length, 2);
});

void test('input bundle, notes and pages are never mutated', () => {
  const course = bundle({
    documents: [document('d1', '电路.pdf', 2)],
    nodes: [node('n1', '电路概念', '电路描述')],
    digests: {
      d1: digest('d1', '电路摘要', '电路综述', [
        section('s1', '电路小节', '小节内容', 1),
      ]),
    },
  });
  const notes = '电路笔记\n\n电路补充';
  const pages = [{ documentId: 'd1', pages: ['电路第一页', '电路第二页'] }];
  const snapshot = JSON.parse(JSON.stringify({ course, notes, pages }));
  run({ bundle: course, notes, pages, query: '电路' });
  assert.deepEqual(
    JSON.parse(JSON.stringify({ course, notes, pages })),
    snapshot,
  );
  assert.equal(pages[0].pages.length, 2);
});
