/**
 * Selects the execution backend independently of each task's model provider.
 * Existing settings retain their scope; allAi explicitly enables every task.
 */
export type AgentBackend = 'api' | 'dsh';

export interface AgentSettings {
  backend: AgentBackend;
  /** Explicit opt-in for routing whole-document chat through DSH. */
  dshDocumentChat: boolean;
  /** Opt in to all AI tasks; old installations retain their previous scope. */
  allAi?: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  backend: 'api',
  dshDocumentChat: false,
};

const AGENT_SETTINGS_STORAGE_KEY = 'yeyu-agent-settings';

function isAgentBackend(value: unknown): value is AgentBackend {
  return value === 'api' || value === 'dsh';
}

function browserLocalStorage(): Storage | null {
  try {
    const storage = (
      globalThis as typeof globalThis & {
        localStorage?: Storage;
      }
    ).localStorage;
    if (!storage || typeof storage.getItem !== 'function') {
      return null;
    }
    return storage;
  } catch {
    // Accessing localStorage can throw in sandboxed documents or when the
    // browser has disabled storage. Treat that exactly like no storage.
    return null;
  }
}

export function loadAgentSettings(
  storage?: Pick<Storage, 'getItem'>,
): AgentSettings {
  const source = storage ?? browserLocalStorage();
  if (!source) return { ...DEFAULT_AGENT_SETTINGS };

  try {
    const raw = source.getItem(AGENT_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AGENT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...DEFAULT_AGENT_SETTINGS };
    }
    const candidate = parsed as {
      backend?: unknown;
      dshDocumentChat?: unknown;
      allAi?: unknown;
    };
    if (!isAgentBackend(candidate.backend)) {
      return { ...DEFAULT_AGENT_SETTINGS };
    }
    if (candidate.allAi !== undefined && typeof candidate.allAi !== 'boolean')
      return { ...DEFAULT_AGENT_SETTINGS };
    // Settings saved before the explicit scope switch existed remain valid;
    // the new opt-in defaults to false. A present but malformed value is
    // treated as corrupt rather than silently enabling DSH chat.
    if (
      candidate.dshDocumentChat !== undefined &&
      typeof candidate.dshDocumentChat !== 'boolean'
    ) {
      return { ...DEFAULT_AGENT_SETTINGS };
    }
    return {
      backend: candidate.backend,
      dshDocumentChat: candidate.dshDocumentChat ?? false,
      ...(candidate.allAi !== undefined ? { allAi: candidate.allAi } : {}),
    };
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS };
  }
}

export function saveAgentSettings(
  settings: AgentSettings,
  storage?: Pick<Storage, 'setItem'>,
): void {
  if (
    typeof settings !== 'object' ||
    settings === null ||
    !isAgentBackend((settings as { backend?: unknown }).backend) ||
    typeof (settings as { dshDocumentChat?: unknown }).dshDocumentChat !==
      'boolean' ||
    (settings.allAi !== undefined && typeof settings.allAi !== 'boolean')
  ) {
    throw new TypeError(
      'Agent backend must be either "api" or "dsh" and dshDocumentChat must be boolean.',
    );
  }

  const target = storage ?? browserLocalStorage();
  if (!target || typeof target.setItem !== 'function') return;
  target.setItem(
    AGENT_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      backend: settings.backend,
      dshDocumentChat: settings.dshDocumentChat,
      ...(settings.allAi !== undefined ? { allAi: settings.allAi } : {}),
    }),
  );
}

/** Reads the selected backend for provider factories without requiring a browser. */
export function readSelectedAgentBackend(): AgentBackend {
  return loadAgentSettings().backend;
}

export type AiTask =
  | 'knowledge'
  | 'document-chat'
  | 'page-chat'
  | 'translation'
  | 'ocr'
  | 'web-search';
export function useDshForTask(task: AiTask): boolean {
  const settings = loadAgentSettings();
  return (
    settings.backend === 'dsh' &&
    (task === 'knowledge' ||
      settings.allAi === true ||
      (task === 'document-chat' && settings.dshDocumentChat))
  );
}
