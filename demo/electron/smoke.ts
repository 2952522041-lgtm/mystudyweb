import type { BrowserWindow } from 'electron';

import type { WorkspaceInfo } from './api.ts';

/** 冒烟测试从 stdout 解析这行标记来读取探测结果。 */
export const SMOKE_RESULT_MARKER = 'YEYU_SMOKE_RESULT';

/** 打开后主进程会在页面加载完成时探测 preload 桥接并自动退出。 */
export const SMOKE_ENV_VAR = 'YEYU_SMOKE';

export interface SmokeProbeResult {
  api: boolean;
  methods?: string[];
  workspace?: WorkspaceInfo;
  /** setWindowOpenHandler 运行时确实拒绝弹窗时为 true。 */
  popupDenied?: boolean;
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
  let result: SmokeProbeResult;
  try {
    result = await window.webContents.executeJavaScript(
      `(async () => {
        const api = window.yeyuDesktop;
        if (!api) return { api: false, error: 'window.yeyuDesktop 不存在' };
        try {
          // setWindowOpenHandler 默认 deny：被拒绝的 window.open 返回 null。
          const popup = window.open('about:blank');
          return {
            api: true,
            popupDenied: popup === null,
            methods: Object.keys(api).sort(),
            workspace: await api.getWorkspaceInfo(),
          };
        } catch (error) {
          return { api: false, error: String(error) };
        }
      })()`,
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
