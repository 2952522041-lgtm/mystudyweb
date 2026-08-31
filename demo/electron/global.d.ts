import type { YeyuDesktopApi } from './api.ts';

declare global {
  interface Window {
    /** 仅在 Electron 桌面端存在；浏览器环境为 undefined。 */
    yeyuDesktop?: YeyuDesktopApi;
  }
}

export {};
