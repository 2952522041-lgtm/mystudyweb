'use client';

import { useEffect } from 'react';
import { createBackgroundProcessor } from '@/lib/background-processor';
import { DesktopCourseStorage } from '@/lib/course-storage/desktop-course-storage';
import {
  getBackgroundSnapshot,
  removeTaskCourse,
  subscribeBackgroundTasks,
  updateTaskBundle,
} from '@/lib/background-task-store';

/** Main-process-owned execution surface. No visible UI or MCP handler. */
export function BackgroundTaskHost() {
  useEffect(() => {
    const api = window.yeyuDesktop;
    if (!api?.onBackgroundCommand || !api.publishBackgroundSnapshot) return;
    let disposed = false;
    let available = false;
    let scanning: Promise<void> | undefined;
    let rescan = false;
    const courses = new Map<
      string,
      { storage: DesktopCourseStorage; directory: string; revision: number }
    >();
    const publish = () => {
      if (!disposed)
        void api.publishBackgroundSnapshot!({
          ...getBackgroundSnapshot(),
          executor: 'desktop',
          available,
          error: available ? undefined : '课程任务暂时无法读取。',
        }).catch(() => undefined);
    };
    const worker = createBackgroundProcessor({
      onBundle: (_id, bundle) => {
        const entry = courses.get(bundle.manifest.id);
        if (entry) entry.revision = bundle.manifest.revision;
      },
      onError: publish,
    });
    const scan = (): Promise<void> => {
      if (scanning) {
        rescan = true;
        return scanning;
      }
      scanning = (async () => {
        do {
          rescan = false;
          const listed = await api.listCourses();
          if (disposed) return;
          const found = new Set(listed.map((item) => item.manifest.id));
          for (const id of courses.keys())
            if (!found.has(id)) {
              worker.unregister(id);
              courses.delete(id);
              removeTaskCourse(id);
            }
          for (const item of listed) {
            let entry = courses.get(item.manifest.id);
            if (!entry) {
              entry = {
                storage: new DesktopCourseStorage(api, item.directoryName),
                directory: item.directoryName,
                revision: -1,
              };
              courses.set(item.manifest.id, entry);
              worker.register(item.manifest.id, entry.storage);
            }
            if (entry.revision !== item.manifest.revision) {
              const bundle = await entry.storage.load();
              if (disposed) return;
              entry.revision = bundle.manifest.revision;
              updateTaskBundle(bundle);
            }
          }
          available = true;
          worker.wake();
          publish();
        } while (rescan && !disposed);
      })()
        .catch((error) => {
          available = false;
          publish();
          throw error;
        })
        .finally(() => {
          scanning = undefined;
        });
      return scanning;
    };
    const unsubscribe = subscribeBackgroundTasks(publish);
    const unwatch = api.onCoursesChanged?.(() => {
      void scan().catch(() => undefined);
    });
    const uncommand = api.onBackgroundCommand(async (command) => {
      await scan();
      await worker.control(command);
      publish();
    });
    worker.resume();
    void scan().catch(() => undefined);
    // Also catches external course changes; doesn't depend on the visible window.
    const timer = setInterval(() => {
      void scan().catch(() => undefined);
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
      worker.stop();
      unsubscribe();
      unwatch?.();
      uncommand();
    };
  }, []);
  return <output>页语后台任务服务</output>;
}
