import fetch from 'node-fetch';

const unavailable = () => new Error('El servicio de correos no está disponible. Inténtalo más tarde.');
function sender(value) {
  const match = String(value || '').trim().match(/^(?:(.*?)\s*<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>|([^<>\s]+@[^<>\s]+\.[^<>\s]+))$/);
  return match ? { name: match[1]?.trim() || 'Zuneri', email: match[2] || match[3] } : null;
}

export function createEmailSender({ env = process.env, fetchImpl = fetch, logger = console } = {}) {
  const mode = env.MAIL_MODE || 'console';
  const remote = env.NODE_ENV === 'production' || env.RENDER === 'true';
  const from = sender(env.EMAIL_FROM || (mode === 'resend' ? 'Zuneri <onboarding@resend.dev>' : ''));
  const key = mode === 'brevo' ? env.BREVO_API_KEY : mode === 'resend' ? env.RESEND_API_KEY : null;
  const available = mode === 'console' ? !remote : ['brevo', 'resend'].includes(mode) && Boolean(key && from);
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
          headers: { 'Content-Type': 'application/json', ...(brevo ? { 'api-key': key } : { Authorization: `Bearer ${key}` }) },
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
