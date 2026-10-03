import type {
  BackgroundAction,
  BackgroundSnapshot,
  BackgroundTaskRecord,
} from '../electron/background-types.ts';
import type {
  CourseBundle,
  DocumentProcessing,
} from './course-storage/types.ts';

const EMPTY: BackgroundSnapshot = {
  tasks: [],
  executor: 'browser',
  available: true,
};
let snapshot = EMPTY;
const bundles = new Map<string, CourseBundle>();
const listeners = new Set<() => void>();
let control: ((command: BackgroundAction) => Promise<void>) | undefined;

export function tasksFromBundle(bundle: CourseBundle): BackgroundTaskRecord[] {
  return bundle.manifest.documents.flatMap((doc) => {
    const job = doc.processing;
    if (!job && !doc.hasSummary && !doc.hasMindmap && !doc.includedInCourse)
      return [];
    return [
      {
        id: `${bundle.manifest.id}:${doc.id}`,
        courseId: bundle.manifest.id,
        courseName: bundle.manifest.name,
        documentId: doc.id,
        fileName: doc.fileName,
        phase: job?.phase ?? (doc.includedInCourse ? 'course' : 'document'),
        status: job?.status ?? 'completed',
        updatedAt: job?.updatedAt ?? doc.updatedAt,
        startedAt: job?.startedAt,
        lastActivityAt: job?.lastActivityAt,
        resumedAt: job?.resumedAt,
        attempt: job?.attempt,
        message: job?.message,
        error: job?.error,
        completedUnits: job?.completedUnits,
        totalUnits: job?.totalUnits,
        progressRevision: job?.progressRevision,
      },
    ];
  });
}
function emit() {
  for (const listener of listeners) listener();
}
export function updateTaskBundle(bundle: CourseBundle) {
  bundles.set(bundle.manifest.id, bundle);
  const previous = new Map(snapshot.tasks.map((task) => [task.id, task]));
  snapshot = {
    ...snapshot,
    tasks: [...bundles.values()].flatMap(tasksFromBundle).map((task) => {
      const current = previous.get(task.id);
      // A throttled disk checkpoint can arrive after a newer live progress event.
      if (
        current?.status === 'running' &&
        task.status === 'running' &&
        current.startedAt === task.startedAt &&
        current.phase === task.phase &&
        ((current.progressRevision ?? 0) > (task.progressRevision ?? 0) ||
          Date.parse(current.lastActivityAt ?? '') >
            Date.parse(task.lastActivityAt ?? ''))
      )
        return {
          ...task,
          message: current.message,
          lastActivityAt: current.lastActivityAt,
          completedUnits: current.completedUnits,
          totalUnits: current.totalUnits,
          progressRevision: current.progressRevision,
        };
      return task;
    }),
  };
  emit();
}
export function removeTaskCourse(id: string) {
  bundles.delete(id);
  snapshot = {
    ...snapshot,
    tasks: snapshot.tasks.filter((task) => task.courseId !== id),
  };
  emit();
}
export function updateTaskProgress(
  courseId: string,
  documentId: string,
  progress: Partial<DocumentProcessing>,
) {
  snapshot = {
    ...snapshot,
    tasks: snapshot.tasks.map((task) =>
      task.courseId === courseId && task.documentId === documentId
        ? {
            ...task,
            message: progress.message,
            lastActivityAt: progress.lastActivityAt,
            completedUnits: progress.completedUnits,
            totalUnits: progress.totalUnits,
            progressRevision: progress.progressRevision,
          }
        : task,
    ),
  };
  emit();
}
export function setBackgroundSnapshot(value: BackgroundSnapshot) {
  snapshot = value;
  emit();
}
export function registerTaskControl(
  handler: (command: BackgroundAction) => Promise<void>,
) {
  control = handler;
  return () => {
    if (control === handler) control = undefined;
  };
}
export async function controlBackgroundTask(command: BackgroundAction) {
  if (!control) throw new Error('后台服务尚未就绪，请稍后重试。');
  await control(command);
}
export const subscribeBackgroundTasks = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getBackgroundSnapshot = () => snapshot;
export const getEmptyBackgroundSnapshot = () => EMPTY;
