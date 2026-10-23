import { createHash, randomUUID } from 'node:crypto';
import { ChatError, MODELS } from './plans.js';

export function createChatService({ pool, store, config, providerCall, providerLabel }) {
  return async function processQuestion({ user_id: userId, mensaje: message, provider = 'auto',
    conversation_id: conversationId = null, source, alexaMode = false, request_id: suppliedId }) {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new ChatError('AUTH_REQUIRED', 'Inicia sesión para continuar.', 401);
    if (typeof message !== 'string' || !message.trim()) throw new ChatError('EMPTY_MESSAGE', 'Escribe una pregunta.');
    if (Buffer.byteLength(message, 'utf8') > config.maxInputBytes / 2) throw new ChatError('MESSAGE_TOO_LONG', 'Tu pregunta es demasiado larga. Reduce el texto.', 413);
    if (conversationId !== null && (typeof conversationId !== 'string' || !conversationId || conversationId.length > 160)) throw new ChatError('INVALID_CONVERSATION', 'La conversación no es válida.');
    if (!['web', 'mobile', 'alexa'].includes(source)) throw new ChatError('INVALID_SOURCE', 'Canal inválido.');
    if (provider !== 'auto' && !Object.hasOwn(MODELS, provider)) throw new ChatError('INVALID_MODEL', 'Elige un modelo válido.');
    const requestId = suppliedId ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new ChatError('INVALID_REQUEST_ID', 'El identificador de la consulta no es válido.');
    const fingerprint = createHash('sha256').update(JSON.stringify([message, provider, conversationId, source, alexaMode])).digest('hex');
    const convId = conversationId || `${source}-${randomUUID()}`;
    const context = await pool.query(`SELECT role, mensaje FROM (
      SELECT id, role, mensaje FROM chats WHERE user_id=$1 AND conversation_id=$2
      AND deleted_at IS NULL AND role IN ('user','ai') ORDER BY id DESC LIMIT 20
      ) AS recent ORDER BY id ASC`, [userId, convId]);
    const system = { role: 'system', content: alexaMode
      ? 'Responde en español de forma clara, útil y breve. La respuesta será leída por Alexa, así que evita listas largas y sé directo.'
      : 'Responde en español de forma clara, útil y directa.' };
    const history = context.rows.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.mensaje }));
    const question = { role: 'user', content: message };
    const messages = [system, ...history, question];
    // Keep the newest context inside a fixed input budget, before reserving or calling a provider.
    while (Buffer.byteLength(JSON.stringify(messages), 'utf8') > config.maxInputBytes && messages.length > 2) messages.splice(1, 1);
    if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > config.maxInputBytes) throw new ChatError('MESSAGE_TOO_LONG', 'Reduce el texto de tu pregunta.', 413);
    const reservation = await store.reserve({ userId, requestId, fingerprint, source, provider });
    if (reservation.replay) return { ...reservation.replay, replayed: true };
    let answer;
    try {
      answer = await providerCall(reservation.provider, messages);
    } catch (error) {
      await store.fail(userId, requestId, error);
      if (error instanceof ChatError) throw error;
      throw new ChatError('PROVIDER_UNKNOWN', 'No pudimos confirmar la respuesta. La consulta queda reservada.', 502);
    }
    const short = answer.text.replace(/\s+/g, ' ').trim();
    const result = {
      respuesta: answer.text,
      respuesta_alexa: short.length > 850 ? short.slice(0, 850) + '... Puedes ver la respuesta completa en la aplicación.' : short,
      conversation_id: convId, ia: reservation.provider, ia_nombre: providerLabel(reservation.provider), source,
      request_id: requestId, usage: answer.usage,
    };
    try {
      await store.complete({ userId, requestId, result, usage: answer.usage, message,
        conversationId: convId, source, provider: reservation.provider });
    } catch {
      // A provider already answered: never release the hold or resend on a persistence failure.
      throw new ChatError('SAVE_PENDING', 'La respuesta sigue pendiente de guardarse. No se volverá a solicitar al proveedor.', 503);
    }
    return result;
  };
}
