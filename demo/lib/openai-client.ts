import {
  ChatError,
  classifyChatHttpError,
  describeChatError,
  extractErrorDetail,
} from './ai-errors.ts';
import { requestDshCompletion } from './dsh-client.ts';
import type { DshStatus, DshTaskPriority } from './dsh-types.ts';

export type ChatApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ChatApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatApiContentPart[];
}

export interface ChatCompletionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Route this completion through the local DeepSeek Harness when selected. */
  executionBackend?: 'api' | 'dsh';
  fetchImpl?: typeof fetch;
  /** Disabled when omitted; applies while waiting for the response headers. */
  connectionTimeoutMs?: number;
  /** Disabled when omitted; applies to the initial and subsequent stream reads. */
  streamStallTimeoutMs?: number;
}

export type ChatCompletionTimingStatus = 'success' | 'failure' | 'cancelled';

/** Timing-only request diagnostics; this intentionally contains no request or response data. */
export interface ChatCompletionTiming {
  /** Milliseconds from request start until fetch resolves with response headers. */
  headersMs: number | null;
  /** Milliseconds from request start until the first non-empty content delta. */
  firstContentMs: number | null;
  /** Milliseconds from request start until the request settles. */
  totalMs: number;
  /** JavaScript string length of the accumulated output. */
  outputChars: number;
  status: ChatCompletionTimingStatus;
  queueMs?: number;
  startupMs?: number;
  executionMs?: number;
  retries?: number;
}

export interface ChatCompletionInput {
  task?: DshTaskPriority;
  timeoutMs?: number;
  onDshStatus?: (status: DshStatus) => void;
  backendOperation?: 'web-search';
  messages: ChatApiMessage[];
  temperature?: number;
  maxTokens?: number;
  thinking?: 'disabled';
  responseFormat?: 'json_object';
  signal?: AbortSignal;
  onPartial?: (content: string) => void;
  onTiming?: (timing: ChatCompletionTiming) => void;
  /** Optional per-request override; omitted means use the config value. */
  connectionTimeoutMs?: number;
  /** Optional per-request override; omitted means use the config value. */
  streamStallTimeoutMs?: number;
}

export interface ChatCompletionResult {
  content: string;
  finishReason: string | null;
}

/**
 * AI 答疑与知识库共用的 OpenAI 兼容 Chat Completions 请求：
 * 统一 SSE 流式解析、finish_reason 跟踪和错误分类，调用方只消费结构化结果。
 */
export async function requestChatCompletion(
  config: ChatCompletionConfig,
  input: ChatCompletionInput,
): Promise<ChatCompletionResult> {
  if (config.executionBackend === 'dsh') {
    return requestDshCompletion(config, input);
  }

  const startedAt = monotonicNow();
  const timing: MutableChatCompletionTiming = {
    headersMs: null,
    firstContentMs: null,
    totalMs: 0,
    outputChars: 0,
    status: 'failure',
  };
  const connectionTimeoutMs = normalizeTimeout(
    input.connectionTimeoutMs ?? config.connectionTimeoutMs,
  );
  const streamStallTimeoutMs = normalizeTimeout(
    input.streamStallTimeoutMs ?? config.streamStallTimeoutMs,
  );
  const abortRelay = createAbortRelay(
    input.signal,
    connectionTimeoutMs !== undefined || streamStallTimeoutMs !== undefined,
  );
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  const finishTiming = (status: ChatCompletionTimingStatus): void => {
    timing.status = status;
    timing.totalMs = elapsedMs(startedAt);
    abortRelay.cleanup();
    emitTiming(input.onTiming, timing);
  };

  let response: Response;
  try {
    const fetchSignal = abortRelay.signal;
    if (fetchSignal?.aborted) throw abortReason(fetchSignal);
    const fetchInit: RequestInit = {
      method: 'POST',
      signal: fetchSignal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens ?? 4096,
        messages: input.messages,
        ...(input.responseFormat
          ? { response_format: { type: input.responseFormat } }
          : {}),
        ...(input.thinking === 'disabled'
          ? { thinking: { type: 'disabled' } }
          : {}),
      }),
    };

    if (connectionTimeoutMs !== undefined) {
      connectionTimer = setTimeout(
        () => abortRelay.abortForTimeout('connection'),
        connectionTimeoutMs,
      );
    }

    const fetchPromise = Promise.resolve(
      (config.fetchImpl ?? fetch)(
        `${config.baseUrl.replace(/\/$/, '')}/chat/completions`,
        fetchInit,
      ),
    );
    response = await waitForAbort(fetchPromise, fetchSignal);
  } catch (error) {
    finishTiming(input.signal?.aborted ? 'cancelled' : 'failure');
    if (input.signal?.aborted) throw error;
    if (abortRelay.timedOut) {
      throw new ChatError('network', describeChatError('network'));
    }
    throw new ChatError('network', describeChatError('network'));
  } finally {
    if (connectionTimer !== undefined) clearTimeout(connectionTimer);
  }

  timing.headersMs = elapsedMs(startedAt);

  try {
    if (!response.ok) {
      const detail = await waitForStreamOperation(
        () => extractErrorDetail(response),
        streamStallTimeoutMs,
        abortRelay,
      );
      const code = classifyChatHttpError(response.status);
      throw new ChatError(
        code,
        detail
          ? `AI 服务返回 ${response.status}：${detail}`
          : describeChatError(code),
        response.status,
      );
    }

    const result = await readStreamingChatCompletion(
      response,
      input,
      timing,
      startedAt,
      streamStallTimeoutMs,
      abortRelay,
    );
    timing.status = 'success';
    return result;
  } catch (error) {
    timing.status = input.signal?.aborted ? 'cancelled' : 'failure';
    if (abortRelay.timedOut) {
      throw new ChatError('network', describeChatError('network'));
    }
    throw error;
  } finally {
    finishTiming(timing.status);
  }
}

async function readStreamingChatCompletion(
  response: Response,
  input: ChatCompletionInput,
  timing: MutableChatCompletionTiming,
  startedAt: number,
  streamStallTimeoutMs: number | undefined,
  abortRelay: AbortRelay,
): Promise<ChatCompletionResult> {
  if (!response.body) {
    const payload = (await waitForStreamOperation(
      () => response.json(),
      streamStallTimeoutMs,
      abortRelay,
    )) as StreamedChatChunk;
    const choice = payload.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (content) publishContent(content, input, timing, startedAt);
    return { content, finishReason: choice?.finish_reason ?? null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason: string | null = null;
  let completed = false;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const chunk = JSON.parse(data) as StreamedChatChunk;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        content = publishContent(delta, input, timing, startedAt, content);
      }
      const reason = chunk.choices?.[0]?.finish_reason;
      if (typeof reason === 'string') finishReason = reason;
    } catch {
      // Ignore malformed event lines without discarding later valid events.
    }
  };

  try {
    for (;;) {
      const { done, value } = await waitForStreamOperation(
        () => reader.read(),
        streamStallTimeoutMs,
        abortRelay,
      );
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
    completed = true;
    return { content, finishReason };
  } finally {
    if (!completed) {
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // The reader may already be closed or cancelled by the provider.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Releasing a provider-owned reader is best effort cleanup.
    }
  }
}

interface MutableChatCompletionTiming extends ChatCompletionTiming {
  status: ChatCompletionTimingStatus;
}

type TimeoutPhase = 'connection' | 'stream';

interface AbortRelay {
  signal?: AbortSignal;
  timedOut: TimeoutPhase | null;
  abortForTimeout(phase: TimeoutPhase): void;
  cleanup(): void;
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(monotonicNow() - startedAt));
}

function normalizeTimeout(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function createAbortRelay(
  externalSignal: AbortSignal | undefined,
  needsController: boolean,
): AbortRelay {
  if (!needsController) {
    return {
      signal: externalSignal,
      timedOut: null,
      abortForTimeout: () => {},
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  let timedOut: TimeoutPhase | null = null;
  let onExternalAbort: (() => void) | undefined;

  if (externalSignal) {
    onExternalAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(externalSignal.reason);
      }
    };
    if (externalSignal.aborted) onExternalAbort();
    else
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    abortForTimeout(phase) {
      if (controller.signal.aborted) return;
      timedOut = phase;
      controller.abort(new DOMException(`${phase} timeout`, 'TimeoutError'));
    },
    cleanup() {
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

async function waitForAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    throw abortReason(signal);
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException('The operation was aborted.', 'AbortError')
  );
}

async function waitForStreamOperation<T>(
  start: () => Promise<T>,
  timeoutMs: number | undefined,
  abortRelay: AbortRelay,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => abortRelay.abortForTimeout('stream'), timeoutMs);
  }
  try {
    const operation = Promise.resolve(start());
    return await waitForAbort(operation, abortRelay.signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function publishContent(
  delta: string,
  input: ChatCompletionInput,
  timing: MutableChatCompletionTiming,
  startedAt: number,
  content = '',
): string {
  if (!delta) return content;
  if (timing.firstContentMs === null) {
    timing.firstContentMs = elapsedMs(startedAt);
  }
  const nextContent = content + delta;
  timing.outputChars = nextContent.length;
  input.onPartial?.(nextContent);
  return nextContent;
}

function emitTiming(
  onTiming: ChatCompletionInput['onTiming'],
  timing: ChatCompletionTiming,
): void {
  if (!onTiming) return;
  try {
    onTiming({ ...timing });
  } catch {
    // Diagnostics must never alter the request result.
  }
}

interface StreamedChatChunk {
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
}
