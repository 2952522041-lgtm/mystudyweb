import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { MATH_FALLBACK, prepareOutputMarkdown, repairCrossParagraphMath } from '../lib/output-markdown.ts';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const bundle = await build({stdin:{contents:`
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { MarkdownOutput } from '@/components/markdown-output';
  import { TranslationParagraphs } from '@/components/translation-paragraphs';
  export const render = (text) => renderToStaticMarkup(<MarkdownOutput onNavigate={() => {}}>{text}</MarkdownOutput>);
  export const translation = (paragraphs) => renderToStaticMarkup(<TranslationParagraphs paragraphs={paragraphs} />);
`,loader:'tsx',resolveDir:root},alias:{'@':root},bundle:true,format:'cjs',platform:'node',plugins:[{name:'external-react',setup(build){build.onResolve({filter:/^react(?:\/jsx-runtime|-dom\/server)?$/},(args)=>({path:require.resolve(args.path),external:true}));}}],write:false,logLevel:'silent'});
const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-markdown-'));
let renderer: {render: (text:string) => string; translation: (paragraphs:string[]) => string};
try {
  const file = path.join(directory, 'render.cjs');
  await writeFile(file, bundle.outputFiles[0].text);
  renderer = require(file);
} finally { await rm(directory, {recursive:true,force:true}); }
const {render,translation} = renderer;

void test('translation and answers share actual Markdown, GFM and KaTeX rendering', () => {
  const text = '**重点** $x^2$ H_2O α β γ θ μ Ω ≈ ≤ ≥ ± × ÷ → ∑ ∫ ∂ m/s² N·m ℃ - – —\n\n|A|B|\n|-|-|\n|1|2|';
  const answer = render(text);
  const translated = translation([text]);
  assert.ok(translated.includes(answer));
  assert.match(answer, /<strong>重点<\/strong>/);
  assert.match(answer, /<table>/);
  assert.match(answer, /class="katex"/);
  assert.match(answer, /<msup>/);
  assert.match(answer, /<msub>/);
  assert.ok(answer.includes('α β γ θ μ Ω ≈ ≤ ≥ ± × ÷ → ∑ ∫ ∂ m/s² N·m ℃ - – —'));
});

void test('block equations, nested matrices and math code fences render without raw fallback', () => {
  const formula = String.raw`\begin{aligned}A&=\begin{pmatrix}1&2\\3&4\end{pmatrix}\\x&=2\end{aligned}`;
  for (const text of [formula, `$$\n${formula}\n$$`, '```latex\n'+formula+'\n```', '```\n$$x^2$$\n```', String.raw`\[x^2\]`, String.raw`\(x^2\)`, String.raw`$\ce{2H2 + O2 -> 2H2O}$`]) {
    const html = render(text);
    assert.match(html, /class="katex"/);
    assert.doesNotMatch(html, /katex-error|<pre>|math-fallback/);
  }
});

void test('malformed and incomplete formulas degrade to guidance without exposing TeX or error titles', () => {
  for (const formula of [String.raw`$\notARealCommand{x}$`, String.raw`$$\frac{a`, String.raw`\begin{matrix}1 & 2`, String.raw`$\frac{a`]) {
    const html = render(formula);
    assert.ok(html.includes(MATH_FALLBACK), `${formula}: ${html}`);
    assert.doesNotMatch(html, /notARealCommand|\\frac|\\begin|title=|katex-error/);
  }
});

void test('ordinary fenced and inline code survive while unsafe HTML and math URLs remain inert', () => {
  const html = render('```python\nx = "$value$"\n```\n\n`H_2O`\n\n<script>alert(1)</script>\n\n$\\href{javascript:alert(1)}{x}$');
  assert.match(html, /<pre><code class="language-python">/);
  assert.match(html, /<code>H_2O<\/code>/);
  assert.doesNotMatch(html, /<script>|href="javascript:/);
  assert.match(render('[page](#page=2)'), /<button/);
  assert.match(render('[source](https://example.test)'), /rel="noreferrer noopener"/);
});

void test('legacy formulas spanning cached paragraphs are repaired without changing A2 indices', () => {
  const paragraphs = ['Before $$\\begin{matrix}1 & 2', '3 & 4\\end{matrix}$$ after', 'last $x$'];
  const repaired = repairCrossParagraphMath(paragraphs);
  assert.equal(repaired.length, 3);
  assert.match(repaired[0], /1 & 2\n\n3 & 4/);
  assert.equal(repaired[1], ' after');
  assert.equal(paragraphs[1], '3 & 4\\end{matrix}$$ after');
  const html = translation(paragraphs);
  assert.equal((html.match(/data-paragraph-index=/g) ?? []).length, 3);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<p[^>]*><div/);
});

void test('display preparation is stable and leaves escaped prices and code intact', () => {
  const source = 'Price \\$5 and `x^2`.';
  assert.equal(prepareOutputMarkdown(source), source);
  const once = prepareOutputMarkdown('Before $$x^2$$ after');
  assert.equal(prepareOutputMarkdown(once).trim(), once.trim());
});
