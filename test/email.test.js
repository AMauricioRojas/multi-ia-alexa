import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailSender } from '../lib/email.js';
import { createApp } from '../index.js';

const message = { to: 'synthetic@example.invalid', subject: 'Verificación Zuneri', text: 'Código sintético 123456', html: '<p>Código sintético</p>' };
for (const mode of ['brevo', 'resend']) {
  test(`${mode}: contrato HTTP, plazo y confirmación de aceptación sin correos reales`, async () => {
    let calls = 0;
    const mailer = createEmailSender({ env: { MAIL_MODE: mode, NODE_ENV: 'production', EMAIL_FROM: 'Zuneri <sender@example.invalid>', BREVO_API_KEY: 'synthetic-secret', RESEND_API_KEY: 'synthetic-secret' },
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, mode === 'brevo' ? 'https://api.brevo.com/v3/smtp/email' : 'https://api.resend.com/emails');
        assert.ok(options.signal);
        assert.equal(options.headers[mode === 'brevo' ? 'api-key' : 'Authorization'], mode === 'brevo' ? 'synthetic-secret' : 'Bearer synthetic-secret');
        const body = JSON.parse(options.body);
        assert.equal(body.subject, message.subject);
        assert.equal(mode === 'brevo' ? body.to[0].email : body.to, message.to);
        assert.equal(mode === 'brevo' ? body.textContent : body.text, message.text);
        assert.equal(mode === 'brevo' ? body.htmlContent : body.html, message.html);
        return { ok: true, json: async () => mode === 'brevo' ? { messageId: 'synthetic-id' } : { id: 'synthetic-id' } };
      } });
    assert.equal(mailer.available, true);
    assert.deepEqual(await mailer.send(message), { ok: true, mode });
    assert.equal(calls, 1);
  });
}

test('correo sin configurar o en consola remota nunca imprime códigos ni envía', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { RENDER: 'true', MAIL_MODE: 'console' }, { MAIL_MODE: 'unknown' }, { MAIL_MODE: 'brevo', BREVO_API_KEY: 'synthetic', EMAIL_FROM: 'invalid' }]) {
    const mailer = createEmailSender({ env, logger: { log: () => assert.fail('No codes in logs') }, fetchImpl: () => assert.fail('No network') });
    assert.equal(mailer.available, false);
    await assert.rejects(mailer.send(message), /servicio de correos no está disponible/);
  }
});

test('rechazo y respuesta incierta no filtran detalles ni duplican el envío', async () => {
  for (const kind of ['rejected', 'timeout', 'missing-id']) {
    let calls = 0;
    const mailer = createEmailSender({ env: { MAIL_MODE: 'brevo', BREVO_API_KEY: 'synthetic', EMAIL_FROM: 'sender@example.invalid' }, logger: { log: () => assert.fail('No private logs') }, fetchImpl: async () => {
      calls++;
      if (kind === 'timeout') throw Error('private detail 123456');
      return { ok: kind !== 'rejected', json: async () => ({ error: 'private detail 123456' }) };
    } });
    await assert.rejects(mailer.send(message), error => !error.message.includes('123456') && !error.message.includes('private'));
    assert.equal(calls, 1);
  }
});

test('rutas de correo deshabilitadas responden 503 antes de consultar o cambiar cuentas', async () => {
  const app = createApp({ pool: { query: () => assert.fail('No database writes or reads') }, mailer: createEmailSender({ env: { NODE_ENV: 'production', MAIL_MODE: 'console' } }) });
  const server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const route of ['/register', '/resend-verification', '/forgot-password']) {
      const response = await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: message.to }) });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /servicio de correos/);
    }
    const health = await (await fetch(origin + '/health')).json();
    assert.equal(health.capabilities.email_delivery, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Brevo M2M pide solo correo, comparte el token entre envíos concurrentes y renueva al caducar', async () => {
  let clock = 100000, tokens = 0, deliveries = 0;
  const mailer = createEmailSender({ env: { MAIL_MODE: 'brevo', EMAIL_FROM: 'sender@example.invalid', BREVO_CLIENT_ID: 'synthetic-client', BREVO_CLIENT_SECRET: 'synthetic-secret' }, now: () => clock,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/oauth/token')) {
        tokens++;
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('grant_type'), 'client_credentials');
        assert.equal(form.get('scope'), 'transactional.email:write');
        assert.equal(form.get('client_secret'), 'synthetic-secret');
        return { ok: true, json: async () => ({ token_type: 'Bearer', access_token: `synthetic-token-${tokens}`, expires_in: 3600, scope: 'transactional.email:write' }) };
      }
      deliveries++;
      assert.equal(options.headers.Authorization, `Bearer synthetic-token-${tokens}`);
      assert.equal(options.headers['api-key'], undefined);
      return { ok: true, json: async () => ({ messageId: `synthetic-${deliveries}` }) };
    } });
  await Promise.all([mailer.send(message), mailer.send(message)]);
  assert.equal(tokens, 1);
  clock += 3600000;
  await mailer.send(message);
  assert.equal(tokens, 2);
  assert.equal(deliveries, 3);
});

test('Brevo M2M incompleto o con permisos inesperados no envía ni usa una clave alternativa', async () => {
  const incomplete = createEmailSender({ env: { MAIL_MODE: 'brevo', BREVO_CLIENT_ID: 'synthetic', BREVO_API_KEY: 'synthetic', EMAIL_FROM: 'sender@example.invalid' }, fetchImpl: () => assert.fail('No fallback') });
  assert.equal(incomplete.available, false);
  let calls = 0;
  const broad = createEmailSender({ env: { MAIL_MODE: 'brevo', BREVO_CLIENT_ID: 'synthetic', BREVO_CLIENT_SECRET: 'synthetic', EMAIL_FROM: 'sender@example.invalid' }, fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({ token_type: 'Bearer', access_token: 'synthetic', expires_in: 3600, scope: 'contacts:write transactional.email:write' }) };
  } });
  await assert.rejects(broad.send(message), /servicio de correos/);
  assert.equal(calls, 1);
});
