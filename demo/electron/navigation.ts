/**
 * 窗口导航隔离的纯函数（HANDOFF 13.3）。主窗口只允许唯一的应用 origin；
 * 外部 http/https 链接交给系统浏览器打开；其余协议一律拒绝。
 * 不依赖 electron，可以在 node --test 中直接测试。
 */

export interface DevTargetDecision {
  /** 校验通过的开发服务器地址；不使用开发服务器时为 null。 */
  url: string | null;
  /** 需要在启动时打印的告警（例如打包后忽略 YEYU_DEV_URL）。 */
  warning?: string;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * 桌面生产版必须使用稳定 origin：localStorage、IndexedDB 和缓存都按 origin
 * 隔离。随机端口会让每次启动都像首次访问，导致接口设置和 API Key 丢失。
 */
export const PACKAGED_APP_PORT = 47831;
export const PACKAGED_APP_ORIGIN = `http://127.0.0.1:${PACKAGED_APP_PORT}`;

/**
 * 解析 YEYU_DEV_URL：只在应用未打包时生效，且只接受 localhost、
 * 127.0.0.1 或 IPv6 回环地址的 http URL。配置非法时抛错，启动即失败，
 * 避免静默回退到生产产物掩盖配置错误。
 */
export function resolveDevTargetUrl(
  rawUrl: string | undefined,
  isPackaged: boolean,
): DevTargetDecision {
  const raw = rawUrl?.trim();
  if (!raw) return { url: null };
  if (isPackaged) {
    return {
      url: null,
      warning: '打包后的应用忽略 YEYU_DEV_URL，始终加载内置静态产物。',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`YEYU_DEV_URL 不是合法 URL：${raw}`);
  }
  if (parsed.protocol !== 'http:') {
    throw new Error(`YEYU_DEV_URL 只允许 http 协议，收到：${parsed.protocol}`);
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      'YEYU_DEV_URL 只允许 localhost、127.0.0.1 或 IPv6 回环地址。',
    );
  }
  return { url: parsed.toString() };
}

/** URL 是否属于应用 origin（协议+主机+端口一致，路径任意）。 */
export function isAppOrigin(rawUrl: string, appOrigin: string): boolean {
  try {
    return new URL(rawUrl).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * 外部 http/https 链接返回可交给 shell.openExternal 的完整地址；
 * 自定义协议、file: 等一律返回 null，调用方必须拒绝。
 */
export function externalHttpUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}
