/** Only these fixed codes/messages may cross the worker and IPC boundaries. */
export const DSH_ERRORS = {
  invalid_request: 'DSH 请求参数无效，请检查模型与输入设置。',
  unsupported_model: 'DSH 模型不兼容，请在阅读服务设置中选择已接入的模型。',
  unsupported_parameter: '当前 DSH 运行时不支持 temperature 或 responseFormat；请使用服务商默认采样及应用 JSON 校验，或选择 API。',
  runtime_missing: 'DSH 运行时未安装或无法启动，请运行 pnpm dsh:install。',
  runtime_version: 'DSH 运行时版本不匹配，请运行 pnpm dsh:install 安装固定版本。',
  authentication: 'DSH 服务鉴权失败，请检查该功能的 API Key 与账户权限。',
  rate_limit: 'DSH 服务限流或额度不足，请检查账户额度并稍后重试。',
  network: 'DSH 网络连接失败，请检查网络后重试。',
  service_busy: 'DSH 服务暂时繁忙，请稍后重试。',
  timeout: 'DSH 执行或服务响应超时，请稍后重试。',
  queue_timeout: 'DSH 排队等待超时，请待正在运行的任务完成后重试。',
  cancelled: 'DSH 排队任务已取消或正在运行的任务已停止。',
  queue_full: 'DSH 等待任务过多或等待数据过多，请稍后重试。',
  duplicate: 'DSH 请求重复。',
  closed: 'DSH 正在关闭。',
  incomplete: 'DSH 任务未完成；未发布残缺结果。',
  protocol: 'DSH 运行时返回格式异常，请检查固定版本后重试。',
} as const;
export type DshErrorCode = keyof typeof DSH_ERRORS;
export function isDshErrorCode(value: unknown): value is DshErrorCode {
  return typeof value === 'string' && Object.hasOwn(DSH_ERRORS, value);
}
export class DshError extends Error {
  readonly code: DshErrorCode;
  constructor(code: DshErrorCode) {
    super(`[DSH:${code}] ${DSH_ERRORS[code]}`);
    this.name = 'DshError';
    this.code = code;
  }
}
/** Electron may discard custom properties but preserves Error.message. Never
 * forward that message: decode an allowlisted tag and reconstruct static text. */
export function safeDshError(error: unknown, fallback: DshErrorCode = 'incomplete'): DshError {
  if (error instanceof DshError) return new DshError(error.code);
  const value = error && typeof error === 'object' ? error as { message?: unknown } : {};
  const match = typeof value.message === 'string' ? /\[DSH:([a-z_]+)\]/.exec(value.message) : null;
  return new DshError(match && isDshErrorCode(match[1]) ? match[1] : fallback);
}
/** Interpret structured upstream codes/status only, never match private bodies. */
export function classifyDshProviderError(error: unknown): DshError {
  if (error instanceof DshError) return error;
  const value = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown; name?: unknown } : {};
  const status = value.status ?? value.statusCode;
  if ([502, 503, 504].includes(Number(status))) return new DshError('service_busy');
  if (status === 401 || status === 403 || value.code === 'INVALID_CREDENTIAL') return new DshError('authentication');
  if (status === 429 || ['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'QUOTA_EXCEEDED', 'ACCOUNT_QUOTA_EXCEEDED'].includes(String(value.code))) return new DshError('rate_limit');
  if (['ETIMEDOUT', 'MESSAGES_IDLE', 'TIMEOUT'].includes(String(value.code)) || value.name === 'TimeoutError') return new DshError('timeout');
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(value.code))) return new DshError('network');
  if (value.cause && value.cause !== error) {
    const cause = value.cause as { code?: unknown; status?: unknown };
    if (typeof cause.code === 'string' || typeof cause.status === 'number') return classifyDshProviderError({ code: cause.code, status: cause.status });
  }
  return new DshError('incomplete');
}
