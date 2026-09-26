import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReaderSettings, DEFAULT_SETTINGS } from '../lib/reader-cache.ts';
import { validateChatSettings, DEFAULT_CHAT_SETTINGS } from '../lib/chat-cache.ts';
import { validateKnowledgeSettings, DEFAULT_KNOWLEDGE_SETTINGS } from '../lib/knowledge-settings.ts';

for (const kind of ['translation','chat','knowledge'] as const) {
  const validate = (baseUrl: string, model = 'provider-model') => kind === 'translation'
    ? validateReaderSettings({...DEFAULT_SETTINGS,providerMode:'openai-compatible',baseUrl,model,apiKey:'mock'})
    : kind === 'chat' ? validateChatSettings({...DEFAULT_CHAT_SETTINGS,baseUrl,model,apiKey:'mock',visionConfirmed:true})
      : validateKnowledgeSettings({...DEFAULT_KNOWLEDGE_SETTINGS,baseUrl,model,apiKey:'mock'});
  void test(`${kind} settings reject full endpoints and malformed bases with recovery guidance`, () => {
    for (const base of ['https://mock.test/v1/chat/completions','https://mock.test/v1/responses/']) {
      assert.match(validate(base)!, /基础地址.*不要包含/);
    }
    for (const base of ['not a url','ftp://mock.test','https://mock.test/v1?key=secret','https://mock.test/v1#anchor','https://user:password@mock.test',' https://mock.test/v1 ']) {
      assert.ok(validate(base));
    }
    for (const base of ['https://mock.test/v1','https://mock.test/api/v4/','http://localhost:8080/custom']) assert.equal(validate(base), null);
    assert.equal(validate('https://mock.test', ' model '), null); // Preserve existing provider model handling.
  });
}
