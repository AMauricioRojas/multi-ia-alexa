import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planConfig } from '../lib/plans.js';
import { createProviderCall } from '../lib/providers.js';

const config = planConfig({});
const messages = [{ role: 'system', content: 'Sé breve' }, { role: 'user', content: 'Hola' }];
const env = { OPENAI_API_KEY: 'synthetic', GROQ_API_KEY: 'synthetic', GEMINI_API_KEY: 'synthetic' };
for (const provider of ['chatgpt', 'groq_fast', 'groq_power', 'gemini']) {
  test(`${provider}: límite de salida y tokens informados, sin API real`, async () => {
    const call = createProviderCall(config, { env, fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.max_completion_tokens || body.generationConfig?.maxOutputTokens, 512);
      assert.ok(options.signal);
      assert.ok(!url.includes('synthetic'));
      return { ok: true, status: 200, json: async () => provider === 'gemini'
        ? { candidates: [{ content: { parts: [{ text: 'Hola' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 10 } }
        : { choices: [{ message: { content: 'Hola' } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } };
    } });
    const result = await call(provider, messages);
    assert.equal(result.text, 'Hola');
    assert.equal(result.usage.total_tokens, 10);
  });
}
test('proveedor no configurado se rechaza antes de enviar', async () => {
  await assert.rejects(createProviderCall(config, { env: {}, fetchImpl: () => assert.fail('No network') })('chatgpt', messages), { code: 'PROVIDER_UNAVAILABLE', definitelyRejected: true });
});
test('HTTP 429 libera reserva; HTTP 500 o desconexión mantienen incertidumbre y no reintentan', async () => {
  for (const status of [429, 500, 'network']) {
    let calls = 0;
    const call = createProviderCall(config, { env, fetchImpl: async () => {
      calls++;
      if (status === 'network') throw new Error('transport error');
      return { ok: false, status, json: async () => ({ error: { message: 'private-provider-detail' } }) };
    } });
    await assert.rejects(call('chatgpt', messages), error => {
      assert.equal(Boolean(error.definitelyRejected), status === 429);
      assert.ok(!error.message.includes('private-provider-detail'));
      return true;
    });
    assert.equal(calls, 1);
  }
});
test('respuesta sin texto con tokens se conserva como consumo incierto', async () => {
  const call = createProviderCall(config, { env, fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }) }) });
  await assert.rejects(call('chatgpt', messages), error => error.usage.total_tokens === 3 && !error.definitelyRejected);
});
