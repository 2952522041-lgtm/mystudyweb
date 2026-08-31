/**
 * 窗口导航策略纯函数。
 *
 * 主窗口只允许停留在应用自己的本地 origin；任何离开该 origin 的导航都被
 * 拒绝，其中 http/https 外链转交系统浏览器，其余协议一律丢弃。
 * 纯函数化是为了不启动 Electron 就能单测全部规则。
 */

/** YEYU_DEV_URL 配置错误；只影响开发环境，必须在启动时立刻失败。 */
export class DevUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevUrlError';
  }
}

/**
 * 解析 YEYU_DEV_URL：
 * - 打包环境一律忽略该变量，桌面端永远加载本地构建产物；
 * - 开发环境只接受 `127.0.0.1` 或 `localhost` 的 http/https 地址，
 *   其他值视为配置错误直接抛出，避免把窗口指向意外目标。
 */
export function resolveDevUrl(
  raw: string | undefined,
  isPackaged: boolean,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (isPackaged) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DevUrlError(
      `YEYU_DEV_URL 不是合法 URL：${JSON.stringify(trimmed)}`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DevUrlError(
      `YEYU_DEV_URL 只允许 http/https，收到 ${url.protocol}`,
    );
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new DevUrlError(
      `YEYU_DEV_URL 只允许本机回环地址（127.0.0.1/localhost），收到 ${url.hostname}`,
    );
  }
  return trimmed;
}

/** 主窗口是否允许停留在该地址：只有与应用 origin 完全一致才算允许。 */
export function isAppOriginUrl(rawUrl: string, appOrigin: string): boolean {
  try {
    return new URL(rawUrl).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * 外部链接只放行 http/https 并交给系统浏览器；
 * file:、javascript: 等其他协议一律返回 null，不允许 openExternal。
 */
export function externalHttpUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}
