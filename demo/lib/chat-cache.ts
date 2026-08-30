import { createIndexedDBStore, type KVStore } from './reader-cache.ts';
import {
  createOpenAICompatibleChatProvider,
  type ChatMessage,
  type ChatProvider,
} from './chat.ts';

export interface ChatSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4.1-mini',
};

const CHAT_SETTINGS_STORAGE_KEY = 'pdf-reader-chat-settings';
const CHAT_KEY_PREFIX = 'chat:';

export function validateChatSettings(settings: ChatSettings): string | null {
  try {
    const url = new URL(settings.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '请输入有效的 HTTP(S) AI 接口地址。';
    }
  } catch {
    return '请输入有效的 HTTP(S) AI 接口地址。';
  }
  if (settings.apiKey.trim().length === 0) return '请输入 AI 答疑 API Key。';
  if (settings.model.trim().length === 0)
    return '请输入支持视觉输入的模型名称。';
  return null;
}

export function chatSettingsConfigured(settings: ChatSettings): boolean {
  return validateChatSettings(settings) === null;
}

export function loadChatSettings(
  storage: Pick<Storage, 'getItem'> = localStorage,
): ChatSettings {
  try {
    const raw = storage.getItem(CHAT_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CHAT_SETTINGS };
    return {
      ...DEFAULT_CHAT_SETTINGS,
      ...(JSON.parse(raw) as Partial<ChatSettings>),
    };
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS };
  }
}

export function saveChatSettings(
  settings: ChatSettings,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(CHAT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function createChatProviderForSettings(
  settings: ChatSettings,
): ChatProvider {
  if (!chatSettingsConfigured(settings)) {
    throw new Error('AI chat settings are incomplete');
  }
  return createOpenAICompatibleChatProvider({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey.trim(),
    model: settings.model.trim(),
  });
}

export interface PageConversation {
  fingerprint: string;
  pageNumber: number;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export function pageConversationKey(
  fingerprint: string,
  pageNumber: number,
): string {
  return `${CHAT_KEY_PREFIX}${fingerprint}:${pageNumber}`;
}

export function createConversationStore(store: KVStore<PageConversation>) {
  return {
    async load(
      fingerprint: string,
      pageNumber: number,
    ): Promise<PageConversation | undefined> {
      return store.get(pageConversationKey(fingerprint, pageNumber));
    },
    async save(conversation: PageConversation): Promise<void> {
      await store.set(
        pageConversationKey(conversation.fingerprint, conversation.pageNumber),
        conversation,
      );
    },
    async delete(fingerprint: string, pageNumber: number): Promise<void> {
      await store.delete(pageConversationKey(fingerprint, pageNumber));
    },
    async clearAll(): Promise<void> {
      const keys = await store.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CHAT_KEY_PREFIX))
          .map((key) => store.delete(key)),
      );
    },
  };
}

export function createChatService(store?: KVStore<PageConversation>) {
  return createConversationStore(
    store ?? createIndexedDBStore<PageConversation>('pdf-reader', 'kv'),
  );
}
