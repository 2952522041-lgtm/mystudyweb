import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLecture, lectureReply, mockProvider } from './fixtures/mindmap-hierarchy.ts';
import { emptyCourseKnowledge, mergeDocumentDigest, applyAiCourseKnowledge } from '../lib/knowledge/course-merger.ts';
import { buildMindmapLayout, computeMindmapGeometry, type MindmapLayout } from '../lib/knowledge/mindmap-layout.ts';
import { inspectHierarchy, MINDMAP_MAX_CHILDREN } from '../lib/knowledge/mindmap-structure.ts';
import { describeKnowledgeError, knowledgeDigestCacheKey, KNOWLEDGE_PROVIDER_ID, KNOWLEDGE_DIGEST_PROMPT_VERSION } from '../lib/knowledge/ai-knowledge-provider.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';
import type { DocumentDigest } from '../lib/course-storage/types.ts';
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

void test('hierarchical lecture: flat digest/course outputs are repaired before layout and all relations survive', async () => {
  const input = await extractLecture();
  assert.match(input.pages.join('\n'), /1\.1 电阻电路/);
  const flat = lectureReply(input.documentId, false);
  const reply = lectureReply(input.documentId, true);
  reply.relations.push({from:'c2',to:'c7',label:'对比'}, {from:'c3',to:'c4',label:'依赖'}, {from:'c7',to:'c8',label:'导致'});
  const asCourse = (data: typeof reply) => ({...data,theme:data.overview,conflicts:[]});
  const {provider,requests} = mockProvider([reply, flat, reply, asCourse(flat), asCourse(reply)]);
  const digest = await provider.analyzeDocument(input);
  const pdf = mergeDocumentDigest(emptyCourseKnowledge('pdf',digest.title),digest);
  const ai = await provider.synthesizeCourseKnowledge({courseId:'course',courseName:'电路',digests:[digest]});
  const course = applyAiCourseKnowledge(emptyCourseKnowledge('course','电路'),ai);
  assert.equal(requests.length,5);
  assert.match(requests[2].messages.at(-1)!.content, /最大深度 1 < 3/);
  assert.match(requests[4].messages.at(-1)!.content, /最大深度 1 < 3/);
  const coursePrompt = requests[3].messages[1].content;
  assert.ok(coursePrompt.includes(digest.concepts[1].id));
  assert.match(coursePrompt, /parentId[\s\S]*relations|relations[\s\S]*parentId/);
  for (const [name,knowledge] of [['PDF',pdf],['course',course]] as const) {
    const layout = buildMindmapLayout(knowledge.nodes,knowledge.relations);
    assert.deepEqual(printTree(`repaired ${name}`,layout),[1,2,2,4]);
    const stats = inspectHierarchy(knowledge.nodes.filter(n => n.kind !== 'course'));
    assert.equal(stats.maxDepth,3);
    assert.ok(stats.maxChildren <= MINDMAP_MAX_CHILDREN);
    assert.equal(stats.orphans.length,0);
    assert.equal(stats.missingSources.length,0);
    for (const node of layout.nodes.filter(n => !layout.nodes.some(child => child.parentId === n.id))) {
      assert.ok(node.sources.every(source => source.documentId === input.documentId && source.fileName === input.fileName && source.pageStart >= 1));
      assert.ok(node.sources.length);
    }
    assert.equal(computeMindmapGeometry(layout).positions.size,9);
    assert.equal(layout.nodes.find(n => n.label === '电容定义 Q=CU')?.depth,3, 'cross link must not steal this child');
    for (const label of ['依赖','对比','导致']) assert.ok(layout.edges.some(e => e.label === label && e.cross));
    const svg = renderKnowledgeSvg({name:'电路'} as never,knowledge);
    for (const label of ['包含','依赖','对比','导致','欧姆定律']) assert.ok(svg.includes(label));
    const oldProjection = knowledge.nodes.map(({parentId: _parent,...node}) => node);
    const ambiguous = buildMindmapLayout(oldProjection,knowledge.relations);
    console.log(`legacy BFS with cross-links ${name}:`, ambiguous.nodes.filter(n => ['电容定义 Q=CU','储能 W=CU²/2'].includes(n.label)).map(n => ({label:n.label,depth:n.depth,parent:ambiguous.nodes.find(p => p.id===n.parentId)?.label})));
    assert.notEqual(ambiguous.nodes.find(n => n.label === '电容定义 Q=CU')?.parentId,layout.nodes.find(n => n.label === '电容定义 Q=CU')?.parentId);
    // Reading an old flat artifact remains safe; its known limitation stays visible.
    const legacy = {...knowledge,nodes:knowledge.nodes.map(({parentId: _parent,...node}) => node),relations:[]};
    assert.deepEqual(printTree(`legacy ${name}`,buildMindmapLayout(legacy.nodes,legacy.relations)),[1,8]);
  }
});

void test('genuinely flat single-topic material stays shallow without invented branches', async () => {
  const input = await extractLecture();
  const raw = lectureReply(input.documentId,false);
  raw.title = '单主题测量短文';
  raw.overview = '仅测量电压、电流得到欧姆定律 U=IR。';
  raw.hierarchy = {mode:'flat',reason:'仅一个欧姆定律结论，没有章/节或从属论点'};
  raw.concepts = raw.concepts.slice(2,3);
  raw.sections = [{title:"欧姆定律",summary:"唯一测量结论 U=IR",pageStart:1,pageEnd:1}];
  const {provider,requests} = mockProvider([raw,raw,{...raw,theme:raw.overview,conflicts:[]}]);
  const digest = await provider.analyzeDocument({...input,pages:['单主题短文：仅测量电压电流得到欧姆定律 U=IR。']});
  const ai = await provider.synthesizeCourseKnowledge({courseId:'flat',courseName:'短文',digests:[digest]});
  assert.equal(requests.length,3);
  assert.equal(digest.concepts.length,1);
  assert.equal(inspectHierarchy(digest.concepts).maxDepth,1);
  assert.equal(inspectHierarchy(ai.nodes).maxDepth,1);
});

const invalidCases: Array<[string,(raw: ReturnType<typeof lectureReply>) => void,RegExp]> = [
  ['too many root children', raw => { raw.concepts = Array.from({length:10},(_,i) => ({...raw.concepts[0],id:`x${i}`,label:`章${i}`,parentId:null})); raw.relations=[]; }, /主题根.*10.*超过 9/],
  ['too many children on one branch', raw => { raw.concepts.push(...Array.from({length:8},(_,i) => ({...raw.concepts[2],id:`x${i}`,label:`要点${i}`,parentId:'c2'}))); }, /节点 c2.*10.*超过 9/],
  ['too deep', raw => {raw.concepts[3].parentId='c3';raw.relations=raw.relations.filter(r => r.to !== 'c4');}, /最大深度 4 > 3/],
  ['orphan', raw => {raw.concepts[3].parentId='unknown';}, /孤立节点/],
  ['cycle', raw => {raw.concepts[0].parentId='c3';}, /父子循环/],
  ['missing source', raw => {raw.concepts[3].sources=[];}, /缺少 sources/],
  ['missing parent', raw => {delete (raw.concepts[3] as {parentId?:unknown}).parentId;}, /parentId/],
  ['unknown relation endpoint', raw => {raw.relations.push({from:'missing',to:'c2',label:'依赖'});}, /关系端点无效/],
  ['conflicting containment', raw => {raw.relations.push({from:'c1',to:'c7',label:'包含'});}, /与 parentId 不一致/],
  ['false flat claim', raw => {raw.hierarchy.mode='flat';}, /不能声明 flat/],
  ['duplicate ID', raw => {raw.concepts[3].id='c3';}, /id 重复/],
];
for (const [name,mutate,pattern] of invalidCases) void test(`hierarchy recovery preserves facts or rejects unsafe output: ${name}`, async () => {
  const input = await extractLecture();
  const raw = lectureReply(input.documentId,true);
  mutate(raw);
  const {provider,store,requests} = mockProvider([lectureReply(input.documentId,true),raw,raw]);
  if (name === 'too many children on one branch' || name === 'too deep') {
    const digest = await provider.analyzeDocument(input);
    assert.equal(requests.length, 2, 'safe ancestor promotion must avoid another AI request');
    assert.equal(digest.concepts.length, raw.concepts.length);
    assert.deepEqual(digest.concepts.map(node => node.description), raw.concepts.map(node => node.description));
    assert.deepEqual(digest.concepts.map(node => node.sources.map(source => source.pageStart)), raw.concepts.map(node => node.sources.map(source => source.pageStart)));
    const shape = inspectHierarchy(digest.concepts);
    assert.equal(shape.maxDepth, 3);
    assert.ok(shape.maxChildren <= 9);
    assert.ok(digest.relations.some(relation => relation.label === '组成'));
    assert.ok(digest.diagnostics?.some(diagnostic => diagnostic.action === 'quality-restored' && diagnostic.detail.includes('已有祖先')));
    return;
  }
  await assert.rejects(provider.analyzeDocument(input), (error: unknown) => {
    const message = describeKnowledgeError(error);
    assert.match(message,pattern);
    assert.match(message,/已自动重试一次仍失败.*未保存/);
    return true;
  });
  assert.equal(requests.length,3);
  assert.match(requests[2].messages.at(-1)!.content,pattern);
  assert.equal((await store.keys()).length,0);
});

void test('course structure validation retries and surfaces failure without replacing a previous course', async () => {
  const input = await extractLecture();
  const raw = lectureReply(input.documentId,true);
  const {provider} = mockProvider([raw,raw]);
  const digest = await provider.analyzeDocument(input);
  const bad = {...lectureReply(input.documentId,false),theme:'电路',conflicts:[]};
  const courseMock = mockProvider([bad,bad]);
  const previous = emptyCourseKnowledge('c','电路');
  const before = JSON.stringify(previous);
  await assert.rejects(courseMock.provider.synthesizeCourseKnowledge({courseId:'c',courseName:'电路',digests:[digest]}), /最大深度 1 < 3.*未保存/);
  assert.equal(courseMock.requests.length,2);
  assert.equal(JSON.stringify(previous),before);
});

void test('prompt/schema versions isolate old cache; old payload even under new key is regenerated', async () => {
  const input = await extractLecture();
  const raw = lectureReply(input.documentId,true);
  const seed = mockProvider([raw,raw]);
  const good = await seed.provider.analyzeDocument(input);
  const old: DocumentDigest = {...good,schemaVersion:2,promptVersion:'ai-digest-v3',concepts:good.concepts.map(({parentId: _parent,...node}) => node)};
  const store = createMemoryStore<DocumentDigest>();
  const parts = {fingerprint:input.fingerprint,provider:KNOWLEDGE_PROVIDER_ID,model:good.model!,promptVersion:KNOWLEDGE_DIGEST_PROMPT_VERSION,schemaVersion:3};
  const newKey = knowledgeDigestCacheKey(parts);
  const oldKey = knowledgeDigestCacheKey({...parts,promptVersion:'ai-digest-v3',schemaVersion:2});
  assert.notEqual(newKey,oldKey);
  await store.set(oldKey,old);
  await store.set(newKey,old); // defensive metadata verification, independent of key correctness
  const {provider,requests} = mockProvider([raw,raw],store);
  assert.equal((await provider.analyzeDocument(input)).schemaVersion,3);
  assert.equal(requests.length,2);
  await provider.analyzeDocument(input);
  assert.equal(requests.length,2);
  assert.deepEqual(await store.get(oldKey),old);
});

void test('reordered model IDs preserve parents through normalization and stable course ID remapping', async () => {
  const input = await extractLecture();
  const raw = lectureReply(input.documentId,true);
  raw.concepts.reverse();
  const courseRaw = {...raw,theme:raw.overview,conflicts:[],concepts:raw.concepts.map(node => ({...node,id:node.id.replace('c','k'),parentId:node.parentId?.replace('c','k') ?? null})),relations:raw.relations.map(r => ({...r,from:r.from.replace('c','k'),to:r.to.replace('c','k')}))};
  const {provider} = mockProvider([raw,raw,courseRaw]);
  const digest = await provider.analyzeDocument(input);
  assert.deepEqual(inspectHierarchy(digest.concepts).levels,[1,2,2,4]);
  const ai = await provider.synthesizeCourseKnowledge({courseId:'c',courseName:'电路',digests:[digest]});
  const previous = mergeDocumentDigest(emptyCourseKnowledge('c','电路'),digest);
  const next = applyAiCourseKnowledge(previous,ai);
  assert.deepEqual(inspectHierarchy(next.nodes.filter(n => n.kind !== 'course')).levels,[1,2,2,4]);
  for (const node of next.nodes) assert.equal(node.id,previous.nodes.find(old => old.label === node.label)?.id);
  const point = next.nodes.find(n => n.label === '欧姆定律 U=IR')!;
  assert.equal(next.nodes.find(n => n.id === point.parentId)?.label,'电阻电路');
});

void test('removing a source document repairs surviving parent references without losing sources', async () => {
  const {removeDocumentContribution} = await import('../lib/knowledge/course-merger.ts');
  const knowledge = emptyCourseKnowledge('c','电路');
  knowledge.nodes.push(
    {id:'parent',parentId:null,label:'章',description:'章',kind:'concept',ownership:'generated',sources:[{documentId:'removed',fileName:'a.pdf',pageStart:1,type:'pdf'}]},
    {id:'child',parentId:'parent',label:'要点',description:'要点',kind:'concept',ownership:'generated',sources:[{documentId:'kept',fileName:'b.pdf',pageStart:1,type:'pdf'}]},
  );
  knowledge.relations.push({from:'parent',to:'child',label:'包含'});
  const next = removeDocumentContribution(knowledge,'removed');
  assert.equal(next.nodes.find(n => n.id === 'child')?.parentId,null);
  assert.equal(next.nodes.find(n => n.id === 'child')?.sources[0].documentId,'kept');
  assert.equal(inspectHierarchy(next.nodes.filter(n => n.kind !== 'course')).orphans.length,0);
  assert.equal(knowledge.nodes.find(n => n.id === 'child')?.parentId,'parent');
});

void test('repairs the screenshot shape (15 children, depth 2) without regenerating scientific prose', async () => {
  const input = await extractLecture();
  const draft = lectureReply(input.documentId, true);
  const origin = draft.concepts[0].sources;
  draft.sections[0].summary += '\n$$U = IR$$\n| R | U |\n| --- | --- |\n| 1 | 2 |';
  draft.concepts = [
    ...Array.from({ length: 15 }, (_, i) => ({ id: `p${i}`, parentId: null,
      label: `原文要点${i}`, description: `保留定义和公式 ${i}`, sources: origin })),
    { id: 'leaf', parentId: 'p0', label: '要点的适用条件', description: '原有条件', sources: origin },
  ];
  draft.relations = [{ from: 'p0', to: 'p1', label: '依赖' }];
  const repair = {
    hierarchy: draft.hierarchy,
    concepts: [
      ...draft.concepts.map((node, index) => ({ ...node,
        // Corrupt returned prose deliberately: the application must retain the original.
        description: '不应覆盖已有解释',
        sources: [{ ...origin[0], pageStart: 999 }],
        parentId: node.id === 'leaf' ? 'p0' : index < 8 ? 'section-a' : 'section-b' })),
      { id: 'section-a', parentId: null, label: '电阻电路', description: '原文小节', sources: origin },
      { id: 'section-b', parentId: null, label: '电容储能', description: '原文小节', sources: draft.sections.slice(1).map(section => ({ ...origin[0], pageStart: section.pageStart })) },
    ],
    relations: [],
  };
  const { provider, requests } = mockProvider([lectureReply(input.documentId, true), draft, repair]);
  const digest = await provider.analyzeDocument(input);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].messages.length, 2);
  assert.match(requests[2].messages[1].content, /仅修复以下脑图结构/);
  assert.match(requests[2].messages[1].content, /节点 主题根 有 15 个子节点/);
  assert.match(requests[2].messages[1].content, /最大深度 2 < 3/);
  assert.ok(requests[2].messages[1].content.includes('"parentId":null'));
  assert.equal(inspectHierarchy(digest.concepts).maxDepth, 3);
  assert.ok(inspectHierarchy(digest.concepts).maxChildren <= 9);
  assert.equal(digest.concepts.length, 18);
  assert.equal(digest.concepts.find(node => node.label === '原文要点0')?.description, '保留定义和公式 0');
  assert.equal(digest.sections[0].summary, draft.sections[0].summary);
  assert.deepEqual(digest.concepts.find(node => node.label === '原文要点0')?.sources, [{ ...origin[0], pageEnd: origin[0].pageStart, type: 'pdf' }]);
  assert.ok(digest.relations.some(relation => relation.label === '依赖'));
});

void test('structure-only repair cannot discard existing concepts', async () => {
  const input = await extractLecture();
  const draft = lectureReply(input.documentId, false);
  const repair = lectureReply(input.documentId, true);
  repair.concepts = repair.concepts.slice(0, 4);
  const { provider, store } = mockProvider([draft, draft, repair]);
  await assert.rejects(provider.analyzeDocument(input), /遗漏已有节点/);
  assert.equal((await store.keys()).length, 0);
});

void test('repairs duplicate labels locally while retaining their distinct evidence', async () => {
  const input = await extractLecture();
  const draft = lectureReply(input.documentId, true);
  draft.concepts[3].label = draft.concepts[2].label;
  const originalLabel = draft.concepts[2].label;
  const {provider,requests} = mockProvider([lectureReply(input.documentId, true), draft]);
  const digest = await provider.analyzeDocument(input);
  assert.equal(requests.length, 2, 'a duplicate name alone must not require another model request');
  assert.equal(digest.concepts.length, draft.concepts.length);
  for (const index of [2,3]) {
    const node = digest.concepts[index];
    assert.equal(node.description, draft.concepts[index].description);
    assert.equal(node.sources[0].pageStart, draft.concepts[index].sources[0].pageStart);
    assert.ok(node.label.startsWith(originalLabel));
  }
  assert.notEqual(digest.concepts[2].label, digest.concepts[3].label);
  assert.equal(inspectHierarchy(digest.concepts).maxDepth, 3);
});

void test('branch scaffolds derive sources from assigned original subtrees and preserve their hierarchy', async () => {
  const input=await extractLecture();
  const draft=lectureReply(input.documentId,true);
  draft.concepts = draft.concepts.map(node => ({...node,parentId:['c3','c7'].includes(node.id)?node.parentId:null}));
  // Root capacity failure cannot be fixed by moving nodes to unrelated parents.
  draft.concepts.push(...Array.from({length:8},(_,index)=>({...draft.concepts[0],id:`extra${index}`,label:`材料主题${index}`,parentId:null})));
  const branches=[{id:'group-a',parentId:null,label:'电路基础',description:'',sourceIds:[]},
    {id:'group-b',parentId:null,label:'其他材料主题',description:'',sourceIds:[]}];
  const assignments=[...branches.map(({id,parentId,label})=>({id,parentId,label})),...draft.concepts.map(node=>({id:node.id,
    parentId: node.id.startsWith('extra') ? 'group-b' : 'group-a'}))];
  const {provider,requests}=mockProvider([lectureReply(input.documentId,true),draft,{hierarchy:draft.hierarchy,assignments,branches}]);
  const digest=await provider.analyzeDocument(input);
  assert.equal(requests.length,3);
  assert.equal(digest.concepts.length,draft.concepts.length+2);
  assert.ok(digest.concepts.every(node=>node.sources.length));
  assert.ok(digest.concepts.some(node=>node.label==='电路基础（主题）'));
  assert.deepEqual(digest.concepts.slice(0,draft.concepts.length).map(node=>node.description),draft.concepts.map(node=>node.description));
});
