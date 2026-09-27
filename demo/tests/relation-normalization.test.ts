import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContainmentDirection } from '../lib/knowledge/relation-normalization.ts';

function concepts() {
  return [
    { id: 'root', parentId: null, label: '根', description: '根说明', sources: ['root-source'] },
    { id: 'child', parentId: 'root', label: '子', description: '子说明', sources: ['child-source'] },
  ];
}

void test('reverses an unambiguous child-to-parent containment edge only', () => {
  const raw = {
    concepts: concepts(),
    relations: [
      { from: 'child', to: 'root', label: '包含', extra: { keep: true } },
      { from: 'root', to: 'child', label: '关联' },
    ],
  };
  const before = structuredClone(raw);
  const result = normalizeContainmentDirection(raw) as {
    value: typeof raw;
    correctedEdges: number;
  };

  assert.equal(result.correctedEdges, 1);
  assert.deepEqual(result.value.relations, [
    { from: 'root', to: 'child', label: '包含', extra: { keep: true } },
    { from: 'root', to: 'child', label: '关联' },
  ]);
  assert.deepEqual(raw, before, 'normalization must not mutate its input');
  assert.notStrictEqual(result.value, raw);
  assert.notStrictEqual(result.value.relations, raw.relations);
  assert.strictEqual(result.value.concepts, raw.concepts);
  assert.strictEqual(result.value.relations[1], raw.relations[1]);
});

void test('leaves a correctly directed containment edge unchanged', () => {
  const raw = { concepts: concepts(), relations: [{ from: 'root', to: 'child', label: '包含' }] };
  const result = normalizeContainmentDirection(raw);
  assert.equal(result.correctedEdges, 0);
  assert.strictEqual(result.value, raw);
});

void test('leaves unverifiable, cyclic, duplicate, self, and non-containment edges untouched', () => {
  const cases: Array<[string, unknown]> = [
    [
      'unknown endpoint',
      { concepts: concepts(), relations: [{ from: 'missing', to: 'root', label: '包含' }] },
    ],
    [
      'non-adjacent parent map',
      {
        concepts: concepts().map((concept) =>
          concept.id === 'child' ? { ...concept, parentId: 'other' } : concept,
        ),
        relations: [{ from: 'child', to: 'root', label: '包含' }],
      },
    ],
    [
      'self edge',
      { concepts: [{ ...concepts()[0], parentId: 'root' }], relations: [{ from: 'root', to: 'root', label: '包含' }] },
    ],
    [
      'two-node cycle',
      {
        concepts: [
          { id: 'a', parentId: 'b', label: 'A', description: '', sources: [] },
          { id: 'b', parentId: 'a', label: 'B', description: '', sources: [] },
        ],
        relations: [{ from: 'a', to: 'b', label: '包含' }],
      },
    ],
    [
      'duplicate id',
      {
        concepts: [
          ...concepts(),
          { id: 'child', parentId: 'root', label: '重复子', description: '', sources: [] },
        ],
        relations: [{ from: 'child', to: 'root', label: '包含' }],
      },
    ],
    [
      'other relation label',
      { concepts: concepts(), relations: [{ from: 'child', to: 'root', label: '关联' }] },
    ],
  ];

  for (const [name, raw] of cases) {
    const before = structuredClone(raw);
    const result = normalizeContainmentDirection(raw);
    assert.equal(result.correctedEdges, 0, name);
    assert.strictEqual(result.value, raw, name);
    assert.deepEqual(raw, before, name);
  }
});

void test('does not mutate or reshape arbitrary invalid inputs', () => {
  const invalid: unknown[] = [
    null,
    undefined,
    'not an object',
    42,
    [],
    {},
    { concepts: {}, relations: [] },
    { concepts: [], relations: {} },
    { concepts: [], relations: null },
  ];

  for (const raw of invalid) {
    const result = normalizeContainmentDirection(raw);
    assert.equal(result.correctedEdges, 0);
    assert.strictEqual(result.value, raw);
  }
});
