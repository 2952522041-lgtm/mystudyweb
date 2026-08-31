export type ChatErrorCode =
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'server'
  | 'invalid_input'
  | 'unknown';

export class ChatError extends Error {
  code: ChatErrorCode;
  status?: number;

  constructor(code: ChatErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
    this.status = status;
  }
}

const CHAT_ERROR_LABELS: Record<ChatErrorCode, string> = {
  network: '网络不可用或请求超时，请检查网络连接。',
  auth: 'AI 答疑服务鉴权失败，请检查 API Key。',
  rate_limit: 'AI 答疑服务限流中，请稍后重试。',
  quota: 'AI 答疑服务额度不足，请检查账户余额。',
  server: 'AI 答疑服务临时故障，请稍后重试。',
  invalid_input: '当前页面图像或对话内容过大，请缩短对话后重试。',
  unknown: 'AI 答疑失败，请稍后重试。',
};

export function describeChatError(code: ChatErrorCode): string {
  return CHAT_ERROR_LABELS[code];
}

export function classifyChatHttpError(status: number): ChatErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 400 || status === 413 || status === 422)
    return 'invalid_input';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'unknown';
}

export async function extractErrorDetail(
  response: Response,
): Promise<string | null> {
  try {
    const payload = (await response.json()) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof payload.error === 'string') return payload.error.slice(0, 500);
    if (payload.error && typeof payload.error.message === 'string') {
      return payload.error.message.slice(0, 500);
    }
    if (typeof payload.message === 'string')
      return payload.message.slice(0, 500);
  } catch {
    // Some providers return an empty or non-JSON error body.
  }
  return null;
}
