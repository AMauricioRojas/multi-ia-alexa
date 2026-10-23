import fetch from 'node-fetch';

const unavailable = () => new Error('El servicio de correos no está disponible. Inténtalo más tarde.');
function sender(value) {
  const match = String(value || '').trim().match(/^(?:(.*?)\s*<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>|([^<>\s]+@[^<>\s]+\.[^<>\s]+))$/);
  return match ? { name: match[1]?.trim() || 'Zuneri', email: match[2] || match[3] } : null;
}

export function createEmailSender({ env = process.env, fetchImpl = fetch, logger = console, now = Date.now } = {}) {
  const mode = env.MAIL_MODE || 'console';
  const remote = env.NODE_ENV === 'production' || env.RENDER === 'true';
  const from = sender(env.EMAIL_FROM || (mode === 'resend' ? 'Zuneri <onboarding@resend.dev>' : ''));
  const key = mode === 'brevo' ? env.BREVO_API_KEY : mode === 'resend' ? env.RESEND_API_KEY : null;
  const m2m = mode === 'brevo' && Boolean(env.BREVO_CLIENT_ID || env.BREVO_CLIENT_SECRET);
  const available = mode === 'console' ? !remote : ['brevo', 'resend'].includes(mode) && Boolean(from && (m2m ? env.BREVO_CLIENT_ID && env.BREVO_CLIENT_SECRET : key));
  let cachedToken, validUntil = 0, tokenPending;
  async function brevoHeaders() {
    if (!m2m) return { 'api-key': key };
    if (!cachedToken || validUntil <= now()) {
      tokenPending ||= (async () => {
        const response = await fetchImpl('https://api.brevo.com/realms/partner/oauth/token', {
          method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.BREVO_CLIENT_ID, client_secret: env.BREVO_CLIENT_SECRET, scope: 'transactional.email:write' }).toString(),
        });
        const data = await response.json();
        if (!response.ok || data.token_type?.toLowerCase() !== 'bearer' || typeof data.access_token !== 'string' || !data.access_token ||
            !Number.isFinite(data.expires_in) || data.expires_in <= 60 || data.scope !== 'transactional.email:write') throw unavailable();
        cachedToken = data.access_token;
        validUntil = now() + (Math.min(data.expires_in, 3600) - 60) * 1000;
      })();
      try { await tokenPending; } finally { tokenPending = null; }
    }
    return { Authorization: `Bearer ${cachedToken}` };
  }
  return {
    mode, available,
    async send({ to, subject, text, html }) {
      if (!available) throw unavailable();
      if (mode === 'console') {
        logger.log('[LOCAL_EMAIL]', { to, subject, text });
        return { ok: true, mode };
      }
      const brevo = mode === 'brevo';
      let response, data;
      try {
        response = await fetchImpl(brevo ? 'https://api.brevo.com/v3/smtp/email' : 'https://api.resend.com/emails', {
          method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { 'Content-Type': 'application/json', ...(brevo ? await brevoHeaders() : { Authorization: `Bearer ${key}` }) },
          body: JSON.stringify(brevo
            ? { sender: from, to: [{ email: to }], subject, textContent: text, ...(html ? { htmlContent: html } : {}) }
            : { from: `${from.name} <${from.email}>`, to, subject, text, ...(html ? { html } : {}) }),
        });
        data = await response.json();
      } catch { throw unavailable(); }
      // Never log provider bodies: they can contain addresses, codes, or credentials.
      // A timeout might have sent the message, so do not automatically retry.
      if (!response.ok || !(brevo ? data.messageId : data.id)) throw unavailable();
      return { ok: true, mode };
    },
  };
}
