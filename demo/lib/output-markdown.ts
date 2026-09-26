import katex from 'katex';
import 'katex/contrib/mhchem';
import { mathSpans } from './scientific-text.ts';

export const OUTPUT_KATEX_OPTIONS = { trust: false, strict: 'ignore' as const, maxExpand: 1000 };

export const MATH_FALLBACK = '【公式暂无法显示，请对照 PDF 原文；AI 答疑可重试生成】';

/** Display-only repair. Cached/source strings are never rewritten. */
export function prepareOutputMarkdown(input: string): string {
  // Only math-labelled fences (or an unlabelled fence containing only math)
  // are unwrapped. Programming examples must remain code.
  const fenced = input.replace(/```([^\n`]*)\n([\s\S]*?)\n```/g, (whole, language: string, body: string) => {
    const value = body.trim();
    const spans = mathSpans(value);
    const onlyMath = spans.length === 1 && spans[0].start === 0 && spans[0].end === value.length;
    if (/^(?:math|latex|tex)$/i.test(language.trim())) return onlyMath ? value : `$$\n${value}\n$$`;
    return !language.trim() && onlyMath ? value : whole;
  });
  // Shield remaining code spans/fences before looking for TeX delimiters.
  const code: string[] = [];
  let prefix = 'YYCODE';
  while (fenced.includes(prefix)) prefix += 'X';
  const shielded = fenced.replace(/```[^\n]*\n[\s\S]*?(?:```|$)|`+[^`\n]+`+/g, (value) => `${prefix}${code.push(value) - 1}ZZ`);
  const prose = (value: string) => value.replace(/\b[A-Za-z][A-Za-z0-9]*(?:[_^](?:\{[^{}\n]+\}|\d+))+[A-Za-z0-9]*\b/g, (notation) => `$${notation}$`);
  let result = '';
  let cursor = 0;
  for (const span of mathSpans(shielded)) {
    result += prose(shielded.slice(cursor, span.start));
    const body = span.body.trim().replace(/\n\s*\n/g, '\n');
    try {
      if (!span.closed) throw new Error('incomplete math');
      // rehype-katex retries parse errors with throwOnError:false, which can
      // leak unknown commands as red text. Validate before that fallback.
      katex.renderToString(body, { ...OUTPUT_KATEX_OPTIONS, displayMode: span.display, throwOnError: true });
      result += span.display ? `\n\n$$\n${body}\n$$\n\n` : `$${body.replace(/\s*\n\s*/g, ' ')}$`;
    } catch { result += MATH_FALLBACK; }
    cursor = span.end;
  }
  result += prose(shielded.slice(cursor));
  // A streaming/unbalanced inline command should not expose raw TeX.
  result = result.replace(/\$(\\[A-Za-z]+[^$]*$)/g, MATH_FALLBACK);
  return result.replace(/\n{3,}/g, '\n\n').replace(new RegExp(`${prefix}(\\d+)ZZ`, 'g'), (_whole, index: string) => code[Number(index)]);
}

/** Repair legacy arrays that split a single formula across paragraph entries.
 * Keep array indices/count intact for A2; place the intact formula at its start.
 */
export function repairCrossParagraphMath(paragraphs: string[]): string[] {
  const joined = paragraphs.join('\n\n');
  const starts: number[] = [];
  let offset = 0;
  for (const paragraph of paragraphs) { starts.push(offset); offset += paragraph.length + 2; }
  const result = [...paragraphs];
  for (const span of mathSpans(joined).reverse()) {
    const first = starts.findLastIndex((start) => start <= span.start);
    const last = starts.findLastIndex((start) => start < span.end);
    if (first === last) continue;
    for (let index = first; index <= last; index++) {
      const from = Math.max(0, span.start - starts[index]);
      const to = Math.min(paragraphs[index].length, span.end - starts[index]);
      result[index] = result[index].slice(0, from) + (index === first ? span.value : '') + result[index].slice(to);
    }
  }
  return result;
}

interface HtmlNode { type: string; tagName?: string; properties?: Record<string, unknown>; value?: string; children?: HtmlNode[] }

/** rehype-katex otherwise displays invalid TeX with its source in a title. */
export function rehypeMathFallback() {
  return (tree: HtmlNode) => {
    const visit = (node: HtmlNode) => {
      const classes = node.properties?.className;
      if (Array.isArray(classes) && classes.includes('katex-error')) {
        node.tagName = 'span';
        node.properties = { className: ['math-fallback'], role: 'note' };
        node.children = [{ type: 'text', value: MATH_FALLBACK }];
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
