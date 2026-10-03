import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const {splitSummaryParagraphs:split,compareSummaryParagraphs:diff,MAX_DIFF_CELLS}=await import(pathToFileURL(path.join(process.env.TASK_ROOT,'lib/summary-diff.ts')));
const kinds=result=>result.segments.map(s=>`${s.kind}:${s.text}`);
const join=blocks=>blocks.join('\n\n');

test('normalization, whitespace-only separators and preserved interior whitespace',()=>{
 assert.deepEqual(split('\r\n\t\n  一\r二  \r\n \t\r\n三\r\n\r\n'),['一\n二','三']);
 assert.deepEqual(split('a  b\n c\n\nnext'),['a  b\n c','next']);
});
test('backtick code keeps blank lines and a short or wrong closer is not a close',()=>{
 const code='````ts\nconst x=1;\n\n```\n\n~~~\n\n````';
 assert.deepEqual(split(`A\n\n${code}\n\nB`),['A',code,'B']);
});
test('tilde fence with three-space indentation and longer closer',()=>{
 const code='   ~~~text\nx\n\n  y\n   ~~~~~  ';
 assert.deepEqual(split(`${code}\n\nZ`),[code.trim(),'Z']);
});
test('fence must close with whitespace only and code/math state cannot leak',()=>{
 const code='```js\n$$\n\n``` text\n\nend\n```';
 assert.deepEqual(split(`${code}\n\nZ`),[code,'Z']);
 const math='$$\n```\n\nx = y\n$$';
 assert.deepEqual(split(`${math}\n\nZ`),[math,'Z']);
});
test('unclosed code and math keep paragraphs through EOF',()=>{
 for(const body of ['~~~\nA\n\nB','$$\nA\n\nB'])assert.deepEqual(split(body),[body]);
});
test('fences without blank boundaries stay inside the surrounding paragraph',()=>{
 const body='Intro\n```\na\n\nb\n```\nTail';assert.deepEqual(split(`${body}\n\nNext`),[body,'Next']);
});
test('invalid backtick info and 4-space-indented fences do not open fences',()=>{
 assert.deepEqual(split('```bad`info\nA\n\nB'),['```bad`info\nA','B']);
 assert.deepEqual(split('    ```\nA\n\nB'),['```\nA','B']);
});
test('empty, insertion and removal counts are honest',()=>{
 assert.deepEqual(diff('',''),{segments:[],added:0,removed:0,unchanged:0,coarse:false});
 assert.deepEqual(kinds(diff('','A\n\nB')),['added:A','added:B']);
 assert.deepEqual(kinds(diff('A\n\nB','')),['removed:A','removed:B']);
});
test('replacement and deterministic tie removal preserve order',()=>{
 assert.deepEqual(kinds(diff('A\n\nB','B\n\nA')),['removed:A','equal:B','added:A']);
 assert.deepEqual(kinds(diff('P\n\nold\n\nS','P\n\nnew\n\nS')),['equal:P','removed:old','added:new','equal:S']);
});
test('repeated paragraphs are never deduplicated',()=>{
 assert.deepEqual(kinds(diff('A\n\nA\n\nB','A\n\nB\n\nB')),['equal:A','removed:A','added:B','equal:B']);
});
test('coarse fallback retains shared ends and every middle paragraph',()=>{
 assert.equal(MAX_DIFF_CELLS,40000);
 const a=Array.from({length:201},(_,i)=>`old${i}`),b=Array.from({length:201},(_,i)=>`new${i}`);
 const r=diff(join(['P',...a,'S']),join(['P',...b,'S']));
 assert.equal(r.coarse,true);assert.equal(r.unchanged,2);assert.equal(r.added,201);assert.equal(r.removed,201);
 assert.deepEqual(r.segments.filter(s=>s.kind!=='added').map(s=>s.text),['P',...a,'S']);
 assert.deepEqual(r.segments.filter(s=>s.kind!=='removed').map(s=>s.text),['P',...b,'S']);
});
test('exact budget is precise and prefix/suffix are stripped before budgeting',()=>{
 const a=Array.from({length:200},(_,i)=>`a${i}`),b=Array.from({length:200},(_,i)=>`b${i}`);
 assert.equal(diff(join(a),join(b)).coarse,false);
 const common=Array.from({length:1000},(_,i)=>`shared${i}`);
 assert.equal(diff(join([...common,'old']),join([...common,'new'])).coarse,false);
 assert.equal(diff(join(['old',...common]),join(['new',...common])).coarse,false);
});
test('large identical input stays exact without quadratic work',{timeout:3000},()=>{
 const text=join(Array.from({length:5000},(_,i)=>`paragraph${i}`));const r=diff(text,text);
 assert.equal(r.coarse,false);assert.equal(r.unchanged,5000);assert.equal(r.added+r.removed,0);
});
test('deterministic generated cases reconstruct both inputs and achieve optimal LCS',()=>{
 let seed=17;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let sample=0;sample<160;sample++){
  const a=Array.from({length:rand()%13},()=>`block-${rand()%5}`),b=Array.from({length:rand()%13},()=>`block-${rand()%5}`);
  const r=diff(join(a),join(b));
  assert.deepEqual(r.segments.filter(s=>s.kind!=='added').map(s=>s.text),a);
  assert.deepEqual(r.segments.filter(s=>s.kind!=='removed').map(s=>s.text),b);
  let prev=new Array(b.length+1).fill(0);
  for(const x of a){const next=[0];for(let j=0;j<b.length;j++)next[j+1]=x===b[j]?prev[j]+1:Math.max(prev[j+1],next[j]);prev=next;}
  assert.equal(r.unchanged,prev[b.length]);assert.equal(r.added,b.length-r.unchanged);assert.equal(r.removed,a.length-r.unchanged);
  assert.deepEqual(diff(join(a),join(b)),r);
 }
});
