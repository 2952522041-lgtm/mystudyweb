import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMindmapLayout } from '../lib/knowledge/mindmap-layout.ts';
import { renderMindmapMarkdown } from '../lib/knowledge/artifact-renderer.ts';
import { emptyCourseKnowledge } from '../lib/knowledge/course-merger.ts';

void test('disconnected concept trees retain hierarchy and collapsed descendants never reattach', () => {
  const knowledge = emptyCourseKnowledge('c', '科学');
  for (const id of ['a', 'b', 'c', 'd'])
    knowledge.nodes.push({
      id,
      label: id,
      description: id,
      kind: 'concept',
      ownership: 'generated',
      sources: [],
    });
  knowledge.relations = [
    { from: 'a', to: 'b', label: '包含' },
    { from: 'b', to: 'c', label: '依赖' },
    { from: 'c', to: 'a', label: '关联' },
  ];
  const full = buildMindmapLayout(knowledge.nodes, knowledge.relations);
  assert.equal(full.nodes.find((node) => node.id === 'b')?.parentId, 'a');
  const folded = buildMindmapLayout(knowledge.nodes, knowledge.relations, {
    collapsedIds: new Set(['a']),
  });
  assert.ok(folded.nodes.some((node) => node.id === 'a'));
  assert.ok(folded.nodes.some((node) => node.id === 'd'));
  assert.ok(!folded.nodes.some((node) => ['b', 'c'].includes(node.id)));
  assert.equal(folded.hiddenCount, 2);
  assert.ok(
    folded.edges.every(
      (edge) =>
        folded.nodes.some((node) => node.id === edge.from) &&
        folded.nodes.some((node) => node.id === edge.to),
    ),
  );
});

void test('dense large graphs have bounded rendering while Markdown exports every node and source', () => {
  const knowledge = emptyCourseKnowledge('c', '科学');
  for (let i = 0; i < 1000; i++)
    knowledge.nodes.push({
      id: `n${i}`,
      label: `节点 ${i}`,
      description: '科学',
      kind: 'concept',
      ownership: 'generated',
      sources: [
        {
          documentId: 'd',
          fileName: '科学.pdf',
          pageStart: i + 1,
          type: 'pdf',
        },
      ],
    });
  knowledge.relations = knowledge.nodes.slice(1, 61).flatMap((node) =>
    knowledge.nodes
      .slice(1, 61)
      .filter((other) => node.id !== other.id)
      .map((other) => ({ from: node.id, to: other.id, label: '关联' })),
  );
  const layout = buildMindmapLayout(knowledge.nodes, knowledge.relations, {
    maxNodes: 60,
    maxDepth: 4,
  });
  assert.ok(layout.nodes.length <= 60);
  assert.ok(layout.edges.length <= 120);
  assert.ok(layout.nodes.every((node) => node.depth <= 4));
  const markdown = renderMindmapMarkdown(knowledge);
  assert.match(markdown, /节点 999/);
  assert.match(markdown, /科学.pdf · 第 1000 页/);
  assert.equal(markdown.match(/- 节点 /g)?.length, 1000);
});
