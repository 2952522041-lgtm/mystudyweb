import {
  ChatError,
  classifyChatHttpError,
  describeChatError,
  extractErrorDetail,
} from './ai-errors.ts';

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
  fetchImpl?: typeof fetch;
}

export interface ChatCompletionInput {
  messages: ChatApiMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onPartial?: (content: string) => void;
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
  let response: Response;
  try {
    response = await (config.fetchImpl ?? fetch)(
      `${config.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        signal: input.signal,
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
        }),
      },
    );
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new ChatError('network', describeChatError('network'));
  }

  if (!response.ok) {
    const detail = await extractErrorDetail(response);
    const code = classifyChatHttpError(response.status);
    throw new ChatError(
      code,
      detail
        ? `AI 服务返回 ${response.status}：${detail}`
        : describeChatError(code),
      response.status,
    );
  }

  return readStreamingChatCompletion(response, input);
}

async function readStreamingChatCompletion(
  response: Response,
  input: ChatCompletionInput,
): Promise<ChatCompletionResult> {
  if (!response.body) {
    const payload = (await response.json()) as StreamedChatChunk;
    const choice = payload.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (content) input.onPartial?.(content);
    return { content, finishReason: choice?.finish_reason ?? null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason: string | null = null;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const chunk = JSON.parse(data) as StreamedChatChunk;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        input.onPartial?.(content);
      }
      const reason = chunk.choices?.[0]?.finish_reason;
      if (typeof reason === 'string') finishReason = reason;
    } catch {
      // Ignore malformed event lines without discarding later valid events.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) processLine(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) processLine(buffer);
  return { content, finishReason };
}

interface StreamedChatChunk {
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
}
