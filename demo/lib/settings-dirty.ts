import type { ReaderSettings } from './reader-cache.ts';
import type { ChatSettings } from './chat-cache.ts';
import type { KnowledgeSettings } from './knowledge-settings.ts';
import type { AgentSettings } from './agent-settings.ts';

/** The four settings drafts that participate in the unsaved-close check. */
export interface SettingsSnapshot {
  translation: ReaderSettings;
  chat: ChatSettings;
  knowledge: KnowledgeSettings;
  agent: AgentSettings;
}

/**
 * Fills in optional fields so a draft that never touched a newly added field
 * still compares equal to the baseline captured when the dialog opened.
 * `generationMode` defaulting to `fast` is the important historical case.
 */
export function normalizeSettingsSnapshot(
  snapshot: SettingsSnapshot,
): SettingsSnapshot {
  return {
    translation: {
      ...snapshot.translation,
      apiKeys: { ...snapshot.translation.apiKeys },
    },
    chat: { ...snapshot.chat },
    knowledge: {
      ...snapshot.knowledge,
      generationMode: snapshot.knowledge.generationMode ?? 'fast',
    },
    agent: {
      ...snapshot.agent,
      allAi: snapshot.agent.allAi ?? false,
    },
  };
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function settingsSnapshotsEqual(
  left: SettingsSnapshot,
  right: SettingsSnapshot,
): boolean {
  return (
    canonicalValue(normalizeSettingsSnapshot(left)) ===
    canonicalValue(normalizeSettingsSnapshot(right))
  );
}

export function isSettingsSnapshotDirty(
  baseline: SettingsSnapshot,
  current: SettingsSnapshot,
): boolean {
  return !settingsSnapshotsEqual(baseline, current);
}
