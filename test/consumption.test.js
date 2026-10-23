import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { createApp } from '../index.js';
import { planConfig, ChatError } from '../lib/plans.js';
import { UsageStore } from '../lib/usage-store.js';
import { createChatService } from '../lib/chat-service.js';
import { oauthConfig } from '../lib/oauth.js';

const url = new URL(process.env.TEST_DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.NEXO_ISOLATED_TEST !== 'true' || url.hostname !== '127.0.0.1' || url.pathname !== '/nexo_plans_test' || !url.port || url.port === '5432') {
  throw new Error('Run npm run test:consumption. A new local cluster is required.');
}
const pool = new pg.Pool({ connectionString: url.toString(), max: 12 });
const config = planConfig({ BASIC_REQUEST_LIMIT: '2', PRO_REQUEST_LIMIT: '5', GLOBAL_REQUEST_LIMIT: '10' });
const clock = () => new Date('2026-10-22T12:00:00Z');
let calls = 0;
let provider;
let store;
let ask;
let users;
let server;
let base;
const answer = () => ({ text: 'Respuesta simulada.', usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } });
function service(usageStore = store, cfg = config) {
  return createChatService({ pool, store: usageStore, config: cfg, providerLabel: p => p,
    providerCall: async (...args) => { calls++; return provider(...args); } });
}
const question = (id, extra = {}) => ({ user_id: users[0], mensaje: 'Pregunta de prueba', provider: 'groq_fast',
  source: 'web', request_id: id, ...extra });
before(async () => {
  const app = createApp({ pool, config, oauth: { ...oauthConfig({}), legacyEnabled: true, clientId: 'test-client' },
    alexaVerifier: async () => {}, providerCall: async () => { calls++; return provider(); } });
  await app.locals.initializeLegacyDatabase();
  await pool.query(await readFile(new URL('../migrations/001-plans-consumption.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/002-alexa-oauth.sql', import.meta.url), 'utf8'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE users, ai_budget_periods RESTART IDENTITY CASCADE');
  const { rows } = await pool.query("INSERT INTO users(email,password,email_verified) VALUES ('first@example.test','fake-hash',true), ('second@example.test','fake-hash',true) RETURNING id");
  users = rows.map(u => u.id);
  calls = 0;
  provider = async () => answer();
  store = new UsageStore(pool, config, clock);
  ask = service();
});

test('usuario sin cuota: bloquea sin llamar al proveedor', async () => {
  const cfg = planConfig({ BASIC_REQUEST_LIMIT: '0' });
  await assert.rejects(service(new UsageStore(pool, cfg, clock), cfg)(question('zero')), { code: 'QUOTA_EXHAUSTED' });
  assert.equal(calls, 0);
});
test('modelo no permitido y modelo desconocido: bloquean antes del proveedor', async () => {
  await assert.rejects(ask(question('denied', { provider: 'chatgpt' })), { code: 'MODEL_NOT_ALLOWED' });
  await assert.rejects(ask(question('unknown', { provider: 'invalid' })), { code: 'INVALID_MODEL' });
  assert.equal(calls, 0);
});
test('consulta exitosa: historial y tokens reales en una transacción', async () => {
  const result = await ask(question('ok'));
  assert.equal(result.respuesta, 'Respuesta simulada.');
  const usage = await store.summary(users[0]);
  assert.deepEqual(usage.quota, { unit: 'requests', limit: 2, used: 1, reserved: 0, available: 1 });
  assert.equal(usage.usage.total_tokens, '10');
  assert.equal((await pool.query('SELECT * FROM chats')).rowCount, 2);
  assert.equal((await store.summary(users[1])).quota.used, 0);
});
test('reintento terminado devuelve la misma respuesta sin duplicar consumo ni historial', async () => {
  const first = await ask(question('same'));
  const second = await ask(question('same'));
  assert.equal(second.conversation_id, first.conversation_id);
  assert.equal(second.replayed, true);
  assert.equal(calls, 1);
  assert.equal((await pool.query('SELECT * FROM chats')).rowCount, 2);
  await assert.rejects(ask(question('same', { mensaje: 'otro texto' })), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('reintentos simultáneos hacen una sola llamada', async () => {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  provider = async () => { entered(); await new Promise(resolve => { release = resolve; }); return answer(); };
  const first = ask(question('parallel'));
  await ready;
  await assert.rejects(ask(question('parallel')), { code: 'REQUEST_PENDING' });
  release();
  await first;
  assert.equal(calls, 1);
});
test('diez consultas simultáneas, distintas conexiones y canales: sólo se admiten dos', async () => {
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => ask(question(`race-${i}`, { source: ['web', 'mobile', 'alexa'][i % 3] }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(calls, 2);
  assert.equal((await store.summary(users[0])).quota.available, 0);
});
test('fallo definitivo libera cupo, conserva el error y no reenvía el mismo identificador', async () => {
  provider = async () => { const error = new ChatError('PROVIDER_FAILED', 'Rechazo simulado', 502); error.definitelyRejected = true; throw error; };
  await assert.rejects(ask(question('failed')), { code: 'PROVIDER_FAILED' });
  await assert.rejects(ask(question('failed')), { code: 'PROVIDER_FAILED' });
  assert.equal(calls, 1);
  assert.equal((await store.summary(users[0])).quota.available, 2);
  assert.equal((await pool.query('SELECT * FROM chats')).rowCount, 0);
  provider = async () => answer();
  await ask(question('fresh'));
  assert.equal(calls, 2);
});
test('timeout incierto mantiene reserva y no llama a otro proveedor', async () => {
  provider = async () => { throw new Error('simulated timeout'); };
  await assert.rejects(ask(question('uncertain')), { code: 'PROVIDER_UNKNOWN' });
  await assert.rejects(ask(question('uncertain')), { code: 'REQUEST_PENDING' });
  assert.equal(calls, 1);
  assert.equal((await store.summary(users[0])).quota.reserved, 1);
});
test('fallo al guardar tras respuesta mantiene reserva y revierte historial', async () => {
  await pool.query("ALTER TABLE chats ADD CONSTRAINT reject_test_answer CHECK (mensaje <> 'Respuesta simulada.')");
  try {
    await assert.rejects(ask(question('save-failed')), { code: 'SAVE_PENDING' });
    await assert.rejects(ask(question('save-failed')), { code: 'REQUEST_PENDING' });
    assert.equal((await pool.query('SELECT * FROM chats')).rowCount, 0);
    assert.equal((await store.summary(users[0])).quota.reserved, 1);
    assert.equal(calls, 1);
  } finally { await pool.query('ALTER TABLE chats DROP CONSTRAINT reject_test_answer'); }
});
test('sin reporte de tokens: no inventa consumo y sí cuenta la consulta', async () => {
  provider = async () => ({ text: 'Sin metadatos', usage: null });
  await ask(question('missing-usage'));
  const usage = await store.summary(users[0]);
  assert.equal(usage.usage.unreported_requests, 1);
  assert.equal(usage.quota.used, 1);
});
test('cambio de mes reinicia cupo y conserva el periodo anterior', async () => {
  await ask(question('october'));
  const november = new UsageStore(pool, config, () => new Date('2026-11-01T00:00:00Z'));
  assert.equal((await november.summary(users[0])).quota.available, 2);
  await service(november)(question('november'));
  assert.equal((await store.summary(users[0])).quota.used, 1);
  assert.equal((await november.summary(users[0])).quota.used, 1);
});
test('límite global entre usuarios y eliminación de cuenta no repone presupuesto', async () => {
  const cfg = planConfig({ GLOBAL_REQUEST_LIMIT: '1' });
  const limited = service(new UsageStore(pool, cfg, clock), cfg);
  await limited(question('global-first'));
  await pool.query('DELETE FROM users WHERE id=$1', [users[0]]);
  await assert.rejects(limited(question('global-second', { user_id: users[1] })), { code: 'SERVICE_LIMIT' });
  assert.equal(calls, 1);
});
test('límite global concurrente: dos cuentas compiten por el último cupo', async () => {
  const cfg = planConfig({ GLOBAL_REQUEST_LIMIT: '1' });
  const limited = service(new UsageStore(pool, cfg, clock), cfg);
  const results = await Promise.allSettled([
    limited(question('global-race-a')),
    limited(question('global-race-b', { user_id: users[1] })),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'SERVICE_LIMIT');
  assert.equal(calls, 1);
});
test('reintento después de reiniciar el servicio conserva la respuesta persistida', async () => {
  const first = await ask(question('restart'));
  const restarted = service(new UsageStore(pool, config, clock));
  assert.equal((await restarted(question('restart'))).conversation_id, first.conversation_id);
  assert.equal(calls, 1);
});
test('plan Pro se obtiene de la base, auto selecciona modelo permitido', async () => {
  await pool.query("INSERT INTO ai_accounts(user_id,plan) VALUES ($1,'pro')", [users[0]]);
  assert.equal((await ask(question('pro', { provider: 'chatgpt' }))).ia, 'chatgpt');
  assert.equal((await ask(question('auto', { provider: 'auto' }))).ia, 'groq_fast');
});
test('entrada larga e identificador inválido se rechazan sin consumo', async () => {
  await assert.rejects(ask(question('long', { mensaje: 'a'.repeat(20000) })), { code: 'MESSAGE_TOO_LONG' });
  await assert.rejects(ask(question('bad id')), { code: 'INVALID_REQUEST_ID' });
  assert.equal(calls, 0);
});

async function request(route, body, userId = users[0]) {
  const token = jwt.sign({ user_id: userId }, process.env.JWT_SECRET);
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET',
    headers: { Authorization: token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}
test('HTTP web y móvil: permisos, autenticación y consumo sólo de la cuenta propia', async () => {
  assert.equal((await fetch(base + '/me/usage')).status, 401);
  const forbidden = await request('/preguntar', { mensaje: 'hola', ia: 'chatgpt', plan: 'pro', request_id: 'http-denied' });
  assert.equal(forbidden.status, 403);
  const web = await request('/preguntar', { mensaje: 'web', ia: 'auto', request_id: 'http-web' });
  const mobile = await request('/preguntar', { mensaje: 'mobile', ia: 'auto', source: 'mobile', request_id: 'http-mobile' });
  assert.equal(web.status, 200);
  assert.equal(mobile.body.source, 'mobile');
  assert.equal((await request('/me/usage')).body.quota.used, 2);
  assert.equal((await request('/me/usage', null, users[1])).body.quota.used, 0);
});
test('HTTP Alexa simple y skill pasan por cuota común y reutilizan requestId de Amazon', async () => {
  await pool.query("INSERT INTO alexa_pair_codes(user_id,code,expires_at) VALUES ($1,'123456',CURRENT_TIMESTAMP + INTERVAL '1 hour')", [users[0]]);
  await pool.query("INSERT INTO alexa_links(user_id,alexa_user_id,preferred_ia) VALUES ($1,'synthetic-alexa-user','auto')", [users[0]]);
  assert.equal((await request('/alexa/preguntar', { code: '123456', mensaje: 'simple', request_id: 'simple' })).status, 200);
  const body = { session: { user: { userId: 'synthetic-alexa-user' }, attributes: {} }, request: {
    type: 'IntentRequest', requestId: 'amzn1.echo-api.request.synthetic', intent: { name: 'PreguntaIntent', slots: { pregunta: { value: 'skill' } } } } };
  const first = await request('/alexa/skill', body);
  const retry = await request('/alexa/skill', body);
  assert.deepEqual(first.body, retry.body);
  assert.equal(calls, 2);
  body.request.requestId = 'amzn1.echo-api.request.exhausted';
  const exhausted = await request('/alexa/skill', body);
  assert.match(exhausted.body.response.outputSpeech.text, /Agotaste/);
  assert.equal(calls, 2);
});
