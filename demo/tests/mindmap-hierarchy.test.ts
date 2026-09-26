import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLecture, lectureReply, mockProvider } from './fixtures/mindmap-hierarchy.ts';
import { emptyCourseKnowledge, mergeDocumentDigest, applyAiCourseKnowledge } from '../lib/knowledge/course-merger.ts';
import { buildMindmapLayout, computeMindmapGeometry, type MindmapLayout } from '../lib/knowledge/mindmap-layout.ts';
import { renderKnowledgeSvg } from '../lib/knowledge/artifact-renderer.ts';

function printTree(name: string, layout: MindmapLayout) {
  const levels: number[] = [];
  for (const node of layout.nodes) levels[node.depth] = (levels[node.depth] ?? 0) + 1;
  const visit = (id: string | null): string[] => layout.nodes.filter(n => n.parentId === id).flatMap(n => [
    `${'  '.repeat(n.depth)}${n.label}`, ...visit(n.id),
  ]);
  const orphanCount = layout.nodes.filter(n => n.parentId && !layout.nodes.some(p => p.id === n.parentId)).length;
  console.log(`${name}: depth=${levels.length-1}, levels=${JSON.stringify(levels)}, orphans=${orphanCount}\n${visit(null).join('\n')}`);
  return levels;
}

void test('diagnostic: same extracted lecture, flat versus hierarchical mock outputs through digest, course and layout', async () => {
  const input = await extractLecture();
  assert.match(input.pages.join('\n'), /1\.1 电阻电路/);
  for (const hierarchical of [false,true]) {
    const reply = lectureReply(input.documentId, hierarchical);
    const {provider} = mockProvider([reply, reply, {...reply,theme:reply.overview,conflicts:[]}]);
    const digest = await provider.analyzeDocument(input);
    const pdf = mergeDocumentDigest(emptyCourseKnowledge('pdf',digest.title),digest);
    const ai = await provider.synthesizeCourseKnowledge({courseId:'course',courseName:'电路',digests:[digest]});
    const course = applyAiCourseKnowledge(emptyCourseKnowledge('course','电路'),ai);
    for (const [name,knowledge] of [['PDF',pdf],['course',course]] as const) {
      const layout = buildMindmapLayout(knowledge.nodes,knowledge.relations);
      const levels = printTree(`${hierarchical?'hierarchical':'flat'} ${name}`,layout);
      assert.deepEqual(levels,hierarchical?[1,2,2,4]:[1,8]);
      assert.equal(computeMindmapGeometry(layout).positions.size,9);
      assert.match(renderKnowledgeSvg({name:'电路'} as never,knowledge), /欧姆定律/);
    }
  }
});
