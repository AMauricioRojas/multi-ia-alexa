import fetch from 'node-fetch';
import { ChatError, MODELS } from './plans.js';

export function reportedUsage(data, gemini = false) {
  const usage = gemini ? data?.usageMetadata : data?.usage;
  const input = gemini ? usage?.promptTokenCount : usage?.prompt_tokens;
  const output = gemini ? (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0) : usage?.completion_tokens;
  const total = gemini ? usage?.totalTokenCount : usage?.total_tokens;
  if (![input, output, total].every(n => Number.isSafeInteger(n) && n >= 0) || total < input + output) return null;
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

// One attempt only. A timeout or a 5xx can still have incurred provider usage.
export function createProviderCall(config, { env = process.env, fetchImpl = fetch } = {}) {
  return async (provider, messages) => {
    const gemini = provider === 'gemini';
    const key = env[gemini ? 'GEMINI_API_KEY' : provider === 'chatgpt' ? 'OPENAI_API_KEY' : 'GROQ_API_KEY'];
    if (!key) {
      const error = new ChatError('PROVIDER_UNAVAILABLE', 'El modelo no está configurado. Elige otro modelo disponible.', 503);
      error.definitelyRejected = true;
      throw error;
    }
    const url = gemini
      ? `https://generativelanguage.googleapis.com/v1beta/models/${MODELS[provider]}:generateContent`
      : provider === 'chatgpt'
        ? 'https://api.openai.com/v1/chat/completions'
        : 'https://api.groq.com/openai/v1/chat/completions';
    const body = gemini ? {
      systemInstruction: { parts: [{ text: messages[0].content }] },
      contents: messages.slice(1).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: config.maxOutputTokens },
    } : {
      model: MODELS[provider], messages,
      max_completion_tokens: config.maxOutputTokens,
    };
    let response;
    let data;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(gemini ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` }) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs),
      });
      data = await response.json();
    } catch {
      throw new ChatError('PROVIDER_UNKNOWN', 'No pudimos confirmar la respuesta. La consulta queda reservada para evitar duplicarla.', 502);
    }
    const usage = reportedUsage(data, gemini);
    const text = gemini ? data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') : data.choices?.[0]?.message?.content;
    if (!response.ok || typeof text !== 'string' || !text.trim()) {
      const rejected = !usage && [400, 401, 403, 404, 413, 422, 429].includes(response.status);
      const error = new ChatError(rejected ? 'PROVIDER_FAILED' : 'PROVIDER_UNKNOWN', rejected
        ? 'El proveedor rechazó la solicitud. Tu cupo está disponible para una nueva consulta.'
        : 'No pudimos confirmar la respuesta. La consulta queda reservada para evitar duplicarla.', 502);
      error.definitelyRejected = rejected;
      error.usage = usage;
      throw error;
    }
    return { text, usage };
  };
}
