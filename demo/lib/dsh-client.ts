import { safeDshError } from './dsh-errors.ts';
import type {
  ChatCompletionConfig,
  ChatCompletionInput,
  ChatCompletionResult,
  ChatCompletionTiming,
} from './openai-client.ts';
import type {
  DshCompletionRequest,
  DshCompletionResult,
  DshProgress,
} from './dsh-types.ts';

/**
 * The small renderer-side surface exposed by Electron's preload script.
 *
 * Keeping this interface local means the browser bundle does not need to know
 * anything about Electron IPC, and also gives tests a way to provide a bridge
 * without mutating the global `window` object.
 */
export interface DshBridge {
  runDsh(request: DshCompletionRequest): Promise<DshCompletionResult>;
  cancelDsh(requestId: string): Promise<void>;
  onDshProgress(listener: (progress: DshProgress) => void): () => void;
}

const DEFAULT_MAX_TOKENS = 4096;
const CANCEL_SETTLE_TIMEOUT_MS = 250;

const DSH_UNAVAILABLE_MESSAGE =
  '当前环境不支持桌面 DSH，请使用页语桌面版后重试。';
const DSH_TEXT_ONLY_MESSAGE =
  'DSH 仅接受文字或内嵌 PNG/JPEG 图片，不接受远程图片地址。';
const DSH_REQUEST_FAILED_MESSAGE = 'DSH 服务请求失败，请稍后重试。';
const DSH_INITIALIZATION_FAILED_MESSAGE = 'DSH 请求初始化失败，请稍后重试。';

type DshClientErrorKind = 'input' | 'unavailable' | 'failure';

class DshClientError extends Error {
  readonly kind: DshClientErrorKind;

  constructor(kind: DshClientErrorKind, message: string) {
    super(message);
    this.name = 'DshClientError';
    this.kind = kind;
  }
}

/**
 * Run a text/image completion or fixed search tool through the desktop bridge.
 *
 * The optional bridge argument is intentionally only an injection seam for
 * tests and internal callers.  Production callers use `window.yeyuDesktop`.
 * There is deliberately no HTTP/API fallback when the bridge is absent.
 */
export async function requestDshCompletion(
  config: ChatCompletionConfig,
  input: ChatCompletionInput,
  bridge?: DshBridge | null,
): Promise<ChatCompletionResult> {
  const startedAt = monotonicNow();
  const timing: MutableDshTiming = {
    headersMs: null,
    firstContentMs: null,
    totalMs: 0,
    outputChars: 0,
    status: 'failure',
  };

  let settled = false;
  let finalContent: string | undefined;
  let latestContent = '';
  let requestId: string | undefined;
  let runStarted = false;
  let runCompleted = false;
  let cancelRequested = false;
  let cancelOperation: Promise<void> | undefined;
  let unsubscribeProgress: (() => void) | undefined;
  let removeAbortListener: (() => void) | undefined;

  const emitTiming = (status: DshTimingStatus): void => {
    timing.status = status;
    timing.outputChars = (finalContent ?? latestContent).length;
    timing.totalMs = elapsedMs(startedAt);
    try {
      input.onTiming?.({ ...timing });
    } catch {
      // Timing is diagnostic only and must never affect the request result.
    }
  };

  let status: DshTimingStatus = 'failure';

  try {
    if (input.signal?.aborted) {
      status = 'cancelled';
      throw createAbortError();
    }

    const messages = toTextMessages(input);
    const resolvedBridge = resolveBridge(bridge);
    if (!resolvedBridge) {
      throw new DshClientError('unavailable', DSH_UNAVAILABLE_MESSAGE);
    }

    requestId = createRequestId();
    const request: DshCompletionRequest = {
      requestId,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: input.thinking ?? 'default',
      ...(input.backendOperation ? { operation: input.backendOperation } : {}),
      ...(input.task ? { task: input.task } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...((input.connectionTimeoutMs ?? config.connectionTimeoutMs) !== undefined ? { connectionTimeoutMs: input.connectionTimeoutMs ?? config.connectionTimeoutMs } : {}),
      ...((input.streamStallTimeoutMs ?? config.streamStallTimeoutMs) !== undefined ? { streamStallTimeoutMs: input.streamStallTimeoutMs ?? config.streamStallTimeoutMs } : {}),
    };

    const onProgress = (progress: DshProgress): void => {
      if (
        settled ||
        cancelRequested ||
        !requestId ||
        !progress ||
        progress.requestId !== requestId ||
        typeof progress.content !== 'string'
      ) {
        return;
      }

      if (progress.status) {
        for (const key of ['queueMs', 'startupMs', 'executionMs', 'retries'] as const) {
          const value = progress.status[key];
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) timing[key] = value;
        }
        try { input.onDshStatus?.(progress.status); } catch { /* observer only */ }
        if (!progress.content) return;
      }
      const content = progress.content;
      latestContent = content;
      if (content && timing.firstContentMs === null) {
        timing.firstContentMs = elapsedMs(startedAt);
      }
      try {
        input.onPartial?.(content);
      } catch {
        // A renderer listener is user-interface code; it cannot fail DSH.
      }
    };

    let abortReject: ((reason: unknown) => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortReject = reject;
    });

    const startCancellation = (): Promise<void> => {
      if (cancelOperation) return cancelOperation;
      if (!runStarted || runCompleted || !requestId) {
        cancelOperation = Promise.resolve();
        return cancelOperation;
      }
      cancelOperation = cancelDshWithBound(
        resolvedBridge,
        requestId,
        CANCEL_SETTLE_TIMEOUT_MS,
      );
      return cancelOperation;
    };

    const onAbort = (): void => {
      if (settled || cancelRequested || runCompleted) return;
      cancelRequested = true;
      const cancellation = startCancellation();
      if (runStarted) {
        void cancellation.then(
          () => abortReject?.(createAbortError()),
          () => abortReject?.(createAbortError()),
        );
      }
    };

    if (input.signal) {
      input.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () =>
        input.signal?.removeEventListener('abort', onAbort);
      if (input.signal.aborted) onAbort();
    }

    // Progress registration is intentionally before runDsh.  Each request
    // keeps its own listener and ignores events from all other request IDs.
    unsubscribeProgress = resolvedBridge.onDshProgress(onProgress);

    if (cancelRequested || input.signal?.aborted) {
      status = 'cancelled';
      throw createAbortError();
    }

    runStarted = true;
    const runPromise = Promise.resolve(resolvedBridge.runDsh(request)).then(
      (result) => {
        runCompleted = true;
        return result;
      },
      (error: unknown) => {
        runCompleted = true;
        throw error;
      },
    );

    const result = input.signal
      ? await Promise.race([runPromise, abortPromise])
      : await runPromise;

    if (cancelRequested || input.signal?.aborted) {
      status = 'cancelled';
      throw createAbortError();
    }

    if (
      !result ||
      typeof result.content !== 'string' ||
      (result.finishReason !== 'stop' && result.finishReason !== 'length')
    ) {
      throw new DshClientError('failure', DSH_REQUEST_FAILED_MESSAGE);
    }

    finalContent = result.content;
    latestContent = result.content;
    if (result.content && timing.firstContentMs === null) {
      timing.firstContentMs = elapsedMs(startedAt);
    }
    status = 'success';
    return {
      content: result.content,
      finishReason: result.finishReason,
    };
  } catch (error) {
    if (status === 'cancelled' || cancelRequested || input.signal?.aborted) {
      status = 'cancelled';
      throw createAbortError();
    }
    status = 'failure';
    if (error instanceof DshClientError) throw error;
    // Never expose bridge errors: the main process may have included an API
    // key, prompt, or provider response in the original error message.
    throw safeDshError(error);
  } finally {
    settled = true;
    removeAbortListener?.();
    try {
      unsubscribeProgress?.();
    } catch {
      // Listener cleanup is best effort and cannot change the outcome.
    }
    emitTiming(status);
  }
}

function toTextMessages(
  input: ChatCompletionInput,
): DshCompletionRequest['messages'] {
  if (!Array.isArray(input.messages)) {
    throw new DshClientError('input', DSH_REQUEST_FAILED_MESSAGE);
  }

  return input.messages.map((message) => {
    if (
      !message ||
      (message.role !== 'system' &&
        message.role !== 'user' &&
        message.role !== 'assistant')
    ) {
      throw new DshClientError('input', DSH_REQUEST_FAILED_MESSAGE);
    }
    if (
      typeof message.content !== 'string' &&
      (!Array.isArray(message.content) ||
        !message.content.every((part) =>
          part?.type === 'text'
            ? typeof part.text === 'string'
            : part?.type === 'image_url' &&
              message.role === 'user' &&
              isInlineImage(part.image_url?.url),
        ))
    )
      throw new DshClientError('input', DSH_TEXT_ONLY_MESSAGE);
    return { role: message.role, content: message.content };
  });
}

function isInlineImage(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    url,
  );
  return Boolean(
    match &&
    match[2].length <= 8_000_000 &&
    match[2].length % 4 === 0 &&
    (match[1] === 'png'
      ? match[2].startsWith('iVBORw0KGgo')
      : match[2].startsWith('/9j/')),
  );
}

function resolveBridge(
  injected: DshBridge | null | undefined,
): DshBridge | undefined {
  if (injected !== undefined)
    return isDshBridge(injected) ? injected : undefined;
  if (typeof window === 'undefined') return undefined;
  const candidate = (window as unknown as { yeyuDesktop?: unknown })
    .yeyuDesktop;
  return isDshBridge(candidate) ? candidate : undefined;
}

function isDshBridge(value: unknown): value is DshBridge {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false;
  }
  const candidate = value as Partial<DshBridge>;
  return (
    typeof candidate.runDsh === 'function' &&
    typeof candidate.cancelDsh === 'function' &&
    typeof candidate.onDshProgress === 'function'
  );
}

function createRequestId(): string {
  try {
    const cryptoObject = globalThis.crypto;
    if (typeof cryptoObject?.randomUUID !== 'function') {
      throw new Error('missing randomUUID');
    }
    return cryptoObject.randomUUID();
  } catch {
    throw new DshClientError('failure', DSH_INITIALIZATION_FAILED_MESSAGE);
  }
}

async function cancelDshWithBound(
  bridge: DshBridge,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  const cancellation = Promise.resolve()
    .then(() => bridge.cancelDsh(requestId))
    .catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([cancellation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createAbortError(): DOMException {
  return new DOMException('请求已取消。', 'AbortError');
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(monotonicNow() - startedAt));
}

type DshTimingStatus = 'success' | 'failure' | 'cancelled';

interface MutableDshTiming extends ChatCompletionTiming {
  status: DshTimingStatus;
}
