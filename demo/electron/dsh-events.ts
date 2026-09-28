/**
 * Small, side-effect-free collector for the DSH SDK notification stream.
 *
 * The SDK's `subscribeSessionTree()` stream is broader than one prompt: it
 * includes notifications for the session before the prompt's inbox entry is
 * committed, and `session.status: idle` is only an agent lifecycle marker.
 * The collector therefore starts at the matching `agent/inbox/spliced` receipt
 * and accepts a result only after a durable turn ending or an explicit final
 * stream finish.
 */

export interface DshNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface DshEventResult {
  content: string;
  finishReason: 'stop' | 'length';
}

type Terminal = 'stop' | 'length' | 'error';

// Keep every parser failure deliberately static. In particular, never include
// provider error text, raw event data, partial output, or request credentials.
const DSH_RESULT_ERROR = 'DSH 任务未完整完成。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}

/**
 * Normalize the finish vocabulary used by `dsh-llm` and by the session
 * `turn/end` reason. `tool-calls` is a step boundary, not a completed turn.
 * `undefined` means that no terminal reason was present.
 */
function finishKind(value: unknown): Terminal | 'tool-calls' | 'unknown' | undefined {
  const candidate = isRecord(value) ? value.kind ?? value.reason : value;
  if (typeof candidate !== 'string') return undefined;

  switch (candidate) {
    case 'completed':
    case 'stop':
      return 'stop';
    case 'max-tokens':
    case 'max_tokens':
    case 'length':
      return 'length';
    case 'tool-calls':
    case 'tool_calls':
      return 'tool-calls';
    case 'error':
    case 'aborted':
    case 'blocked':
    case 'interrupted':
    case 'forked':
      return 'error';
    default:
      return 'unknown';
  }
}

function outputIdentity(data: Record<string, unknown>): string | undefined {
  const turn = asFiniteNumber(data.turn);
  const step = asFiniteNumber(data.step);
  if (turn === undefined && step === undefined) return undefined;
  return `${turn ?? ''}:${step ?? ''}`;
}

function visibleText(content: unknown): { text: string; malformed: boolean } {
  if (!Array.isArray(content)) return { text: '', malformed: true };

  let text = '';
  for (const block of content) {
    if (!isRecord(block)) return { text: '', malformed: true };
    if (block.type === 'reasoning') continue;
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return { text: '', malformed: true };
      text += block.text;
    }
  }
  return { text, malformed: false };
}

function hasToolCall(content: unknown): boolean {
  return Array.isArray(content)
    && content.some((block) => isRecord(block) && block.type === 'tool-call');
}

type StreamObservation = {
  finish?: Terminal | 'tool-calls' | 'unknown';
  sawToolCall: boolean;
};

function observeStreamChunk(chunk: unknown): StreamObservation {
  if (!isRecord(chunk) || typeof chunk.type !== 'string') {
    return { sawToolCall: false, finish: 'unknown' };
  }
  if (chunk.type === 'finish') {
    return { sawToolCall: false, finish: finishKind(chunk.reason) ?? 'unknown' };
  }
  if (chunk.type === 'tool-call-delta') return { sawToolCall: true };
  return { sawToolCall: false };
}

/**
 * Read only the terminal marker from a compact assistant stream. Text deltas
 * are intentionally not projected here when an assistant/message is present:
 * the durable message is authoritative and prevents delta/message duplication.
 */
function streamObservation(stream: unknown): StreamObservation {
  if (!Array.isArray(stream)) return { sawToolCall: false };

  let sawToolCall = false;
  let finish: StreamObservation['finish'];
  for (const record of stream) {
    if (!isRecord(record)) return { sawToolCall, finish: 'unknown' };

    if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
      if (!Array.isArray(record.texts) || record.texts.some((text) => typeof text !== 'string')) {
        return { sawToolCall, finish: 'unknown' };
      }
      continue;
    }
    if (record.type === 'tool-call-chunks') {
      sawToolCall = true;
      if (!Array.isArray(record.args) || record.args.some((text) => typeof text !== 'string')) {
        return { sawToolCall, finish: 'unknown' };
      }
      continue;
    }
    if (record.type === 'chunk') {
      const result = observeStreamChunk(record.chunk);
      sawToolCall ||= result.sawToolCall;
      if (result.finish !== undefined) finish = result.finish;
      continue;
    }

    // A raw StreamChunk array is not the current durable shape, but accepting
    // it costs no trust: only its validated finish marker is meaningful here.
    if (typeof record.type === 'string' && record.type.endsWith('-delta')) {
      sawToolCall ||= record.type === 'tool-call-delta';
      continue;
    }
    if (record.type === 'finish') {
      const result = observeStreamChunk(record);
      if (result.finish !== undefined) finish = result.finish;
      continue;
    }
    return { sawToolCall, finish: 'unknown' };
  }
  return { sawToolCall, finish };
}

function error(): Error {
  return new Error(DSH_RESULT_ERROR);
}

/** Collect one prompt's visible DSH result without performing any I/O. */
export class DshEventCollector {
  private readonly sessionId: string;
  private readonly messageId: string;
  private receiptSeen = false;
  private terminal: Terminal | undefined;
  private targetTurn: number | undefined;
  private outputIdentity: string | undefined;
  private outputFromMessage = false;
  private output = '';
  private sawToolCall = false;

  constructor(sessionId: string, messageId: string) {
    this.sessionId = sessionId;
    this.messageId = messageId;
  }

  /** Visible assistant text only; reasoning blocks are never returned. */
  get content(): string {
    return this.output;
  }

  /** True once a final success or failure has been observed. */
  get done(): boolean {
    return this.terminal !== undefined;
  }

  /** Feed one raw SDK notification. Unrelated session-tree events are ignored. */
  observe(notification: DshNotification): void {
    if (this.done || !isRecord(notification) || typeof notification.method !== 'string') return;
    const params = asRecord(notification.params);
    if (!params) return;

    if (notification.method === 'session.event') {
      if (params.sessionId !== this.sessionId) return;
      this.observeSessionEvent(params.event);
      return;
    }

    if (notification.method === 'session.status') {
      if (params.sessionId !== this.sessionId || !this.receiptSeen) return;
      // `idle` is deliberately not terminal: the SDK documents it as the
      // whole-agent lifecycle state, not a per-prompt result.
      if (params.status !== undefined && params.status !== 'idle' && params.status !== 'running') {
        this.terminal = 'error';
      }
      return;
    }

    // These are not emitted by the current SDK server, but if a deployment
    // exposes an explicit session-scoped error, fail closed without echoing it.
    if (notification.method === 'session.error' || notification.method === 'error') {
      if (params.sessionId === this.sessionId && this.receiptSeen) this.terminal = 'error';
    }
  }

  result(): DshEventResult {
    if (!this.done || (this.terminal !== 'stop' && this.terminal !== 'length')) {
      throw error();
    }
    // Reasoning may exhaust the limit before any visible text. Preserve length
    // so the application can split/retry; this is not a successful empty answer.
    if (this.output.trim().length === 0 && this.terminal !== 'length') throw error();
    return { content: this.output, finishReason: this.terminal };
  }

  private observeSessionEvent(rawEvent: unknown): void {
    const event = asRecord(rawEvent);
    if (!event || typeof event.type !== 'string') return;

    if (!this.receiptSeen) {
      if (event.type !== 'agent/inbox/spliced') return;
      const data = asRecord(event.data);
      const inserted = data?.inserted;
      if (!Array.isArray(inserted)) return;
      if (inserted.some((message) => isRecord(message) && message.id === this.messageId)) {
        this.receiptSeen = true;
      }
      return;
    }

    const data = asRecord(event.data) ?? {};
    if (!this.acceptsTurn(data, event.type)) return;

    switch (event.type) {
      case 'turn/start':
        return;
      case 'assistant/message':
        this.observeAssistantMessage(data);
        return;
      case 'assistant/chunk':
        this.observeAssistantChunk(data);
        return;
      case 'assistant/attempt':
        // An attempt is explicitly non-surface and may be retried. Its stream
        // is useful for detecting a malformed protocol, but must not become a
        // successful result or stop a later retry before turn/end.
        this.observeAttempt(data);
        return;
      case 'turn/end':
        this.observeTurnEnd(data);
        return;
      default:
        return;
    }
  }

  private acceptsTurn(data: Record<string, unknown>, type: string): boolean {
    const turn = asFiniteNumber(data.turn);
    if (turn !== undefined) {
      if (this.targetTurn === undefined) {
        this.targetTurn = turn;
      } else if (this.targetTurn !== turn) {
        return false;
      }
    } else if (type !== 'agent/inbox/spliced' && this.targetTurn !== undefined) {
      // Handlers for durable events normally carry turn/step. Keeping
      // keyless fixtures accepted is useful for protocol adapters, but once a
      // numbered turn is known they cannot close a different numbered turn.
      return true;
    }
    return true;
  }

  private switchOutput(identity: string | undefined): void {
    if (identity !== this.outputIdentity) {
      this.outputIdentity = identity;
      this.outputFromMessage = false;
      this.output = '';
      this.sawToolCall = false;
    }
  }

  private observeAssistantMessage(data: Record<string, unknown>): void {
    const message = asRecord(data.message);
    if (!message) {
      this.terminal = 'error';
      return;
    }
    const projected = visibleText(message.content);
    if (projected.malformed) {
      this.terminal = 'error';
      return;
    }

    const identity = outputIdentity(data);
    this.switchOutput(identity);
    this.output = projected.text;
    this.outputFromMessage = true;
    this.sawToolCall ||= hasToolCall(message.content);

    if (data.interrupted === true) {
      this.terminal = 'error';
      return;
    }

    const stream = streamObservation(data.stream);
    this.sawToolCall ||= stream.sawToolCall;
    this.observeExplicitFinish(stream.finish, this.sawToolCall);
    if (this.done) return;

    const directFinish = finishKind(data.finishReason ?? data.finish_reason);
    this.observeExplicitFinish(directFinish, this.sawToolCall);
  }

  private observeAssistantChunk(data: Record<string, unknown>): void {
    const identity = outputIdentity(data);
    const chunk = asRecord(data.chunk);
    if (!chunk || typeof chunk.type !== 'string') {
      this.terminal = 'error';
      return;
    }
    this.switchOutput(identity);

    switch (chunk.type) {
      case 'text-delta':
        if (typeof chunk.text !== 'string') {
          this.terminal = 'error';
          return;
        }
        if (!this.outputFromMessage) this.output += chunk.text;
        break;
      case 'reasoning-delta':
        if (typeof chunk.text !== 'string') this.terminal = 'error';
        break;
      case 'tool-call-delta':
        this.sawToolCall = true;
        break;
      case 'finish':
        this.observeExplicitFinish(finishKind(chunk.reason), this.sawToolCall);
        break;
      default:
        // block-start/end and usage are valid stream records but carry no
        // user-visible final text by themselves.
        break;
    }
  }

  private observeAttempt(data: Record<string, unknown>): void {
    const stream = streamObservation(data.stream);
    if (stream.finish === 'unknown') this.terminal = 'error';
  }

  private observeTurnEnd(data: Record<string, unknown>): void {
    const reason = data.reason ?? data.finishReason ?? data.finish_reason;
    const terminal = finishKind(reason);
    if (terminal === undefined || terminal === 'tool-calls' || terminal === 'unknown') {
      this.terminal = 'error';
      return;
    }
    this.terminal = terminal;
  }

  private observeExplicitFinish(
    finish: Terminal | 'tool-calls' | 'unknown' | undefined,
    sawToolCall: boolean,
  ): void {
    if (finish === undefined || finish === 'tool-calls') return;
    if (finish === 'unknown') {
      this.terminal = 'error';
      return;
    }
    // A stop finish after a tool call closes only that model step; the later
    // tool result and next assistant message still belong to this turn.
    if (finish === 'stop' && sawToolCall) return;
    this.terminal = finish;
  }
}
