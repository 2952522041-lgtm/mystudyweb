import { loadChatSettings } from './chat-cache.ts';

/**
 * 知识库 AI 的独立设置：单 PDF 总结/脑图与课程综合都使用这套接口，
 * 与页面翻译、AI 答疑互不串用。生成是纯文字任务，因此不需要视觉确认。
 */
export interface KnowledgeSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4.1-mini',
};

const KNOWLEDGE_SETTINGS_STORAGE_KEY = 'pdf-reader-knowledge-settings';

export function validateKnowledgeSettings(
  settings: KnowledgeSettings,
): string | null {
  try {
    const url = new URL(settings.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '请输入有效的 HTTP(S) 知识库 AI 接口地址。';
    }
  } catch {
    return '请输入有效的 HTTP(S) 知识库 AI 接口地址。';
  }
  if (settings.apiKey.trim().length === 0) {
    return '请输入知识库 AI API Key。';
  }
  if (settings.model.trim().length === 0) {
    return '请输入知识库 AI 模型名称。';
  }
  return null;
}

export function knowledgeSettingsConfigured(
  settings: KnowledgeSettings,
): boolean {
  return validateKnowledgeSettings(settings) === null;
}

/**
 * 兼容旧版本：知识库曾经完全复用「AI 答疑」配置。从未保存过独立设置时，
 * 沿用当前答疑配置，已配置过答疑的用户升级后无需重新填写。
 */
export function loadKnowledgeSettings(
  storage: Pick<Storage, 'getItem'> = localStorage,
): KnowledgeSettings {
  try {
    const raw = storage.getItem(KNOWLEDGE_SETTINGS_STORAGE_KEY);
    if (raw) {
      return {
        ...DEFAULT_KNOWLEDGE_SETTINGS,
        ...(JSON.parse(raw) as Partial<KnowledgeSettings>),
      };
    }
  } catch {
    // 解析失败按未保存处理，回落到答疑配置而不是丢掉可用的 Key。
  }
  const chat = loadChatSettings(storage);
  return {
    baseUrl: chat.baseUrl,
    apiKey: chat.apiKey,
    model: chat.model,
  };
}

export function saveKnowledgeSettings(
  settings: KnowledgeSettings,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(
    KNOWLEDGE_SETTINGS_STORAGE_KEY,
    JSON.stringify(settings),
  );
}
