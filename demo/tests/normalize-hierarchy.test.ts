import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceReference } from '../lib/course-storage/types.ts';
import { normalizeHierarchy } from '../lib/knowledge/normalize-hierarchy.ts';

type TestNode = {
  id: string;
  parentId: string | null;
  label: string;
  description: string;
  sources: SourceReference[];
};

function source(pageStart: number, pageEnd = pageStart): SourceReference {
  return {
    documentId: 'doc-1',
    fileName: 'lecture.pdf',
    pageStart,
    pageEnd,
    type: 'pdf',
  };
}

function node(
  id: string,
  parentId: string | null,
  label = id,
  page = 1,
): TestNode {
  return {
    id,
    parentId,
    label,
    description: `原文说明-${id}`,
    sources: [source(page)],
  };
}

function fortyFourNodeShape(): TestNode[] {
  const nodes: TestNode[] = [
    node('c1', null, '课程主题', 1),
    node('c2', 'c1', '函数基础', 2),
    node('c3', 'c2', '函数定义', 3),
    node('c4', 'c2', '函数参数', 4),
    node('c5', 'c1', '控制流', 5),
    node('c6', 'c5', '条件语句', 6),
    node('c7', 'c5', '循环语句', 7),
    node('c8', 'c1', '变量', 8),
    node('c9', 'c1', '数据类型', 9),
    node('c10', 'c1', '输入输出', 10),
    node('c11', 'c1', '错误处理', 11),
    node('c12', 'c1', '模块', 12),
    node('c13', 'c12', '导入', 13),
    node('c14', 'c12', '导出', 14),
    node('c15', 'c1', '随机数', 15),
    node('c16', 'c15', '伪随机', 16),
    node('c17', 'c15', '随机种子', 17),
    node('c18', 'c15', '随机分布', 18),
    node('c19', 'c15', '随机函数', 19),
    node('c20', 'c19', 'randomChance函数', 20),
    node('c21', 'c19', 'randomBool函数', 21),
    node('c22', 'c19', 'setRandomSeed函数', 22),
    node('c23', 'c19', 'initRandomSeed函数', 23),
    node('c24', 'c19', '随机数示例', 24),
    node('c25', null, '接口', 25),
    node('c26', null, '实现', 26),
    node('c27', null, '调试', 27),
    node('c28', null, '标准库', 28),
    node('c29', 'c28', 'math模块', 29),
    node('c30', 'c28', 'random模块', 30),
    node('c31', 'c28', 'randomChance函数', 31),
    node('c32', 'c28', 'randomBool函数', 32),
    node('c33', 'c28', 'setRandomSeed函数', 33),
    node('c34', null, '第三方库', 34),
    node('c35', 'c34', 'initRandomSeed函数', 35),
    node('c36', 'c34', 'random模块', 36),
    node('c37', 'c34', 'randomBool函数', 37),
    node('c38', 'c34', 'randomChance函数', 38),
    node('c39', 'c34', 'setRandomSeed函数', 39),
    node('c40', 'c34', 'setRandomSeed函数', 40),
    node('c41', 'c34', 'randomChance函数', 41),
    node('c42', 'c34', 'randomBool函数', 42),
    node('c43', 'c34', 'initRandomSeed函数', 43),
    node('c44', 'c34', 'random.random函数', 44),
  ];
  assert.equal(nodes.length, 44);
  return nodes;
}

function childCounts(nodes: TestNode[]): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const current of nodes)
    counts.set(current.parentId, (counts.get(current.parentId) ?? 0) + 1);
  return counts;
}

void test('repairs the 44-node shape without losing source facts or inventing branches', () => {
  const input = fortyFourNodeShape();
  const before = structuredClone(input);
  const result = normalizeHierarchy(input);
  assert.ok(result);
  assert.deepEqual(input, before, 'normalization must not mutate its input');
  assert.equal(result.nodes.length, 44);
  assert.equal(new Set(result.nodes.map((current) => current.id)).size, 44);
  assert.deepEqual(result.promoted, [
    { id: 'c20', from: 'c19', to: 'c15' },
    { id: 'c21', from: 'c19', to: 'c15' },
    { id: 'c22', from: 'c19', to: 'c15' },
    { id: 'c23', from: 'c19', to: 'c15' },
    { id: 'c24', from: 'c19', to: 'c15' },
    { id: 'c44', from: 'c34', to: null },
  ]);

  const byId = new Map(result.nodes.map((current) => [current.id, current]));
  for (const original of input) {
    const normalized = byId.get(original.id)!;
    assert.equal(normalized.description, original.description);
    assert.deepEqual(normalized.sources, original.sources);
    assert.notStrictEqual(normalized.sources, original.sources);
  }
  assert.equal(byId.get('c44')?.parentId, null);
  assert.ok(byId.get('c31')?.label.includes('标准库'));
  assert.ok(byId.get('c31')?.label.includes('第31页'));
  assert.ok(byId.get('c38')?.label.includes('第三方库'));
  assert.ok(byId.get('c41')?.label.includes('第41页'));
  assert.equal(new Set(result.nodes.map((current) => current.label)).size, 44);
  for (const count of childCounts(result.nodes).values()) assert.ok(count <= 9);
  for (const current of result.nodes) {
    if (current.parentId !== null) assert.ok(byId.has(current.parentId));
  }
});

void test('qualifies same-parent duplicate labels with the original context and id', () => {
  const input = [
    node('root', null, '主题', 1),
    node('branch', 'root', '分支', 2),
    node('first', 'branch', '同名接口', 7),
    node('second', 'branch', '同名接口', 7),
  ];
  const result = normalizeHierarchy(input);
  assert.ok(result);
  const first = result.nodes.find((current) => current.id === 'first')!;
  const second = result.nodes.find((current) => current.id === 'second')!;
  assert.match(first.label, /分支/);
  assert.match(first.label, /第7页/);
  assert.match(second.label, /分支/);
  assert.match(second.label, /第7页/);
  assert.match(first.label, /first|second/);
  assert.match(second.label, /first|second/);
  assert.equal(new Set(result.nodes.map((current) => current.label)).size, 4);
  assert.equal(result.promoted.length, 0);
});

void test('rejects malformed input and refuses an overfull root with no legal ancestor', () => {
  const malformed: Array<[string, (input: TestNode[]) => void]> = [
    [
      'duplicate id',
      (input) => {
        input[1].id = input[0].id;
      },
    ],
    [
      'unknown parent',
      (input) => {
        input[1].parentId = 'missing';
      },
    ],
    [
      'cycle',
      (input) => {
        input[0].parentId = 'child';
        input[1].parentId = 'root';
      },
    ],
    [
      'empty source',
      (input) => {
        input[1].sources = [];
      },
    ],
    [
      'too many nodes',
      (input) => {
        input.push(
          ...Array.from({ length: 58 }, (_, index) =>
            node(`extra-${index}`, null, `额外${index}`, index + 3),
          ),
        );
      },
    ],
  ];
  for (const [name, mutate] of malformed) {
    const input = [node('root', null, '根'), node('child', 'root', '子')];
    mutate(input);
    assert.equal(normalizeHierarchy(input), undefined, name);
  }

  const overfullRoot = Array.from({ length: 10 }, (_, index) =>
    node(`root-${index}`, null, `根分支${index}`, index + 1),
  );
  assert.equal(normalizeHierarchy(overfullRoot), undefined);
  assert.equal(
    overfullRoot.length,
    10,
    'a failed repair must not add a synthetic group',
  );
});

void test('keeps a shallow hierarchy unchanged instead of creating placeholder levels', () => {
  const input = [
    node('root', null, '主题', 1),
    node('chapter', 'root', '章节', 2),
    node('point', 'chapter', '要点', 3),
  ];
  const result = normalizeHierarchy(input);
  assert.ok(result);
  assert.equal(result.promoted.length, 0);
  assert.deepEqual(
    result.nodes.map((current) => current.parentId),
    [null, 'root', 'chapter'],
  );
  assert.deepEqual(
    result.nodes.map((current) => current.id),
    input.map((current) => current.id),
  );
});
