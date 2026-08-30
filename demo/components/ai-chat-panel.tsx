'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  CircleAlert,
  Eye,
  LoaderCircle,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Message, MessageContent, MessageGroup } from '@/components/ui/message';
import { Textarea } from '@/components/ui/textarea';
import {
  ChatError,
  describeChatError,
  type ChatErrorCode,
  type ChatMessage,
} from '@/lib/chat';
import {
  chatSettingsConfigured,
  createChatProviderForSettings,
  createChatService,
  type ChatSettings,
} from '@/lib/chat-cache';
import type { PDFDocumentProxy } from '@/lib/pdfjs';
import { extractPageText, renderPageImage } from '@/lib/page-vision';

interface PageChatState {
  loaded: boolean;
  messages: ChatMessage[];
  status: 'idle' | 'preparing' | 'generating' | 'error';
  partial?: string;
  errorCode?: ChatErrorCode;
  errorMessage?: string;
}

const QUICK_QUESTIONS = [
  '总结这一页',
  '用简单语言解释',
  '解释本页公式',
  '解读图片或图表',
] as const;

const emptyState = (): PageChatState => ({
  loaded: false,
  messages: [],
  status: 'idle',
});

function chatStateKey(fingerprint: string, pageNumber: number): string {
  return `${fingerprint}:${pageNumber}`;
}

function messageId(role: 'user' | 'assistant'): string {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function MarkdownAnswer({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children: linkChildren, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener">
            {linkChildren}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export function AIChatPanel({
  pdfDoc,
  fingerprint,
  pageNumber,
  settings,
  onOpenSettings,
}: {
  pdfDoc: PDFDocumentProxy | null;
  fingerprint: string | null;
  pageNumber: number;
  settings: ChatSettings;
  onOpenSettings: () => void;
}) {
  const service = useMemo(() => createChatService(), []);
  const [states, setStates] = useState<Record<string, PageChatState>>({});
  const [input, setInput] = useState('');
  const controllersRef = useRef(new Map<string, AbortController>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const key = fingerprint ? chatStateKey(fingerprint, pageNumber) : '';
  const state = (key && states[key]) || emptyState();
  const configured = chatSettingsConfigured(settings);

  useEffect(() => {
    if (!fingerprint) return;
    let cancelled = false;
    const load = async () => {
      const conversation = await service.load(fingerprint, pageNumber);
      if (cancelled) return;
      const stateKey = chatStateKey(fingerprint, pageNumber);
      setStates((previous) => {
        if (previous[stateKey]) return previous;
        return {
          ...previous,
          [stateKey]: {
            loaded: true,
            messages: conversation?.messages ?? [],
            status: 'idle',
          },
        };
      });
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [fingerprint, pageNumber, service]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const scroll = scrollRef.current;
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [state.messages, state.partial]);

  useEffect(
    () => () => {
      for (const controller of controllersRef.current.values())
        controller.abort();
      controllersRef.current.clear();
    },
    [],
  );

  const updateState = (
    stateKey: string,
    update: (previous: PageChatState) => PageChatState,
  ) => {
    setStates((previous) => ({
      ...previous,
      [stateKey]: update(previous[stateKey] ?? emptyState()),
    }));
  };

  const sendQuestion = async (rawQuestion: string, retry = false) => {
    const question = rawQuestion.trim();
    if (!question || !pdfDoc || !fingerprint || !key) return;
    if (!configured) {
      updateState(key, (previous) => ({
        ...previous,
        loaded: true,
        status: 'error',
        errorCode: 'auth',
        errorMessage: '请先配置独立的 AI 答疑接口、API Key 和视觉模型。',
      }));
      onOpenSettings();
      return;
    }

    const history =
      retry && state.messages.at(-1)?.role === 'user'
        ? state.messages.slice(0, -1)
        : state.messages;
    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: messageId('user'),
      role: 'user',
      content: question,
      createdAt: now,
    };
    const pendingMessages = [...history, userMessage];
    updateState(key, () => ({
      loaded: true,
      messages: pendingMessages,
      status: 'preparing',
    }));
    setInput('');

    const controller = new AbortController();
    controllersRef.current.set(key, controller);
    try {
      const [pageText, pageImage] = await Promise.all([
        extractPageText(pdfDoc, pageNumber),
        renderPageImage(pdfDoc, pageNumber, { signal: controller.signal }),
      ]);
      const provider = createChatProviderForSettings(settings);
      const result = await provider.answer(
        {
          fingerprint,
          pageNumber,
          pageText,
          pageImage,
          messages: history,
          question,
        },
        {
          signal: controller.signal,
          onPartial: (content) =>
            updateState(key, (previous) => ({
              ...previous,
              status: 'generating',
              partial: content,
              errorCode: undefined,
              errorMessage: undefined,
            })),
        },
      );
      const completedAt = new Date().toISOString();
      const assistantMessage: ChatMessage = {
        id: messageId('assistant'),
        role: 'assistant',
        content: result.content,
        createdAt: completedAt,
      };
      const completedMessages = [...pendingMessages, assistantMessage];
      updateState(key, () => ({
        loaded: true,
        messages: completedMessages,
        status: 'idle',
      }));
      await service.save({
        fingerprint,
        pageNumber,
        messages: completedMessages,
        createdAt: state.messages[0]?.createdAt ?? now,
        updatedAt: completedAt,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        updateState(key, (previous) => ({
          ...previous,
          status: 'idle',
          partial: undefined,
        }));
        return;
      }
      const code = error instanceof ChatError ? error.code : 'unknown';
      updateState(key, (previous) => ({
        ...previous,
        status: 'error',
        partial: undefined,
        errorCode: code,
        errorMessage:
          error instanceof ChatError ? error.message : describeChatError(code),
      }));
    } finally {
      controllersRef.current.delete(key);
    }
  };

  const stop = () => controllersRef.current.get(key)?.abort();

  const clear = async () => {
    if (!fingerprint || !key) return;
    controllersRef.current.get(key)?.abort();
    await service.delete(fingerprint, pageNumber);
    updateState(key, () => ({ loaded: true, messages: [], status: 'idle' }));
  };

  const retryLast = () => {
    const lastUser = [...state.messages]
      .reverse()
      .find((message) => message.role === 'user');
    if (lastUser) void sendQuestion(lastUser.content, true);
  };

  const generating =
    state.status === 'preparing' || state.status === 'generating';

  return (
    <section
      className="ai-chat-panel"
      aria-label={`第 ${pageNumber} 页 AI 答疑`}
    >
      <div className="ai-context-bar">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700">
            <Eye className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-800">
              正在基于第 {pageNumber} 页
            </p>
            <p className="truncate text-[11px] text-slate-500">
              结合本页文字、图片、图表与公式回答
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="AI 答疑设置"
            onClick={onOpenSettings}
          >
            <Settings2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="清空本页对话"
            onClick={() => void clear()}
            disabled={state.messages.length === 0 && !generating}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="ai-message-scroll">
        {!pdfDoc ? (
          <div className="ai-empty-state">
            <Bot className="size-6 text-slate-400" />
            <p className="text-sm font-semibold text-slate-800">
              AI 答疑将在这里开始
            </p>
            <p className="max-w-xs text-xs leading-5 text-slate-500">
              导入 PDF 后，可以针对当前页的文字、图片和公式提问。
            </p>
          </div>
        ) : state.messages.length === 0 && !generating ? (
          <div className="ai-chat-welcome">
            <span className="flex size-10 items-center justify-center rounded-2xl bg-violet-100 text-violet-700">
              <Sparkles className="size-5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-slate-800">
                这页哪里没看懂？
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                发送问题后才会将第 {pageNumber} 页文字和图像交给 AI。
              </p>
            </div>
            <div className="mt-2 grid w-full max-w-md grid-cols-2 gap-2">
              {QUICK_QUESTIONS.map((question) => (
                <Button
                  key={question}
                  variant="outline"
                  size="sm"
                  className="h-auto justify-start whitespace-normal py-2 text-left text-xs"
                  onClick={() => void sendQuestion(question)}
                >
                  {question}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <MessageGroup className="gap-5">
            {state.messages.map((message) => (
              <Message
                key={message.id}
                align={message.role === 'user' ? 'end' : 'start'}
              >
                <MessageContent>
                  <Bubble
                    align={message.role === 'user' ? 'end' : 'start'}
                    variant={message.role === 'user' ? 'tinted' : 'ghost'}
                  >
                    <BubbleContent
                      className={
                        message.role === 'assistant' ? 'ai-markdown' : undefined
                      }
                    >
                      {message.role === 'assistant' ? (
                        <MarkdownAnswer>{message.content}</MarkdownAnswer>
                      ) : (
                        message.content
                      )}
                    </BubbleContent>
                  </Bubble>
                </MessageContent>
              </Message>
            ))}

            {generating ? (
              <Message align="start">
                <MessageContent>
                  <Bubble variant="ghost">
                    <BubbleContent className="ai-markdown">
                      {state.partial ? (
                        <MarkdownAnswer>{state.partial}</MarkdownAnswer>
                      ) : (
                        <p className="flex items-center gap-2 text-xs text-violet-700">
                          <LoaderCircle className="size-3.5 animate-spin" />
                          正在读取第 {pageNumber} 页的文字与视觉内容…
                        </p>
                      )}
                    </BubbleContent>
                  </Bubble>
                </MessageContent>
              </Message>
            ) : null}

            {state.status === 'error' ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-xs text-rose-700">
                <p className="flex items-start gap-2 leading-5">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  {state.errorMessage}
                </p>
                <div className="mt-2 flex gap-2">
                  {state.messages.some((message) => message.role === 'user') ? (
                    <Button size="sm" variant="outline" onClick={retryLast}>
                      <RotateCcw />
                      重试
                    </Button>
                  ) : null}
                  {!configured ? (
                    <Button size="sm" onClick={onOpenSettings}>
                      配置 AI 服务
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </MessageGroup>
        )}
      </div>

      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!generating) void sendQuestion(input);
        }}
      >
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (!generating) void sendQuestion(input);
            }
          }}
          placeholder={
            pdfDoc ? `向 AI 提问第 ${pageNumber} 页…` : '请先导入 PDF'
          }
          disabled={!pdfDoc}
          className="max-h-32 min-h-20 resize-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
          aria-label="AI 答疑输入"
        />
        <div className="flex items-center justify-between border-t border-slate-200 pt-2">
          <p className="text-[10px] text-slate-400">
            {configured
              ? `视觉模型 · ${settings.model}`
              : '尚未配置独立 AI 服务'}
          </p>
          {generating ? (
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="停止回答"
              onClick={stop}
            >
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon-sm"
              aria-label="发送问题"
              disabled={!pdfDoc || !input.trim()}
            >
              <Send />
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
