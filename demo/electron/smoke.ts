import type { BrowserWindow } from 'electron';

import type { WorkspaceInfo } from './api.ts';

/** 冒烟测试从 stdout 解析这行标记来读取探测结果。 */
export const SMOKE_RESULT_MARKER = 'YEYU_SMOKE_RESULT';

/** 打开后主进程会在页面加载完成时探测 preload 桥接并自动退出。 */
export const SMOKE_ENV_VAR = 'YEYU_SMOKE';

/** 置为 1 时探测还会通过真实桥接创建一门冒烟课程并写 course.json。 */
export const SMOKE_CREATE_COURSE_ENV_VAR = 'YEYU_SMOKE_CREATE_COURSE';

/** 首次冒烟启动写入 localStorage，第二次启动读取，验证 origin 稳定。 */
export const SMOKE_STORAGE_VALUE_ENV_VAR = 'YEYU_SMOKE_STORAGE_VALUE';

export const SMOKE_COURSE_NAME = '冒烟课程';

export interface SmokeProbeResult {
  api: boolean;
  methods?: string[];
  workspace?: WorkspaceInfo;
  /** setWindowOpenHandler 运行时确实拒绝弹窗时为 true。 */
  popupDenied?: boolean;
  /** YEYU_SMOKE_CREATE_COURSE=1 时，通过桥接创建的课程目录名。 */
  createdCourse?: string;
  /** listCourses() 返回的课程目录名（只有含合法 course.json 的目录）。 */
  courses?: string[];
  origin?: string;
  storedBefore?: string | null;
  storedAfter?: string | null;
  backgroundRoleBlocked?: boolean;
  backgroundSnapshotValid?: boolean;
  courseLockRoundtrip?: boolean;
  buildMetadataValid?: boolean;
  dshHistoryValid?: boolean;
  restoreTokenRejected?: boolean;
  error?: string;
}

export function isSmokeRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SMOKE_ENV_VAR] === '1';
}

/**
 * 在真实 renderer 主世界（contextBridge 暴露的对象就在这里）探测 preload
 * 桥接：window.yeyuDesktop 是否存在、方法面是否完整、getWorkspaceInfo()
 * 能否真正完成一次 IPC 往返。结果用标记行写到 stdout，任何失败都不抛出。
 */
export async function probePreloadBridge(
  window: BrowserWindow,
): Promise<SmokeProbeResult> {
  const createCourse = process.env[SMOKE_CREATE_COURSE_ENV_VAR] === '1';
  const storageValue = process.env[SMOKE_STORAGE_VALUE_ENV_VAR];
  const courseName = SMOKE_COURSE_NAME;
  let result: SmokeProbeResult;
  try {
    result = await window.webContents.executeJavaScript(
      `(async (createCourse, courseName, storageValue) => {
        const api = window.yeyuDesktop;
        if (!api) return { api: false, error: 'window.yeyuDesktop 不存在' };
        try {
          const storageKey = 'yeyu-smoke-persistent-settings';
          const storedBefore = localStorage.getItem(storageKey);
          if (typeof storageValue === 'string') {
            localStorage.setItem(storageKey, storageValue);
          }
          // setWindowOpenHandler 默认 deny：被拒绝的 window.open 返回 null。
          const popup = window.open('about:blank');
          let createdCourse;
          if (createCourse) {
            createdCourse = (await api.createCourseDirectory(courseName))
              .directoryName;
            // course.json 是课程目录的合法标志；scanCourses 只统计有清单的目录。
            const manifest = {
              schemaVersion: 1,
              id: 'smoke-course',
              name: courseName,
              revision: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              activeKnowledgeVersion: 0,
              documents: [],
            };
            await api.writeFile(
              createdCourse,
              ['course.json'],
              new TextEncoder().encode(JSON.stringify(manifest)),
            );
          }
          let backgroundRoleBlocked = false;
          try { await api.publishBackgroundSnapshot({tasks:[],executor:'desktop',available:true}); } catch { backgroundRoleBlocked = true; }
          const background = await api.getBackgroundSnapshot();
          const buildInfo = await api.getBuildInfo();
          const dshHistory = await api.getDshHistory();
          let restoreTokenRejected = false;
          try { await api.restoreCourseBackup('smoke-invalid-token'); } catch { restoreTokenRejected = true; }
          let courseLockRoundtrip = !createdCourse;
          if (createdCourse) { const token = await api.acquireCourseLock(createdCourse); await api.releaseCourseLock(token); courseLockRoundtrip = true; }
          const courses = (await api.listCourses()).map(
            (course) => course.directoryName,
          );
          return {
            api: true,
            backgroundRoleBlocked,
            backgroundSnapshotValid: background.executor === 'desktop' && typeof background.available === 'boolean' && Array.isArray(background.tasks),
            courseLockRoundtrip,
            buildMetadataValid: typeof buildInfo.version === 'string' && typeof buildInfo.dirty === 'boolean',
            dshHistoryValid: Array.isArray(dshHistory),
            restoreTokenRejected,
            popupDenied: popup === null,
            methods: Object.keys(api).sort(),
            workspace: await api.getWorkspaceInfo(),
            createdCourse,
            courses,
            origin: location.origin,
            storedBefore,
            storedAfter: localStorage.getItem(storageKey),
          };
        } catch (error) {
          return { api: false, error: String(error) };
        }
      })(${JSON.stringify(createCourse)}, ${JSON.stringify(courseName)}, ${JSON.stringify(storageValue)})`,
    );
  } catch (error) {
    result = {
      api: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  process.stdout.write(`${SMOKE_RESULT_MARKER} ${JSON.stringify(result)}\n`);
  return result;
}
