/** Fixed search tool behind the same backend queue. No model-selected URLs. */
export async function dshWebSearch(
  apiKey: string,
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(
    'https://open.bigmodel.cn/api/paas/v4/web_search',
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        search_query: query,
        search_engine: 'search_std',
        search_intent: false,
        count: 5,
        search_recency_filter: 'noLimit',
        content_size: 'medium',
      }),
    },
  );
  if (!response.ok || !response.body) throw new Error('联网检索失败。');
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) throw new Error('检索结果超过大小限制。');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value = JSON.parse(text);
  if (!Array.isArray(value.search_result))
    throw new Error('检索结果格式无效。');
  return JSON.stringify({ search_result: value.search_result.slice(0, 5) });
}
