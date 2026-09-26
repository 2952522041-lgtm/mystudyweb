export function knowledgeStageMessage(
  stage: string,
  detail?: { chunkIndex?: number; chunkCount?: number; identity?: string },
): string {
  if (stage === 'chunk-analysis')
    return `分块层：AI 分析 ${detail?.chunkIndex ?? ''} / ${detail?.chunkCount ?? ''}`;
  if (stage === 'synthesize')
    return `文档层：AI 归并摘要${detail?.identity ? `（${detail.identity}）` : ''}`;
  if (stage === 'course-merge')
    return `课程层：AI 归并总总结与脑图${detail?.identity ? `（${detail.identity}）` : ''}`;
  if (stage === 'cached') return '复用已完成的文档缓存';
  if (stage === 'cache-unavailable')
    return '本机缓存不可用；继续生成，重试可能需要重新计算';
  return 'AI 正在生成';
}
