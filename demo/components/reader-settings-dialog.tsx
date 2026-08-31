'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  applyTranslationPreset,
  TRANSLATION_PRESETS,
  updateReaderApiKey,
  validateReaderSettings,
  type ReaderSettings,
  type TranslationPresetId,
} from '@/lib/reader-cache';
import { validateChatSettings, type ChatSettings } from '@/lib/chat-cache';

export type SettingsTab = 'translation' | 'chat';

export function ReaderSettingsDialog({
  initialTab,
  translationSettings,
  chatSettings,
  onClose,
  onSave,
}: {
  initialTab: SettingsTab;
  translationSettings: ReaderSettings;
  chatSettings: ChatSettings;
  onClose: () => void;
  onSave: (translation: ReaderSettings, chat: ChatSettings) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [translationDraft, setTranslationDraft] = useState(translationSettings);
  const [chatDraft, setChatDraft] = useState(chatSettings);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const translationError = validateReaderSettings(translationDraft);
    if (translationError) {
      setTab('translation');
      setError(translationError);
      return;
    }
    if (tab === 'chat' || chatDraft.apiKey.trim().length > 0) {
      const chatError = validateChatSettings(chatDraft);
      if (chatError) {
        setTab('chat');
        setError(chatError);
        return;
      }
    }
    onSave(translationDraft, chatDraft);
  };

  const chooseTranslationPreset = (presetId: TranslationPresetId) => {
    setTranslationDraft((previous) =>
      applyTranslationPreset(previous, presetId),
    );
    setError(null);
  };

  const updateTranslationApiKey = (apiKey: string) => {
    setTranslationDraft((previous) => updateReaderApiKey(previous, apiKey));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-lg">阅读服务设置</DialogTitle>
          <DialogDescription>
            页面翻译与 AI 答疑分别保存接口、API Key 和模型，互不串用。
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as SettingsTab);
            setError(null);
          }}
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="translation">页面翻译</TabsTrigger>
            <TabsTrigger value="chat">AI 答疑</TabsTrigger>
          </TabsList>

          <TabsContent value="translation" className="space-y-4 pt-3">
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-700">推荐配置</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(
                  Object.keys(TRANSLATION_PRESETS) as TranslationPresetId[]
                ).map((presetId) => (
                  <Button
                    key={presetId}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => chooseTranslationPreset(presetId)}
                  >
                    {TRANSLATION_PRESETS[presetId].label}
                  </Button>
                ))}
              </div>
              <p className="text-[11px] leading-5 text-slate-500">
                推荐配置关闭深度思考，适合低延迟逐页翻译。
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="setting-provider"
                className="text-xs font-medium text-slate-700"
              >
                翻译服务
              </label>
              <NativeSelect
                id="setting-provider"
                value={translationDraft.providerMode}
                onChange={(event) =>
                  setTranslationDraft((previous) => ({
                    ...previous,
                    providerMode: event.target
                      .value as ReaderSettings['providerMode'],
                  }))
                }
              >
                <NativeSelectOption value="mock">
                  内置演示（不联网）
                </NativeSelectOption>
                <NativeSelectOption value="openai-compatible">
                  OpenAI 兼容接口
                </NativeSelectOption>
              </NativeSelect>
            </div>

            {translationDraft.providerMode === 'openai-compatible' ? (
              <>
                <div className="space-y-1.5">
                  <label
                    htmlFor="setting-base-url"
                    className="text-xs font-medium text-slate-700"
                  >
                    接口地址
                  </label>
                  <Input
                    id="setting-base-url"
                    value={translationDraft.baseUrl}
                    onChange={(event) =>
                      setTranslationDraft((previous) => ({
                        ...previous,
                        baseUrl: event.target.value,
                      }))
                    }
                    placeholder="https://api.example.com/v1"
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="setting-api-key"
                    className="text-xs font-medium text-slate-700"
                  >
                    API Key
                  </label>
                  <Input
                    id="setting-api-key"
                    type="password"
                    value={translationDraft.apiKey}
                    onChange={(event) =>
                      updateTranslationApiKey(event.target.value)
                    }
                    placeholder="sk-…"
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="setting-model"
                    className="text-xs font-medium text-slate-700"
                  >
                    模型
                  </label>
                  <Input
                    id="setting-model"
                    value={translationDraft.model}
                    onChange={(event) =>
                      setTranslationDraft((previous) => ({
                        ...previous,
                        model: event.target.value,
                      }))
                    }
                    placeholder="translation-model"
                  />
                </div>
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    id="setting-disable-thinking"
                    checked={translationDraft.disableThinking}
                    onCheckedChange={(checked) =>
                      setTranslationDraft((previous) => ({
                        ...previous,
                        disableThinking: checked === true,
                      }))
                    }
                  />
                  <label
                    htmlFor="setting-disable-thinking"
                    className="text-xs leading-5 text-slate-700"
                  >
                    关闭思考模式（翻译场景推荐）
                  </label>
                </div>
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="chat" className="space-y-4 pt-3">
            <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[11px] leading-5 text-violet-800">
              AI
              答疑会在你发送问题时，把当前页文字和清晰页面图像发送给所配置服务；扫描或手写页面也会复用此视觉模型进行
              OCR。请选择支持图片输入的模型。
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="chat-base-url"
                className="text-xs font-medium text-slate-700"
              >
                AI 接口地址
              </label>
              <Input
                id="chat-base-url"
                value={chatDraft.baseUrl}
                onChange={(event) =>
                  setChatDraft((previous) => ({
                    ...previous,
                    baseUrl: event.target.value,
                    visionConfirmed: false,
                  }))
                }
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="chat-api-key"
                className="text-xs font-medium text-slate-700"
              >
                AI API Key
              </label>
              <Input
                id="chat-api-key"
                type="password"
                value={chatDraft.apiKey}
                onChange={(event) =>
                  setChatDraft((previous) => ({
                    ...previous,
                    apiKey: event.target.value,
                  }))
                }
                placeholder="sk-…"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="chat-model"
                className="text-xs font-medium text-slate-700"
              >
                视觉模型
              </label>
              <Input
                id="chat-model"
                value={chatDraft.model}
                onChange={(event) =>
                  setChatDraft((previous) => ({
                    ...previous,
                    model: event.target.value,
                    visionConfirmed: false,
                  }))
                }
                placeholder="支持图片输入的模型名称"
              />
            </div>
            <div className="flex items-start gap-2.5">
              <Checkbox
                id="chat-vision-confirmed"
                checked={chatDraft.visionConfirmed}
                onCheckedChange={(checked) =>
                  setChatDraft((previous) => ({
                    ...previous,
                    visionConfirmed: checked === true,
                  }))
                }
              />
              <label
                htmlFor="chat-vision-confirmed"
                className="text-xs leading-5 text-slate-700"
              >
                我已确认该模型支持图片输入
              </label>
            </div>
            <p className="text-[11px] leading-5 text-slate-500">
              AI 配置只保存在本机浏览器中，不会与翻译配置共享。OCR
              识别文字会缓存在本机，不保存页面图像。
            </p>
          </TabsContent>
        </Tabs>

        {error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save}>保存设置</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
