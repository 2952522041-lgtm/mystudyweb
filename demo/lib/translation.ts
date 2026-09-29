import { glossaryPrompt, type Glossary } from './glossary.ts';
import { protectScientificText, safeScientificCut, splitScientificParagraphs } from './scientific-text.ts';
import { useDshForTask as selectDshForTask } from './agent-settings.ts';
import { requestChatCompletion } from './openai-client.ts';

export interface TranslationRequest {
  glossary?: Glossary;
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
  | 'invalid_output'
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

export const PROMPT_VERSION = 7;
export const MAX_AUTO_RETRIES = 2;
export const MAX_TRANSLATION_CHUNK_CHARACTERS = 3000;
const MAX_TRUNCATION_SPLITS = 3;

export interface TranslateOptions {
  signal?: AbortSignal;
  /** Receives the paragraphs generated so far, for progressive display. */
  onPartial?: (paragraphs: string[]) => void;
}

export interface TranslationProvider {
  id: string;
  model: string;
  translate(
    request: TranslationRequest,
    options?: TranslateOptions,
  ): Promise<TranslationResult>;
}

export interface TranslationCacheKeyParts {
  sourceHash: string;
  targetLanguage: string;
  provider: string;
  model: string;
  promptVersion?: number;
  glossaryFingerprint?: string;
}

/**
 * Cache keys include everything that can change the translation output, so a
 * changed language, provider, model, or prompt can never reuse stale cache.
 */
export function translationCacheKey(parts: TranslationCacheKeyParts): string {
  const { sourceHash, targetLanguage, provider, model } = parts;
  const promptVersion = parts.promptVersion ?? PROMPT_VERSION;
  return `${sourceHash}:${targetLanguage}:${provider}:${model}:v${promptVersion}${parts.glossaryFingerprint ? `:g${parts.glossaryFingerprint}` : ''}`;
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
export function shouldAutoRetry(
  code: TranslationErrorCode,
  completedAttempts: number,
): boolean {
  if (completedAttempts >= MAX_AUTO_RETRIES) return false;
  return code === 'network' || code === 'rate_limit' || code === 'server';
}

const STATUS_LABELS: Record<TranslationErrorCode, string> = {
  network: '网络不可用或请求超时，请检查网络连接。',
  auth: '翻译服务鉴权失败，请检查 API Key。',
  rate_limit: '翻译服务限流中，请稍后重试。',
  quota: '翻译服务额度不足，请检查账户余额。',
  server: '翻译服务临时故障，请稍后重试。',
  invalid_output: '译文公式或段落校验失败，请重新翻译或在阅读服务设置中更换模型。',
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
  'Translate the user text directly into the requested target language without analysis.',
  'Rules:',
  '- Translate every sentence. Never omit, shorten, merge away, or summarize any source content.',
  '- Output only the complete translation, no summaries or explanations.',
  '- Keep the paragraph order and paragraph count.',
  '- The input is one source paragraph or a fragment of one. Keep its internal Markdown lists and line breaks.',
  '- Copy every YYKEEP…ZZ placeholder exactly once in its original order. Never translate, expand, remove, duplicate or wrap placeholders in code fences.',
  '- Preserve formulas, code, citation numbers, and proper nouns.',
  '- Copy math and scientific notation character for character: Greek letters (α, β, γ, θ, λ, μ, φ, ψ, ω), operators (±, ×, ÷, ≤, ≥, ≠, ≈, ∑, ∫, √), subscripts, superscripts, and units. Never drop, transliterate, or replace them.',
  '- Never invent information that is not in the source text.',
].join('\n');

/** Keeps one-page translations bounded without truncating normal dense pages. */
export function recommendedMaxOutputTokens(text: string): number {
  return Math.min(Math.max(Math.ceil(text.length * 1.2), 1024), 8192);
}

function splitOversizedPart(part: string, maxCharacters: number): string[] {
  const pieces: string[] = [];
  let remaining = part.trim();
  while (remaining.length > maxCharacters) {
    const window = remaining.slice(0, maxCharacters + 1);
    const minimumCut = Math.floor(maxCharacters * 0.55);
    let cut = -1;
    for (const match of window.matchAll(/[.!?。！？](?:["'”’\])}]*)?\s+/gu)) {
      const candidate = (match.index ?? 0) + match[0].length;
      if (candidate >= minimumCut) cut = candidate;
    }
    if (cut < minimumCut) cut = window.lastIndexOf(' ', maxCharacters);
    if (cut < minimumCut) cut = maxCharacters;
    cut = safeScientificCut(remaining, cut);
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) pieces.push(remaining);
  return pieces;
}

/**
 * Keeps dense journal pages below provider output limits. Paragraphs remain
 * intact when possible; only a single oversized paragraph is split at a
 * sentence or word boundary.
 */
export function splitTranslationChunks(
  text: string,
  maxCharacters = MAX_TRANSLATION_CHUNK_CHARACTERS,
): string[] {
  if (maxCharacters < 1) throw new RangeError('maxCharacters must be positive');
  const parts = splitScientificParagraphs(text)
    .flatMap((part) => splitOversizedPart(part, maxCharacters))
    .filter((part) => part.length > 0);
  const chunks: string[] = [];
  let current = '';
  for (const part of parts) {
    const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
    if (candidate.length <= maxCharacters) {
      current = candidate;
      continue;
    }
    if (current.length > 0) chunks.push(current);
    current = part;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Skips the model's built-in reasoning pass (GLM and similar models). */
  disableThinking?: boolean;
  fetchImpl?: typeof fetch;
  /** Covers both connection and streaming; injectable for offline tests. */
  requestTimeoutMs?: number;
}

interface BatchParagraph {
  id: string;
  protectedText: ReturnType<typeof protectScientificText>;
}

function batchPayload(batch: BatchParagraph[]): string {
  return JSON.stringify({ paragraphs: batch.map(({ id, protectedText }) => ({ id, text: protectedText.text })) });
}

/** Bounded batches never split a source paragraph or mix pages. */
function translationBatches(request: TranslationRequest): BatchParagraph[][] {
  const batches: BatchParagraph[][] = [];
  let batch: BatchParagraph[] = [];
  for (const [index, source] of splitScientificParagraphs(request.text).entries()) {
    const entry = { id: `page-${request.pageNumber}-paragraph-${index + 1}`, protectedText: protectScientificText(source) };
    if (batch.length && batchPayload([...batch, entry]).length > MAX_TRANSLATION_CHUNK_CHARACTERS) {
      batches.push(batch);
      batch = [];
    }
    batch.push(entry);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

const BATCH_SYSTEM_PROMPT = SYSTEM_PROMPT.replace(
  '- The input is one source paragraph or a fragment of one. Keep its internal Markdown lists and line breaks.',
  '- The input is JSON with paragraphs [{id, text}]. Return only JSON with the same schema and unchanged IDs. Translate each text independently, keeping its internal Markdown lists and line breaks. Never move content between IDs. Placeholder rules apply separately within each paragraph.',
);

/** Unknown/duplicate IDs are ambiguous; missing/invalid texts fall back individually. */
function restoreBatch(content: string, batch: BatchParagraph[]): Map<string, string> {
  const output = new Map<string, string>();
  try {
    const parsed = JSON.parse(stripCodeFences(content.trim())) as { paragraphs?: unknown };
    if (!Array.isArray(parsed.paragraphs)) return output;
    const expected = new Map(batch.map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    for (const entry of parsed.paragraphs) {
      if (!entry || typeof entry.id !== 'string' || !expected.has(entry.id) || seen.has(entry.id)) return new Map();
      seen.add(entry.id);
      if (typeof entry.text !== 'string' || !entry.text.trim()) continue;
      const source = expected.get(entry.id)!;
      try {
        output.set(entry.id, source.protectedText.restore(entry.text.trim(), source.protectedText.text));
      } catch { /* Re-translate only this paragraph if its scientific markers changed. */ }
    }
  } catch { /* Non-JSON or truncated responses use the established single-paragraph path. */ }
  return output;
}

/**
 * Adapter for any OpenAI-compatible chat completions endpoint. Dense pages
 * are translated in bounded chunks and combined only after every chunk ends.
 */
export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
): TranslationProvider {
  const doFetch = config.fetchImpl ?? fetch;
  // Capture the selected backend when the provider is created.  The provider
  // identity is part of the reader cache key, so changing backend settings
  // while an existing provider is in use must not make one provider appear as
  // the other half-way through a page translation.
  const useDsh = selectDshForTask('translation');
  const providerId = useDsh ? 'openai-compatible:dsh' : 'openai-compatible';
  return {
    id: providerId,
    model: config.model,
    async translate(request, options) {
      if (request.text.trim().length === 0) {
        throw new TranslationError('empty_text', '当前页没有可提取的文字。');
      }

      try { glossaryPrompt(request.glossary, request.text); }
      catch (error) { throw new TranslationError('invalid_input', error instanceof Error ? error.message : '术语表无效。'); }
      const completedParagraphs: string[] = [];
      let batchEnabled = true;
      for (const batch of translationBatches(request)) {
        options?.signal?.throwIfAborted();
        let restored = new Map<string, string>();
        if (batchEnabled && batch.length > 1) {
          try {
            const completion = await requestTranslationChunk(doFetch, config, request, batchPayload(batch), options?.signal, undefined, false, true, useDsh);
            if (completion.finishReason !== 'length') restored = restoreBatch(completion.content, batch);
          } catch (error) {
            options?.signal?.throwIfAborted();
            if (error instanceof TranslationError && (error.code === 'auth' || error.code === 'quota')) throw error;
          }
          // An unsupported batch format or outage should cost only one failed
          // batch per page before reverting to the established single path.
          if (!restored.size) batchEnabled = false;
        }
        for (const { id, protectedText } of batch) {
          options?.signal?.throwIfAborted();
          const hit = restored.get(id);
          if (hit !== undefined) {
            completedParagraphs.push(hit);
            options?.onPartial?.([...completedParagraphs]);
            continue;
          }
          const pending = splitTranslationChunks(protectedText.text).map((text) => ({ text, splitDepth: 0 }));
          const fragments: string[] = [];
          for (let index = 0; index < pending.length;) {
            const chunk = pending[index];
            let translated = '';
            let split = false;
            for (let repair = 0; repair < 2; repair++) {
              const completion = await requestTranslationChunk(doFetch, config, request, chunk.text, options?.signal,
                (content) => {
                  // A partial marker/formula must not reach the UI. Publish only
                  // snapshots that already contain the complete protected set.
                  try {
                    const partial = protectedText.restore(parseParagraphList(content, chunk.text).join('\n\n'), chunk.text);
                    options?.onPartial?.([...completedParagraphs, [...fragments, partial].join(' ')]);
                  } catch { /* Wait for the next complete stream snapshot. */ }
                }, repair > 0, false, useDsh);
              if (completion.finishReason === 'length') {
                const smaller = splitTranslationChunks(chunk.text, Math.max(400, Math.floor(chunk.text.length / 2)));
                if (chunk.splitDepth >= MAX_TRUNCATION_SPLITS || smaller.length < 2) {
                  throw new TranslationError('invalid_input', '翻译输出达到上限，已停止并且不会缓存残缺译文。');
                }
                pending.splice(index, 1, ...smaller.map((text) => ({ text, splitDepth: chunk.splitDepth + 1 })));
                split = true;
                break;
              }
              if (!completion.content.trim()) throw new TranslationError('server', '翻译服务未返回译文内容。');
              try {
                translated = protectedText.restore(parseParagraphList(completion.content, chunk.text).join('\n\n'), chunk.text);
                break;
              } catch {
                if (repair === 1) throw new TranslationError('invalid_output', describeTranslationError('invalid_output'));
              }
            }
            if (split) continue;
            fragments.push(translated);
            index++;
          }
          completedParagraphs.push(fragments.join(' '));
          options?.onPartial?.([...completedParagraphs]);
        }
      }
      options?.signal?.throwIfAborted();
      return {
        paragraphs: completedParagraphs,
        provider: providerId,
        model: config.model,
      };
    },
  };
}

interface CompletionResult {
  content: string;
  finishReason?: string;
}

async function requestTranslationChunk(
  doFetch: typeof fetch,
  config: OpenAICompatibleConfig,
  request: TranslationRequest,
  text: string,
  signal: AbortSignal | undefined,
  onPartial: ((content: string) => void) | undefined,
  repair = false,
  batch = false,
  useDsh = false,
): Promise<CompletionResult> {
  signal?.throwIfAborted();
  const timeout = new AbortController();
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(new DOMException('Translation timed out', 'TimeoutError')), config.requestTimeoutMs ?? 60_000);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(combined.reason);
    combined.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      performTranslationChunk(doFetch, config, request, text, combined,
        onPartial ? (content) => { if (!combined.aborted) onPartial(content); } : undefined, repair, batch, useDsh),
      aborted,
    ]);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TranslationError) throw error;
    throw new TranslationError('network', '网络不可用或请求超时。');
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', onAbort);
  }
}

async function performTranslationChunk(
  doFetch: typeof fetch,
  config: OpenAICompatibleConfig,
  request: TranslationRequest,
  text: string,
  signal: AbortSignal | undefined,
  onPartial: ((content: string) => void) | undefined,
  repair = false,
  batch = false,
  useDsh = false,
): Promise<CompletionResult> {
  const messages = [
    {
      role: 'system' as const,
      content: (batch ? BATCH_SYSTEM_PROMPT : SYSTEM_PROMPT) + glossaryPrompt(request.glossary, request.text) + (repair ? '\nYour previous output lost or changed protected placeholders. Correct this: copy all YYKEEP…ZZ markers exactly once, in order.' : ''),
    },
    {
      role: 'user' as const,
      content: [
        `Source language: ${request.sourceLanguage}`,
        `Target language: ${request.targetLanguage}`,
        `Page number: ${request.pageNumber}`,
        '---',
        text,
      ].join('\n'),
    },
  ];

  if (useDsh) {
    const completion = await requestChatCompletion(
      { ...config, executionBackend: 'dsh' },
      {
        messages,
        temperature: 0.1,
        maxTokens: recommendedMaxOutputTokens(text),
        // DSH translation is deliberately non-reasoning, matching the GLM
        // translation path and keeping output budget focused on the text.
        thinking: 'disabled',
        signal,
        onPartial,
      },
    );
    return {
      content: completion.content,
      finishReason: completion.finishReason ?? undefined,
    };
  }

  let response: Response;
  try {
    response = await doFetch(
      `${config.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.1,
          stream: true,
          max_tokens: recommendedMaxOutputTokens(text),
          ...(config.disableThinking ? { thinking: { type: 'disabled' } } : {}),
          messages,
        }),
      },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TranslationError('network', '网络不可用或请求超时。', undefined);
  }

  if (!response.ok) {
    const detail = await extractErrorDetail(response);
    throw new TranslationError(
      classifyHttpError(response.status),
      detail
        ? `翻译服务返回 ${response.status}：${detail}`
        : `翻译服务返回 ${response.status}。`,
      response.status,
    );
  }
  return readStreamingCompletion(response, onPartial, signal);
}

/** Reads an SSE chat-completions stream and retains its completion reason. */
async function readStreamingCompletion(
  response: Response,
  onPartial?: (content: string) => void,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const body = response.body;
  if (!body) {
    const payload = await response.json();
    return extractChoice(payload);
  }

  const reader = body.getReader();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason: string | undefined;
    let reported = '';

    const report = () => {
      if (!onPartial || content === reported) return;
      reported = content;
      onPartial(content);
    };
    const consumeLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]' || data.length === 0) return;
      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string };
            finish_reason?: string | null;
          }>;
        };
        const choice = chunk.choices?.[0];
        content += choice?.delta?.content ?? '';
        if (typeof choice?.finish_reason === 'string')
          finishReason = choice.finish_reason;
      } catch {
        // Ignore malformed events; complete SSE events are newline delimited.
      }
    };

    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n');
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf('\n');
        consumeLine(line);
      }
      report();
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) consumeLine(buffer);
    report();
    return { content, finishReason };
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function extractChoice(payload: unknown): CompletionResult {
  const choice = (
    payload as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string | null;
      }>;
    }
  )?.choices?.[0];
  return {
    content:
      typeof choice?.message?.content === 'string'
        ? choice.message.content
        : '',
    finishReason:
      typeof choice?.finish_reason === 'string'
        ? choice.finish_reason
        : undefined,
  };
}

function stripCodeFences(text: string): string {
  // Only remove an outer response wrapper; internal Markdown code is content.
  return text.replace(/^\s*```[ \t]*(?:translation|text|json)?[ \t]*\n([\s\S]*?)\n```\s*$/i, '$1');
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
export function parseParagraphList(
  content: string,
  sourceText: string,
): string[] {
  const cleaned = stripCodeFences(content.trim());

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { paragraphs?: unknown };
      if (Array.isArray(parsed.paragraphs)) {
        const paragraphs = parsed.paragraphs
          .filter(
            (paragraph): paragraph is string => typeof paragraph === 'string',
          )
          .map((paragraph) => paragraph.trim())
          .filter((paragraph) => paragraph.length > 0);
        if (paragraphs.length > 0) return paragraphs;
      }
    } catch {
      // fall through to plain-text handling
    }
  }

  const paragraphs = splitScientificParagraphs(cleaned)
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
      const sourceParagraphs = splitScientificParagraphs(request.text)
        .filter((part) => part.trim().length > 0);
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
