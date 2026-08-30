export type TranslationStatus = 'cached' | 'translating' | 'complete' | 'error';

export interface TranslationPage {
  title: string;
  paragraphs: string[];
  quote?: string;
}

export const PAGE_COUNT = 12;
export const ZOOM_STEPS = [75, 85, 95, 110, 125, 150] as const;

export const translations: Record<number, TranslationPage> = {
  1: {
    title: '我们如何学习',
    paragraphs: [
      '学习并不是把事实简单地存放在记忆中，而是不断建立关系、验证理解并修正已有判断。',
      '当阅读环境减少不必要的切换，我们就能把更多注意力留给材料本身。',
    ],
  },
  2: {
    title: '专注与理解',
    paragraphs: [
      '持续的注意力让零散信息逐渐形成结构。阅读者需要在新概念、既有经验与上下文之间来回比较。',
      '好的工具应该保持安静，只在理解遇到阻力时提供恰到好处的帮助。',
    ],
  },
  3: {
    title: '把困难拆成更小的部分',
    paragraphs: [
      '面对复杂材料时，逐页处理比一次理解整章内容更容易。每一页都是一个清晰、可恢复的阅读单元。',
      '当译文与原文始终保持对应，读者可以快速确认含义，又不会失去原有语境。',
    ],
  },
  4: {
    title: '学习是一个持续发生的过程',
    paragraphs: [
      '学习的过程并不总能从外部被看见。它发生在许多微小的时刻——当一个困难的概念开始变得清晰，当两个想法突然建立联系，或是当一个问题逐渐明确。',
      '好的学习环境会为这个过程留出空间。它减少不必要的阻力，让学习者始终贴近正在阅读的材料。',
      '使用另一种语言阅读，会额外增加一层认知负担。好的翻译应该为读者提供支持，同时又不让人离开原文语境。',
    ],
    quote: '“理解在专注、对照与重读中逐渐生长。”',
  },
  5: {
    title: '让反馈紧跟阅读节奏',
    paragraphs: [
      '及时反馈能让读者在疑问还清晰时完成确认。等待过久，会迫使人重新寻找刚才阅读的位置。',
      '因此，系统应优先处理当前页，并在阅读节奏稳定后悄悄准备下一页内容。',
    ],
  },
  6: {
    title: '在原文和解释之间切换',
    paragraphs: [
      '并排阅读保留了原始表达。读者既能快速理解段落大意，也可以随时回到原文确认术语和语气。',
      '这种空间上的对应关系，比在多个窗口之间复制和粘贴更自然。',
    ],
  },
  7: {
    title: '重复阅读带来新的理解',
    paragraphs: [
      '再次访问已经读过的页面时，译文应该立即出现。缓存不仅节省等待时间，也让阅读体验更连贯。',
      '恢复上次的页码和界面比例，可以让用户直接回到尚未完成的思考中。',
    ],
  },
};

export function clampPage(page: number, pageCount = PAGE_COUNT): number {
  return Math.min(Math.max(Math.round(page), 1), pageCount);
}

export function fillColumnPageWidth(
  containerWidth: number,
  zoom = 95,
  gutter = 24,
): number {
  const availableWidth = Math.max(containerWidth - gutter, 0);
  return Math.round(availableWidth * (zoom / 95));
}

export function stepZoom(current: number, direction: -1 | 1): number {
  const nearestIndex = ZOOM_STEPS.reduce((bestIndex, step, index) =>
    Math.abs(step - current) < Math.abs(ZOOM_STEPS[bestIndex] - current)
      ? index
      : bestIndex,
  0);
  const targetIndex = Math.min(
    Math.max(nearestIndex + direction, 0),
    ZOOM_STEPS.length - 1,
  );
  return ZOOM_STEPS[targetIndex];
}

export function nextPageToPrefetch(currentPage: number, pageCount: number): number | null {
  const nextPage = Math.round(currentPage) + 1;
  return nextPage <= pageCount ? nextPage : null;
}

export function getTranslation(page: number): TranslationPage {
  return (
    translations[page] ?? {
      title: `第 ${page} 页译文`,
      paragraphs: [
        '这是用于体验操作流程的模拟译文。实际产品会在用户停留当前页约 300 毫秒后提取文字，并只发送这一页的内容进行翻译。',
        '翻译完成后，本页结果会保存在本地缓存中，再次访问时可以立即显示。',
      ],
    }
  );
}

export function translationCopy(page: TranslationPage): string {
  return [page.title, ...page.paragraphs, page.quote]
    .filter(Boolean)
    .join('\n\n');
}
