export class ChatError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const MODELS = Object.freeze({
  chatgpt: 'gpt-4o-mini',
  groq_fast: 'llama-3.1-8b-instant',
  groq_power: 'llama-3.3-70b-versatile',
  gemini: 'gemini-2.5-flash-lite',
});

function integer(env, name, fallback, min = 0, max = 1000000) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Configuración inválida: ${name}`);
  }
  return value;
}

export function planConfig(env = process.env) {
  return {
    plans: {
      basic: { name: 'Básico', request_limit: integer(env, 'BASIC_REQUEST_LIMIT', 20), models: ['groq_fast'] },
      pro: { name: 'Pro', request_limit: integer(env, 'PRO_REQUEST_LIMIT', 200), models: ['groq_fast', 'chatgpt', 'groq_power', 'gemini'] },
    },
    globalLimit: integer(env, 'GLOBAL_REQUEST_LIMIT', 1000),
    maxInputBytes: integer(env, 'AI_MAX_INPUT_BYTES', 16000, 1024, 64000),
    maxOutputTokens: integer(env, 'AI_MAX_OUTPUT_TOKENS', 512, 1, 2048),
    timeoutMs: integer(env, 'AI_TIMEOUT_MS', 20000, 100, 60000),
  };
}

export function monthPeriod(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}
