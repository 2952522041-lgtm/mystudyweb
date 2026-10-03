/** One application-owned catalog shared by settings and the desktop boundary.
 * The pinned SDK's native DeepSeek catalog supplies flash/pro; its explicit
 * catalog override admits v4-flash as text-only. pi-ai supplies the GLM route.
 */
export const DSH_RUNTIME_VERSION = '0.1.7-rc.2';
export const DSH_CLIENT_VERSION = DSH_RUNTIME_VERSION;
export const DSH_MODELS = [
  { id: 'deepseek-flash', provider: 'deepseek', image: true },
  { id: 'deepseek-v4-flash', provider: 'deepseek', image: false },
  { id: 'deepseek-v4-pro', provider: 'deepseek', image: false },
  { id: 'glm-4.6v', provider: 'zhipu', image: true },
  { id: 'glm-4.5-air', provider: 'zhipu', image: false },
  { id: 'glm-4.7-flashx', provider: 'zhipu', image: false },
] as const;

export function dshProvider(baseUrl: string): 'deepseek' | 'zhipu' | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return null;
    if (url.hostname === 'api.deepseek.com' && ['', '/', '/v1', '/v1/'].includes(url.pathname)) return 'deepseek';
    if (url.hostname === 'open.bigmodel.cn' && ['/api/paas/v4', '/api/paas/v4/'].includes(url.pathname)) return 'zhipu';
  } catch { /* invalid configuration */ }
  return null;
}

export function dshModel(baseUrl: string, model: string) {
  const provider = dshProvider(baseUrl);
  return DSH_MODELS.find(entry => entry.provider === provider && entry.id === model);
}

export function dshConfigurationIssue(config: { baseUrl: string; model: string; apiKey: string }, image = false): { field: 'base-url' | 'model' | 'api-key'; message: string } | null {
  const provider = dshProvider(config.baseUrl);
  if (!provider) return { field: 'base-url', message: 'DSH 仅支持 DeepSeek 官方接口或智谱官方 /api/paas/v4 接口。' };
  const model = dshModel(config.baseUrl, config.model);
  if (!model) return { field: 'model', message: `DSH 模型请选择 ${DSH_MODELS.filter(entry => entry.provider === provider).map(entry => entry.id).join(' / ')}。` };
  if (image && !model.image) return { field: 'model', message: '页面答疑与 OCR 需要图片模型：deepseek-flash 或 glm-4.6v。' };
  if (!config.apiKey.trim()) return { field: 'api-key', message: '请输入该功能自己的 API Key。' };
  return null;
}
