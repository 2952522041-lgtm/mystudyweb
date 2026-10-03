'use client';

import { useEffect, useRef, useState } from 'react';

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
import {
  validateKnowledgeSettings,
  type KnowledgeGenerationMode,
  type KnowledgeSettings,
} from '@/lib/knowledge-settings';
import {
  assessDshSettings,
  loadAgentSettings,
  saveAgentSettings,
  type AgentBackend,
  type AgentSettings,
} from '@/lib/agent-settings';

import { DSH_RUNTIME_VERSION, DSH_MODELS } from '@/lib/dsh-capabilities';
import { DSH_ERRORS, DshError, safeDshError } from '@/lib/dsh-errors';
import { requestDshCompletion } from '@/lib/dsh-client';
import type { DshRuntimeStatus } from '@/lib/dsh-types';

export type SettingsTab = 'translation' | 'chat' | 'knowledge';

export function ReaderSettingsDialog({
  initialTab,
  translationSettings,
  chatSettings,
  knowledgeSettings,
  onClose,
  onSave,
}: {
  initialTab: SettingsTab;
  translationSettings: ReaderSettings;
  chatSettings: ChatSettings;
  knowledgeSettings: KnowledgeSettings;
  onClose: () => void;
  onSave: (
    translation: ReaderSettings,
    chat: ChatSettings,
    knowledge: KnowledgeSettings,
  ) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [translationDraft, setTranslationDraft] = useState(translationSettings);
  const [chatDraft, setChatDraft] = useState(chatSettings);
  const [knowledgeDraft, setKnowledgeDraft] = useState<KnowledgeSettings>({
    ...knowledgeSettings,
    generationMode: knowledgeSettings.generationMode ?? 'fast',
  });
  const [agentSettingsDraft, setAgentSettingsDraft] = useState<AgentSettings>(
    () => loadAgentSettings(),
  );
  const [runtimeStatus, setRuntimeStatus] = useState<DshRuntimeStatus | null>(null);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null);
  const [connectionTesting, setConnectionTesting] = useState(false);
  const connectionAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; connectionAbort.current?.abort(); }; }, []);
  const availability = assessDshSettings(agentSettingsDraft, { translation: translationDraft, chat: chatDraft, knowledge: knowledgeDraft });
  const checkRuntime = async () => {
    await Promise.resolve();
    if (!mounted.current) return;
    const bridge = (window as unknown as { yeyuDesktop?: { inspectDshRuntime?(): Promise<DshRuntimeStatus> } }).yeyuDesktop;
    setRuntimeChecking(true);
    setRuntimeStatus(null);
    setRuntimeError(null);
    try {
      if (!bridge?.inspectDshRuntime) throw new Error('unavailable');
      const status = await bridge.inspectDshRuntime();
      if (mounted.current) setRuntimeStatus(status);
    } catch {
      if (mounted.current) setRuntimeError('无法读取宿主运行时，请使用最新版桌面版或重新连接共享宿主。');
    } finally { if (mounted.current) setRuntimeChecking(false); }
  };
  useEffect(() => {
    if (agentSettingsDraft.backend !== 'dsh') return;
    const timer = setTimeout(() => { void checkRuntime(); }, 0);
    return () => clearTimeout(timer);
  }, [agentSettingsDraft.backend]);
  useEffect(() => {
    connectionAbort.current?.abort();
  }, [tab, translationDraft, chatDraft, knowledgeDraft, agentSettingsDraft]);
  const testConnection = async () => {
    const row = availability.find(item => item.tab === tab && item.backend === 'dsh');
    if (!row) { setConnectionStatus('当前栏目没有启用 DSH。'); return; }
    if (row.issue) { setConnectionStatus(row.issue.message); return; }
    const config = tab === 'translation' ? translationDraft : tab === 'chat' ? chatDraft : knowledgeDraft;
    const controller = new AbortController();
    connectionAbort.current = controller;
    setConnectionTesting(true);
    setConnectionStatus('正在发送一条短请求，验证运行时、鉴权和模型…');
    try {
      const result = await requestDshCompletion(config, { messages: [{ role: 'user', content: '请只回复 OK。' }], maxTokens: 32, thinking: 'disabled', task: 'interactive', timeoutMs: 20_000, signal: controller.signal });
      if (!result.content.trim() || result.finishReason !== 'stop') throw new DshError('incomplete');
      if (mounted.current && !controller.signal.aborted) setConnectionStatus('DSH 连接成功，运行时、鉴权与模型均可用。');
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setConnectionStatus(safeDshError(error).message);
    } finally {
      if (connectionAbort.current === controller) { connectionAbort.current = null; if (mounted.current) setConnectionTesting(false); }
    }
  };
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

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
    if (tab === 'knowledge' || knowledgeDraft.apiKey.trim().length > 0) {
      const knowledgeError = validateKnowledgeSettings(knowledgeDraft);
      if (knowledgeError) {
        setTab('knowledge');
        setError(knowledgeError);
        return;
      }
    }
    const incompatible = availability.find(item => item.issue);
    if (incompatible?.issue) {
      setTab(incompatible.tab);
      setError(`${incompatible.label}：${incompatible.issue.message}`);
      const prefix = incompatible.tab === 'translation' ? 'setting' : incompatible.tab;
      requestAnimationFrame(() => document.getElementById(`${prefix}-${incompatible.issue!.field}`)?.focus());
      return;
    }
    if (agentSettingsDraft.backend === 'dsh' && (runtimeChecking || !runtimeStatus?.available)) {
      setError(runtimeChecking ? '运行时自检中，请稍后保存。' : runtimeError ?? (runtimeStatus?.errorCode ? DSH_ERRORS[runtimeStatus.errorCode] : '请先完成运行时自检。'));
      return;
    }
    saveAgentSettings(agentSettingsDraft);
    onSave(translationDraft, chatDraft, knowledgeDraft);
  };

  const chooseTranslationPreset = (presetId: TranslationPresetId) => {
    setTranslationDraft((previous) =>
      applyTranslationPreset(previous, presetId),
    );
    setError(null);
    setConnectionStatus(null);
  };

  const updateTranslationApiKey = (apiKey: string) => {
    setTranslationDraft((previous) => updateReaderApiKey(previous, apiKey));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onChangeCapture={() => { setError(null); setConnectionStatus(null); }} className="max-h-[88vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-lg">阅读服务设置</DialogTitle>
          <DialogDescription>
            页面翻译、AI 答疑与知识库 AI
            分别保存接口、API Key 和模型，互不串用。接口地址填写基础路径，程序会追加 /chat/completions；模型填写服务商提供的模型 ID。
          </DialogDescription>
        </DialogHeader>

        <section
          aria-labelledby="agent-backend-heading"
          className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5"
        >
          <div>
            <h2
              id="agent-backend-heading"
              className="text-xs font-semibold text-slate-800"
            >
              AI 执行后端
            </h2>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">
              可统一管理整理、翻译、OCR 和答疑；每项继续使用对应的模型配置。
            </p>
          </div>
          <NativeSelect
            id="agent-backend"
            aria-label="AI 执行后端"
            value={agentSettingsDraft.backend}
            onChange={(event) =>
              setAgentSettingsDraft((previous) => ({
                ...previous,
                backend: event.target.value as AgentBackend,
              }))
            }
          >
            <NativeSelectOption value="api">API 直接调用</NativeSelectOption>
            <NativeSelectOption value="dsh">
              DeepSeek Harness
            </NativeSelectOption>
          </NativeSelect>
          {agentSettingsDraft.backend === 'dsh' ? (
            <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-5 text-amber-900">
              <p>
                DSH 支持已接入的官方 DeepSeek / 智谱模型，在本机桌面宿主运行；Windows
                共享端通过宿主，不会替换数据。
              </p>
              <div className="flex items-start gap-2 pt-1">
                <Checkbox id="agent-dsh-all-ai" checked={Boolean(agentSettingsDraft.allAi)} onCheckedChange={checked=>setAgentSettingsDraft(previous=>({...previous,allAi:checked===true}))}/>
                <label htmlFor="agent-dsh-all-ai">所有 AI 任务统一走 DSH（翻译、OCR、图片答疑保留各自模型）</label>
              </div>
              <div className="flex items-start gap-2 pt-1">
                <Checkbox
                  id="agent-dsh-document-chat"
                  checked={Boolean(agentSettingsDraft.allAi || agentSettingsDraft.dshDocumentChat)}
                  disabled={Boolean(agentSettingsDraft.allAi)}
                  onCheckedChange={(checked) =>
                    setAgentSettingsDraft((previous) => ({
                      ...previous,
                      dshDocumentChat: checked === true,
                    }))
                  }
                />
                <label
                  htmlFor="agent-dsh-document-chat"
                  className="text-[11px] leading-5 text-amber-950"
                >
                  整份文档问答使用知识库配置（页面图片问答使用答疑配置）
                </label>
              </div>
              <div className="flex items-center justify-between gap-2 pt-2">
                <output>{runtimeChecking ? '正在自检宿主运行时…' : runtimeStatus?.available ? `运行时就绪 · ${runtimeStatus.expectedVersion}` : runtimeError ?? (runtimeStatus?.errorCode ? DSH_ERRORS[runtimeStatus.errorCode] : `需要运行时 ${DSH_RUNTIME_VERSION}`)}</output>
                <Button type="button" size="sm" variant="outline" disabled={runtimeChecking} onClick={() => void checkRuntime()}>重新自检</Button>
              </div>
              {runtimeStatus ? <ul aria-label="运行时组件检查" className="text-[10px]">
                {runtimeStatus.checks.map(check => <li key={check.component}>{check.ok ? '✓' : '×'} {check.component}{check.version ? ` · ${check.version}` : ''}</li>)}
              </ul> : null}
              <ul aria-label="AI 功能可用性" className="space-y-1 border-t border-amber-200 pt-2">
                {availability.map(item => <li key={item.task}><strong>{item.label}</strong> · {item.backend === 'demo' ? '内置演示' : item.backend === 'api' ? 'API' : item.issue ? `DSH · ${item.issue.message}` : 'DSH · 配置兼容'}</li>)}
              </ul>
              <p>固定版本 DSH 不支持温度与强制 JSON 输出参数，使用服务商默认采样；整理结果仍经过 JSON 解析与结构校验。连接等待指运行时就绪后等待首个事件；执行和流空闲均有超时上限。</p>
              <p>支持图片的模型：{DSH_MODELS.filter(model => model.image).map(model => model.id).join(' / ')}。</p>
            </div>
          ) : null}
        </section>

        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as SettingsTab);
            setError(null);
            setConnectionStatus(null);
          }}
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="translation">页面翻译</TabsTrigger>
            <TabsTrigger value="chat">AI 答疑</TabsTrigger>
            <TabsTrigger value="knowledge">知识库 AI</TabsTrigger>
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
              OCR。请选择支持图片输入的模型。使用智谱开放平台地址时，明确要求“联网搜索”会先调用其网络搜索服务，再结合网页来源回答，并可能产生搜索费用。
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

          <TabsContent value="knowledge" className="space-y-4 pt-3">
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] leading-5 text-sky-800">
              知识库 AI 用于生成单 PDF 总结、PDF 脑图、课程总总结和总脑图，是纯文字任务，不需要视觉模型。扫描或手写页面的
              OCR 仍使用「AI 答疑」中配置的视觉模型。成果按接口与模型缓存，更换模型后重新生成不会复用旧结果。
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="knowledge-base-url"
                className="text-xs font-medium text-slate-700"
              >
                知识库 AI 接口地址
              </label>
              <Input
                id="knowledge-base-url"
                value={knowledgeDraft.baseUrl}
                onChange={(event) =>
                  setKnowledgeDraft((previous) => ({
                    ...previous,
                    baseUrl: event.target.value,
                  }))
                }
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="knowledge-api-key"
                className="text-xs font-medium text-slate-700"
              >
                知识库 AI API Key
              </label>
              <Input
                id="knowledge-api-key"
                type="password"
                value={knowledgeDraft.apiKey}
                onChange={(event) =>
                  setKnowledgeDraft((previous) => ({
                    ...previous,
                    apiKey: event.target.value,
                  }))
                }
                placeholder="sk-…"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="knowledge-model"
                className="text-xs font-medium text-slate-700"
              >
                模型
              </label>
              <Input
                id="knowledge-model"
                value={knowledgeDraft.model}
                onChange={(event) =>
                  setKnowledgeDraft((previous) => ({
                    ...previous,
                    model: event.target.value,
                  }))
                }
                placeholder="知识库生成用的模型名称"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="knowledge-generation-mode"
                className="text-xs font-medium text-slate-700"
              >
                生成模式
              </label>
              <NativeSelect
                id="knowledge-generation-mode"
                value={knowledgeDraft.generationMode ?? 'fast'}
                onChange={(event) =>
                  setKnowledgeDraft((previous) => ({
                    ...previous,
                    generationMode: event.target
                      .value as KnowledgeGenerationMode,
                  }))
                }
              >
                <NativeSelectOption value="fast">快速整理</NativeSelectOption>
                <NativeSelectOption value="deep">深入推理</NativeSelectOption>
              </NativeSelect>
              <p className="text-[11px] leading-5 text-slate-500">
                适用于 GLM-4.6V 和 DeepSeek Flash / V4 Pro 官方接口。快速整理会关闭普通摘要和课程整理的额外思考，同时保留内容、来源和结构校验；其他模型和代理接口不会发送私有参数。复杂结构修复仍可深入推理。
              </p>
            </div>
            <p className="text-[11px] leading-5 text-slate-500">
              知识库配置只保存在本机，不会与翻译、答疑配置共享，也不会写入课程目录。首次升级前已配置过
              AI 答疑时，这里会自动沿用那份配置。
            </p>
          </TabsContent>
        </Tabs>

        {agentSettingsDraft.backend === 'dsh' ? <section className="rounded-md border px-3 py-2 text-xs space-y-2">
          <p>测试当前栏目配置会向对应服务商发送一条短请求，可能产生少量费用。</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={connectionTesting || !runtimeStatus?.available || !availability.some(item => item.tab === tab && item.backend === 'dsh')} onClick={() => void testConnection()}>测试当前栏目 DSH 连接</Button>
            {connectionTesting ? <Button type="button" variant="ghost" size="sm" onClick={() => { connectionAbort.current?.abort(); setConnectionStatus('连接测试已取消。'); }}>取消测试</Button> : null}
          </div>
          {connectionStatus ? <output className="block">{connectionStatus}</output> : null}
        </section> : null}

        {error ? (
          <p ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
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
