'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  ListTodo,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button } from './ui/button';
import { DshDiagnosticsPanel } from './dsh-diagnostics-panel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  controlBackgroundTask,
  getBackgroundSnapshot,
  getEmptyBackgroundSnapshot,
  registerTaskControl,
  setBackgroundSnapshot,
  subscribeBackgroundTasks,
} from '@/lib/background-task-store';
import {
  formatTaskDuration,
  summarizeTaskCounts,
} from '@/lib/background-task-presentation';
import type {
  BackgroundAction,
  BackgroundTaskRecord,
} from '@/electron/background-types';

const LABELS = {
  queued: '排队中',
  running: '整理中',
  paused: '已暂停',
  failed: '失败',
  cancelled: '已取消',
  completed: '已完成',
  review: '待审阅',
};
const ORDER = {
  running: 0,
  failed: 1,
  queued: 2,
  paused: 3,
  cancelled: 4,
  completed: 5,
  review: 0.5,
};

export function BackgroundTaskCenter({
  onOpenDocument,
  onOpenCourse,
}: {
  onOpenDocument: (courseId: string, documentId: string) => Promise<unknown>;
  onOpenCourse?: (courseId: string) => Promise<unknown>;
}) {
  const snapshot = useSyncExternalStore(
    subscribeBackgroundTasks,
    getBackgroundSnapshot,
    getEmptyBackgroundSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('active');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const api = window.yeyuDesktop;
    if (
      !api?.getBackgroundSnapshot ||
      !api.controlBackgroundTask ||
      !api.onBackgroundSnapshot
    )
      return;
    let live = true;
    let received = false;
    const unsubscribe = api.onBackgroundSnapshot((value) => {
      received = true;
      if (live) setBackgroundSnapshot(value);
    });
    const unregister = registerTaskControl((command) =>
      api.controlBackgroundTask!(command),
    );
    void api
      .getBackgroundSnapshot()
      .then((value) => {
        if (live && !received) setBackgroundSnapshot(value);
      })
      .catch(() => {
        if (live && !received)
          setBackgroundSnapshot({
            tasks: [],
            executor: 'desktop',
            available: false,
            error: '后台服务暂时无法连接。',
          });
      });
    return () => {
      live = false;
      unsubscribe();
      unregister();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const counts = summarizeTaskCounts(snapshot.tasks);
  const tasks = snapshot.tasks
    .filter(
      (task) =>
        filter === 'all' ||
        (filter === 'active'
          ? ['running', 'queued', 'paused', 'failed', 'review'].includes(task.status)
          : task.status === filter),
    )
    .sort(
      (a, b) =>
        ORDER[a.status] - ORDER[b.status] ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const run = async (command: BackgroundAction) => {
    setBusy(true);
    setError(null);
    try {
      await controlBackgroundTask(command);
    } catch (err) {
      setError(err instanceof Error ? err.message : '任务操作失败。');
    } finally {
      setBusy(false);
    }
  };
  const openDocument = async (task: BackgroundTaskRecord) => {
    setBusy(true);
    setError(null);
    try {
      await onOpenDocument(task.courseId, task.documentId);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '暂时无法打开资料。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="fixed right-4 bottom-12 z-40 max-w-[calc(100vw-2rem)] border-violet-200 bg-white shadow-md"
        onClick={() => setOpen(true)}
        aria-label="打开后台任务中心"
      >
        {counts.running ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <ListTodo />
        )}
        后台任务
        {counts.running + counts.queued > 0
          ? ` · ${counts.running} 项运行 / ${counts.queued} 项排队`
          : counts.failed
            ? ` · ${counts.failed} 项失败`
            : counts.review ? ` · ${counts.review} 项待审阅` : ''}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>后台任务</DialogTitle>
            <DialogDescription>
              PDF 保存后即可阅读。暂停、取消会保留 PDF
              与已完成成果；继续时复用有效缓存。
              {snapshot.executor === 'desktop'
                ? ' 整理由桌面宿主管理，阅读界面重载不影响执行；退出应用后下次启动恢复。'
                : ' 请保持此浏览器页面打开，重新打开并授权课程后可恢复未完成任务。'}
            </DialogDescription>
          </DialogHeader>
          {snapshot.executor === 'desktop' && typeof window !== 'undefined' && window.yeyuDesktop?.getDshHistory
            ? <DshDiagnosticsPanel loadRecords={() => window.yeyuDesktop!.getDshHistory!()} /> : null}
          {!snapshot.available ? (
            <p role="alert" className="text-sm text-rose-700">
              {snapshot.error ?? '后台执行服务尚未就绪。'}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-rose-700">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm">
              显示{' '}
              <select
                aria-label="筛选后台任务"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="rounded border p-1"
              >
                <option value="active">进行中与待处理</option>
                <option value="failed">失败</option>
                <option value="completed">已完成</option>
                <option value="all">全部</option>
              </select>
            </label>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !counts.queued || !snapshot.available}
              onClick={() => void run({ action: 'pause-queued' })}
            >
              暂停排队任务
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !counts.paused || !snapshot.available}
              onClick={() => void run({ action: 'resume-paused' })}
            >
              继续暂停任务
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !counts.failed || !snapshot.available}
              onClick={() => void run({ action: 'retry-failed' })}
            >
              重试失败任务
            </Button>
          </div>
          <output className="text-xs text-slate-500">
            运行 {counts.running} · 排队 {counts.queued} · 暂停 {counts.paused}{' '}
            · 失败 {counts.failed} · 待审阅 {counts.review} · 完成 {counts.completed}
          </output>
          {tasks.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              当前没有符合筛选条件的任务。
            </p>
          ) : (
            <ul aria-label="后台任务列表" className="space-y-3">
              {tasks.map((task) => (
                <li
                  key={task.id}
                  className="rounded-xl border border-slate-200 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-all text-sm font-medium">
                        {task.fileName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {task.courseName} ·{' '}
                        {task.phase === 'course' ? '课程汇总' : 'PDF 整理'}
                      </p>
                    </div>
                    <span
                      className={`text-xs ${task.status === 'failed' ? 'text-rose-700' : 'text-violet-700'}`}
                    >
                      {LABELS[task.status]}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-600">
                    {task.message ??
                      (task.status === 'queued'
                        ? '等待执行；可先阅读 PDF'
                        : task.status === 'completed'
                          ? '成果已保存，可打开阅读'
                          : '已保存当前进度')}
                  </p>
                  {task.totalUnits && task.completedUnits !== undefined ? (
                    <p className="mt-1 text-xs">
                      已处理 {task.completedUnits} / {task.totalUnits}
                    </p>
                  ) : null}
                  {task.status === 'review' && <p className="mt-2 text-xs text-violet-700">候选成果已保存，请回到课程页审阅后应用；当前课程成果保持不变。</p>}
                  {task.modelRequests !== undefined && <p className="mt-1 text-xs text-slate-500">已保存成果：模型请求 {task.modelRequests} 次 · 复用完整缓存 {task.cacheHits ?? 0} 次</p>}
                  {task.startedAt ? (
                    <p className="mt-1 text-xs text-slate-500">
                      本次耗时{' '}
                      {formatTaskDuration(
                        Math.max(
                          0,
                          (task.status === 'running'
                            ? now
                            : Date.parse(task.updatedAt)) -
                            Date.parse(task.startedAt),
                        ),
                      )}
                      {task.attempt ? ` · 第 ${task.attempt} 次执行` : ''}
                    </p>
                  ) : null}
                  {task.lastActivityAt && task.status === 'running' ? (
                    <p className="mt-1 text-xs text-slate-500">
                      最近进展：
                      {formatTaskDuration(
                        Math.max(0, now - Date.parse(task.lastActivityAt)),
                      )}
                      前
                    </p>
                  ) : null}
                  {task.resumedAt ? (
                    <p className="mt-1 text-xs text-emerald-700">
                      已恢复上次未完成任务
                    </p>
                  ) : null}
                  {task.error ? (
                    <p
                      role="alert"
                      className="mt-2 break-words text-xs text-rose-700"
                    >
                      {task.error}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {task.status === 'review' && onOpenCourse && <Button size="xs" disabled={busy} onClick={async () => {
                      setBusy(true);setError(null);
                      try { await onOpenCourse(task.courseId);setOpen(false); }
                      catch { setError('暂时无法打开课程，请从课程列表进入。'); }
                      finally { setBusy(false); }
                    }}>审阅课程更新</Button>}
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      onClick={() => void openDocument(task)}
                    >
                      {task.status === 'completed' ? '打开成果' : '阅读 PDF'}
                    </Button>
                    {task.status === 'queued' || task.status === 'running' ? (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={busy || !snapshot.available}
                        onClick={() =>
                          void run({
                            action: 'pause',
                            courseId: task.courseId,
                            documentId: task.documentId,
                          })
                        }
                      >
                        <Pause />
                        暂停
                      </Button>
                    ) : null}
                    {task.status === 'paused' ? (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={busy || !snapshot.available}
                        onClick={() =>
                          void run({
                            action: 'resume',
                            courseId: task.courseId,
                            documentId: task.documentId,
                          })
                        }
                      >
                        <Play />
                        继续
                      </Button>
                    ) : null}
                    {task.status === 'failed' || task.status === 'cancelled' ? (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={busy || !snapshot.available}
                        onClick={() =>
                          void run({
                            action: 'retry',
                            courseId: task.courseId,
                            documentId: task.documentId,
                          })
                        }
                      >
                        <RotateCcw />
                        重试
                      </Button>
                    ) : null}
                    {['queued', 'running', 'paused'].includes(task.status) ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={busy || !snapshot.available}
                        onClick={() =>
                          void run({
                            action: 'cancel',
                            courseId: task.courseId,
                            documentId: task.documentId,
                          })
                        }
                      >
                        <X />
                        取消任务
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
