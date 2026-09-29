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
}
export interface DshCompletionResult {
  content: string;
  finishReason: 'stop' | 'length';
}
export interface DshProgress {
  requestId: string;
  content: string;
}
