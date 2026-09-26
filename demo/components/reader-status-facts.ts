import { createElement } from 'react';

/** Read-only facts shared by browser and desktop reader footers. */
export function ReaderStatusFacts({ parts }: { parts: string[] }) {
  return createElement(
    'div',
    { className: 'flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums', 'aria-label': '阅读状态' },
    parts.map((part) => createElement('span', { key: part }, part)),
  );
}
