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

export const PROMPT_VERSION = 2;
export const MAX_AUTO_RETRIES = 2;

export interface TranslateOptions {
  signal?: AbortSignal;
  /** Receives the paragraphs generated so far, for progressive display. */
  onPartial?: (paragraphs: string[]) => void;
}

export interface TranslationProvider {
  id: string;
  model: string;
  translate(request: TranslationRequest, options?: TranslateOptions): Promise<TranslationResult>;
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
  options?: TranslateOptions,
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
  '- Output only the translation, no summaries or explanations.',
  '- Keep the paragraph order and paragraph count.',
  '- Separate paragraphs with one blank line.',
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
            stream: true,
            ...(config.disableThinking ? { thinking: { type: 'disabled' } } : {}),
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  `Source language: ${request.sourceLanguage}`,
                  `Target language: ${request.targetLanguage}`,
                  `Page number: ${request.pageNumber}`,
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
        const detail = await extractErrorDetail(response);
        throw new TranslationError(
          classifyHttpError(response.status),
          detail ? `翻译服务返回 ${response.status}：${detail}` : `翻译服务返回 ${response.status}。`,
          response.status,
        );
      }

      const content = await readStreamingContent(response, options);
      if (content.length === 0) {
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

/** Reads an SSE chat-completions stream, reporting paragraphs as they arrive. */
async function readStreamingContent(response: Response, options?: TranslateOptions): Promise<string> {
  const body = response.body;
  if (!body) {
    const payload = await response.json();
    return extractChoiceContent(payload);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reported = '';

  const report = () => {
    if (!options?.onPartial) return;
    const paragraphs = splitStreamParagraphs(content);
    const joined = paragraphs.join('\n\n');
    if (joined !== reported) {
      reported = joined;
      options.onPartial(paragraphs);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n');
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        content += chunk.choices?.[0]?.delta?.content ?? '';
      } catch {
        // partial JSON line; the next chunk completes it
      }
    }
    report();
  }
  report();
  return content;
}

function extractChoiceContent(payload: unknown): string {
  const content = (payload as { choices?: Array<{ message?: { content?: string } }> })
    ?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

/** Same paragraph rule as the final parse, safe to run mid-stream. */
function splitStreamParagraphs(content: string): string[] {
  const cleaned = stripCodeFences(content);
  return cleaned
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function stripCodeFences(text: string): string {
  return text.replace(/```[^\n]*\n?/g, '');
}

/**
 * Surfaces the provider's own explanation (wrong key, missing balance,
 * unknown model, …) so the reader can act instead of seeing a bare status.
 */
async function extractErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
    };
    const message = payload?.error?.message ?? payload?.message;
    if (typeof message === 'string' && message.trim().length > 0) {
      const trimmed = message.trim();
      return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    }
  } catch {
    // not a JSON error body
  }
  return '';
}

/**
 * Splits model output into display paragraphs. The prompt asks for
 * blank-line-separated plain text (streaming friendly); JSON arrays from
 * older prompts or chatty models are still recognized as a fallback.
 */
export function parseParagraphList(content: string, sourceText: string): string[] {
  const cleaned = stripCodeFences(content.trim());

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
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

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length > 0) return paragraphs;

  const lines = cleaned
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
