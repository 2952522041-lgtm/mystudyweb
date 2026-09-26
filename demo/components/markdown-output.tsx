'use client';

import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { OUTPUT_KATEX_OPTIONS, prepareOutputMarkdown, rehypeMathFallback } from '@/lib/output-markdown';

/** Shared by translations and AI answers, including their streaming output. */
export function MarkdownOutput({ children, onNavigate }: { children: string; onNavigate?: (page: number) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, OUTPUT_KATEX_OPTIONS], rehypeMathFallback]}
    components={{
      a: ({ children: linkChildren, node: _node, ...props }) => {
        const match = props.href?.match(/^#page=(\d+)$/);
        if (match && onNavigate) return <button type="button" className="text-violet-700 underline" onClick={() => onNavigate(Number(match[1]))}>{linkChildren}</button>;
        return <a {...props} target="_blank" rel="noreferrer noopener">{linkChildren}</a>;
      },
    }}>
    {prepareOutputMarkdown(children)}
  </ReactMarkdown>;
}
