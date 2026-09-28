/** Text-only, application-owned request boundary. No paths, commands or tools. */
export interface DshCompletionRequest {
  requestId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  thinking: 'disabled' | 'default';
}
export interface DshCompletionResult {
  content: string;
  finishReason: 'stop' | 'length';
}
export interface DshProgress {
  requestId: string;
  content: string;
}
