import { safeDshError } from './dsh-errors.ts';

/** App-owned task protocol: no model credentials, document text or filesystem paths. */
export type BackgroundTaskStatus = 'queued' | 'running' | 'paused' | 'failed' | 'cancelled' | 'completed' | 'review';
export interface BackgroundTaskRecord {
  id: string;
  courseId: string;
  courseName: string;
  documentId: string;
  fileName: string;
  phase: 'document' | 'course';
  status: BackgroundTaskStatus;
  updatedAt: string;
  startedAt?: string;
  lastActivityAt?: string;
  resumedAt?: string;
  attempt?: number;
  message?: string;
  error?: string;
  completedUnits?: number;
  totalUnits?: number;
  progressRevision?: number;
  cacheHits?: number;
  modelRequests?: number;
}
export interface BackgroundSnapshot {
  tasks: BackgroundTaskRecord[];
  executor: 'browser' | 'desktop';
  available: boolean;
  error?: string;
}
export interface BackgroundAction {
  action: 'pause' | 'resume' | 'cancel' | 'retry' | 'pause-queued' | 'resume-paused' | 'retry-failed';
  courseId?: string;
  documentId?: string;
}
export interface BackgroundCommand extends BackgroundAction { id: string }
export interface BackgroundResponse { id: string; error?: string }

export function validateBackgroundAction(value: unknown): BackgroundAction {
  if (!value || typeof value !== 'object') throw new Error('后台操作无效。');
  const input = value as BackgroundAction;
  if (!['pause', 'resume', 'cancel', 'retry', 'pause-queued', 'resume-paused', 'retry-failed'].includes(input.action))
    throw new Error('不支持的后台操作。');
  if (['pause', 'resume', 'cancel', 'retry'].includes(input.action)) {
    if (typeof input.courseId !== 'string' || !input.courseId || input.courseId.length > 255
      || typeof input.documentId !== 'string' || !input.documentId || input.documentId.length > 255)
      throw new Error('请选择一个后台任务。');
    return {action:input.action, courseId:input.courseId, documentId:input.documentId};
  }
  return {action:input.action};
}

/** Project only display fields before crossing IPC; never forward arbitrary worker data. */
export function sanitizeBackgroundSnapshot(value: unknown): BackgroundSnapshot {
  if (!value || typeof value !== 'object' || !Array.isArray((value as BackgroundSnapshot).tasks))
    throw new Error('后台状态无效。');
  const input = value as BackgroundSnapshot;
  const text = (v: unknown, max = 255) => typeof v === 'string' ? v.slice(0, max) : undefined;
  const progressMessage = (task: BackgroundTaskRecord): string | undefined => {
    if (typeof task.message === 'string') {
      if (/^(提取文字|OCR) \d{1,6}\/\d{1,6}$/.test(task.message) || /^分块层：AI 分析 \d{1,6} \/ \d{1,6}$/.test(task.message)) return task.message;
      if (task.message.startsWith('文档层：AI 归并摘要')) return '文档层：AI 归并摘要';
      if (task.message.startsWith('课程层：AI 归并总总结与脑图')) return '课程层：AI 归并总总结与脑图';
      if (['复用已完成的文档缓存', '本机缓存不可用；继续生成，重试可能需要重新计算', 'AI 正在生成'].includes(task.message)) return task.message;
    }
    return task.status === 'running' ? (task.phase === 'document' ? '正在整理文档' : '正在汇总课程') : undefined;
  };
  const tasks = input.tasks.slice(0, 1000).flatMap(task => {
    if (!task || typeof task !== 'object' || !text(task.id) || !text(task.courseId) || !text(task.documentId)
      || !['queued', 'running', 'paused', 'failed', 'cancelled', 'completed', 'review'].includes(task.status)
      || !['document', 'course'].includes(task.phase)) return [];
    return [{id:text(task.id)!,courseId:text(task.courseId)!,documentId:text(task.documentId)!,
      courseName:text(task.courseName) ?? '',fileName:text(task.fileName) ?? '',phase:task.phase,status:task.status,
      updatedAt:text(task.updatedAt,40) ?? '',startedAt:text(task.startedAt,40),lastActivityAt:text(task.lastActivityAt,40),
      resumedAt:text(task.resumedAt,40),
      message: progressMessage(task),
      error: typeof task.error === 'string' ? (/\[DSH:[a-z_]+\]/.test(task.error) ? safeDshError(new Error(task.error)).message : '任务未完成，请检查模型配置或重试；已完成内容保留。') : undefined,
      cacheHits:Number.isSafeInteger(task.cacheHits) && task.cacheHits! >= 0 ? task.cacheHits : undefined,
      modelRequests:Number.isSafeInteger(task.modelRequests) && task.modelRequests! >= 0 ? task.modelRequests : undefined,
      attempt:Number.isSafeInteger(task.attempt) ? task.attempt : undefined,
      completedUnits:Number.isSafeInteger(task.completedUnits) ? task.completedUnits : undefined,
      totalUnits:Number.isSafeInteger(task.totalUnits) ? task.totalUnits : undefined,
      progressRevision:Number.isSafeInteger(task.progressRevision) ? task.progressRevision : undefined}];
  });
  return {tasks,executor:'desktop',available:input.available === true,...(input.available !== true ? {error:'后台服务暂时不可用，请稍后重试。'} : {})};
}
