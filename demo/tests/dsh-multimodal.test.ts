import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDshRequest, buildDshPatch } from '../electron/dsh-policy.ts';
import { dshPrompt } from '../electron/dsh-prompt.ts';
import { dshWebSearch } from '../electron/dsh-search.ts';

type DshPatchEntry = ReturnType<typeof buildDshPatch>[number];
type InsertPatchEntry = DshPatchEntry & { insert: unknown[] };

function hasInsert(entry: DshPatchEntry): entry is InsertPatchEntry {
  return 'insert' in entry && Array.isArray(entry.insert);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=';
const request = () => ({
  requestId: 'test',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'fake',
  model: 'glm-4.6v',
  thinking: 'disabled',
  maxTokens: 128,
  messages: [
    { role: 'system', content: 'Fixed instructions' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'OCR please' },
        { type: 'image_url', image_url: { url: png } },
      ],
    },
  ],
});
void test('vision requests retain image bytes outside stable conversation JSON', () => {
  const r = validateDshRequest(request());
  const prompt = dshPrompt(r);
  assert.equal(prompt.system, 'Fixed instructions');
  assert.equal(prompt.blocks.length, 2);
  assert.equal(prompt.blocks[1].type, 'image');
  assert.equal(JSON.stringify(prompt.blocks[0]).includes('iVBOR'), false);
  assert.match(JSON.stringify(prompt.blocks[0]), /attachment/);
  assert.match(JSON.stringify(prompt.blocks[1]), /iVBOR/);
});
void test('rejects remote paths, fake MIME, excessive images and text-only models', () => {
  for (const url of [
    'https://localhost/secret.png',
    'file:///etc/passwd',
    png.replace('image/png', 'image/jpeg'),
    'data:image/png;base64,c2VjcmV0',
  ]) {
    const r = request();
    r.messages[1].content = [{ type: 'image_url', image_url: { url } }];
    assert.throws(() => validateDshRequest(r));
  }
  assert.throws(() =>
    validateDshRequest({ ...request(), model: 'glm-4.5-air' }),
  );
  const r = request();
  r.messages[1].content = Array.from({ length: 5 }, () => ({
    type: 'image_url',
    image_url: { url: png },
  }));
  assert.throws(() => validateDshRequest(r));
});
void test('GLM profile inserts official adapter, disables DeepSeek route and retains no-shell policy', () => {
  const patch = buildDshPatch('Fixed', validateDshRequest(request()));
  assert.ok(
    patch.some((p) => p.id === 'llm-deepseek' && 'disabled' in p && p.disabled),
  );
  const inserted = patch.filter(hasInsert).flatMap((entry) => entry.insert);
  const rows = inserted
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const added = rows.find((entry) => entry.id === 'yeyu-zhipu');
  assert.equal(added?.name, '@deepseek-ai/dsh-llm-pi-ai');
  const provider = asRecord(asRecord(added?.config)?.providers)?.['yeyu-zhipu'];
  const providerConfig = asRecord(provider);
  const compat = asRecord(providerConfig?.compat);
  assert.equal(compat?.thinkingFormat, 'zai');
  assert.equal(compat?.supportsReasoningEffort, false);
  const models = providerConfig?.models;
  assert.ok(Array.isArray(models));
  const model = asRecord(models[0]);
  assert.equal(asRecord(model?.reasoningEfforts)?.off, null);
  const attachment = rows.find((entry) => entry.id === 'attachment-local');
  assert.equal(attachment?.name, '@deepseek-ai/dsh-attachment-local');
});
void test('search is a fixed bounded provider tool, not arbitrary host fetch', async () => {
  const valid = validateDshRequest({
    ...request(),
    operation: 'web-search',
    model: 'web-search',
    messages: [{ role: 'user', content: 'CAN bus' }],
  });
  assert.equal(valid.operation, 'web-search');
  assert.throws(() =>
    validateDshRequest({
      ...valid,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
    }),
  );
  assert.throws(() =>
    validateDshRequest({
      ...valid,
      messages: [{ role: 'user', content: 'x'.repeat(71) }],
    }),
  );
  let called = false;
  const response = await dshWebSearch('fake', 'CAN bus', async (url, init) => {
    called = true;
    assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
    assert.equal(init?.redirect, 'error');
    assert.equal(JSON.parse(init?.body as string).search_query, 'CAN bus');
    return new Response(
      JSON.stringify({
        search_result: [
          { title: 'test', link: 'https://example.com', content: 'data' },
        ],
      }),
    );
  });
  assert.ok(called);
  assert.equal(JSON.parse(response).search_result.length, 1);
});
