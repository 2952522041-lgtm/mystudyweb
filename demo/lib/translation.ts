export interface TranslationRequest {
  text: string;
  /** BCP-47 language name or the literal 'auto' for auto-detection. */
  sourceLanguage: string;
  targetLanguage: string;
  pageNumber: number;
}

export interface TranslationResult {
  paragraphs: string[];
  detectedSourceLanguage?: string;
  provider: string;
  model: string;
}

export type TranslationErrorCode =
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'server'
  | 'invalid_input'
  | 'empty_text'
  | 'unknown';

export class TranslationError extends Error {
  code: TranslationErrorCode;
  status?: number;

  constructor(code: TranslationErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'TranslationError';
    this.code = code;
    this.status = status;
  }
}

export const PROMPT_VERSION = 1;
export const MAX_AUTO_RETRIES = 2;

export interface TranslationProvider {
  id: string;
  model: string;
  translate(request: TranslationRequest, options?: { signal?: AbortSignal }): Promise<TranslationResult>;
}

export interface TranslationCacheKeyParts {
  sourceHash: string;
  targetLanguage: string;
  provider: string;
  model: string;
  promptVersion?: number;
}

/**
 * Cache keys include everything that can change the translation output, so a
 * changed language, provider, model, or prompt can never reuse stale cache.
 */
export function translationCacheKey(parts: TranslationCacheKeyParts): string {
  const { sourceHash, targetLanguage, provider, model } = parts;
  const promptVersion = parts.promptVersion ?? PROMPT_VERSION;
  return `${sourceHash}:${targetLanguage}:${provider}:${model}:v${promptVersion}`;
}

export function classifyHttpError(status: number): TranslationErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) return 'rate_limit';
  if (status === 413 || status === 422) return 'invalid_input';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** Only transient failures are retried automatically, at most twice. */
export function shouldAutoRetry(code: TranslationErrorCode, completedAttempts: number): boolean {
  if (completedAttempts >= MAX_AUTO_RETRIES) return false;
  return code === 'network' || code === 'rate_limit' || code === 'server';
}

const STATUS_LABELS: Record<TranslationErrorCode, string> = {
  network: '网络不可用或请求超时，请检查网络连接。',
  auth: '翻译服务鉴权失败，请检查 API Key。',
  rate_limit: '翻译服务限流中，请稍后重试。',
  quota: '翻译服务额度不足，请检查账户余额。',
  server: '翻译服务临时故障，请稍后重试。',
  invalid_input: '本页文本过长或格式不受支持。',
  empty_text: '当前页没有可提取的文字。',
  unknown: '翻译失败，请稍后重试。',
};

export function describeTranslationError(code: TranslationErrorCode): string {
  return STATUS_LABELS[code];
}

export async function translateWithRetry(
  provider: TranslationProvider,
  request: TranslationRequest,
  options?: { signal?: AbortSignal },
): Promise<TranslationResult> {
  let attempts = 0;
  for (;;) {
    try {
      return await provider.translate(request, options);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      const code = error instanceof TranslationError ? error.code : 'unknown';
      if (!shouldAutoRetry(code, attempts)) throw error;
      attempts += 1;
    }
  }
}

const SYSTEM_PROMPT = [
  'You are a professional document translator.',
  'Translate the user text into the requested target language.',
  'Rules:',
  '- Return only the translation, no summaries or explanations.',
  '- Keep the paragraph order and paragraph count.',
  '- Preserve formulas, code, citation numbers, and proper nouns.',
  '- Never invent information that is not in the source text.',
].join('\n');

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Skips the model's built-in reasoning pass (GLM and similar models). */
  disableThinking?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Adapter for any OpenAI-compatible chat completions endpoint. The prompt
 * asks for a JSON array so paragraphs stay separable for display and copy.
 */
export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): TranslationProvider {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    id: 'openai-compatible',
    model: config.model,
    async translate(request, options) {
      if (request.text.trim().length === 0) {
        throw new TranslationError('empty_text', '当前页没有可提取的文字。');
      }

      let response: Response;
      try {
        response = await doFetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          signal: options?.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.2,
            ...(config.disableThinking ? { thinking: { type: 'disabled' } } : {}),
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  `Source language: ${request.sourceLanguage}`,
                  `Target language: ${request.targetLanguage}`,
                  `Page number: ${request.pageNumber}`,
                  'Return a JSON object: {"paragraphs": ["...", "..."]}',
                  '---',
                  request.text,
                ].join('\n'),
              },
            ],
          }),
        });
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        throw new TranslationError('network', '网络不可用或请求超时。', undefined);
      }

      if (!response.ok) {
        throw new TranslationError(
          classifyHttpError(response.status),
          `翻译服务返回 ${response.status}。`,
          response.status,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new TranslationError('server', '翻译服务返回了无法解析的响应。');
      }
      const content = (payload as { choices?: Array<{ message?: { content?: string } }> })
        ?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new TranslationError('server', '翻译服务未返回译文内容。');
      }
      return {
        paragraphs: parseParagraphList(content, request.text),
        provider: 'openai-compatible',
        model: config.model,
      };
    },
  };
}

export function parseParagraphList(content: string, sourceText: string): string[] {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { paragraphs?: unknown };
      if (Array.isArray(parsed.paragraphs)) {
        const paragraphs = parsed.paragraphs
          .filter((paragraph): paragraph is string => typeof paragraph === 'string')
          .map((paragraph) => paragraph.trim())
          .filter((paragraph) => paragraph.length > 0);
        if (paragraphs.length > 0) return paragraphs;
      }
    } catch {
      // fall through to plain-text handling
    }
  }
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 0) return lines;
  return sourceText.split('\n\n').map(() => '[译文解析失败，请重新翻译]');
}

/**
 * Built-in demo provider: returns placeholder paragraphs without any network
 * access, so the reading flow works before a real translation service is set.
 */
export function createMockTranslationProvider(): TranslationProvider {
  return {
    id: 'mock',
    model: 'demo',
    async translate(request) {
      const sourceParagraphs = request.text.split(/\n{2,}/).filter((part) => part.trim().length > 0);
      return {
        paragraphs: sourceParagraphs.map(
          (paragraph, index) =>
            `【演示译文 · 第 ${request.pageNumber} 页 · 段落 ${index + 1}】未配置翻译服务时的占位结果。配置 OpenAI 兼容服务后，这里将显示真实译文。`,
        ),
        provider: 'mock',
        model: 'demo',
      };
    },
  };
}
