/** Application-owned request boundary. Inline images only; no paths or tools. */
export type DshContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };
export interface DshCompletionRequest {
  requestId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | DshContentPart[];
  }>;
  maxTokens: number;
  thinking: 'disabled' | 'default';
  /** Fixed provider tool, never an arbitrary URL or agent tool definition. */
  operation?: 'web-search';
  task?: DshTaskPriority;
  /** The pinned SDK rejects these explicitly instead of ignoring them. */
  temperature?: number;
  responseFormat?: 'json_object';
  /** Execution deadline; queue waiting has a separate bound. */
  timeoutMs?: number;
  /** Maximum delay to the first SDK event after runtime initialization. */
  connectionTimeoutMs?: number;
  streamStallTimeoutMs?: number;
}
export interface DshCompletionResult {
  content: string;
  finishReason: 'stop' | 'length';
}
export interface DshProgress {
  requestId: string;
  content: string;
  status?: DshStatus;
}
export type DshTaskPriority = 'interactive' | 'background' | 'prefetch';
export interface DshStatus {
  phase: 'queued' | 'starting' | 'running' | 'completed' | 'failed';
  task: DshTaskPriority;
  queueMs?: number;
  startupMs?: number;
  executionMs?: number;
  /** Automatic adapter retries are disabled; caller retries are independent. */
  retries: number;
}
export interface DshRuntimeStatus {
  available: boolean;
  expectedVersion: string;
  checkedAt: string;
  checks: Array<{ component: string; ok: boolean; version?: string }>;
  errorCode?: 'runtime_missing' | 'runtime_version';
}
