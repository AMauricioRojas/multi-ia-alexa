import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

const hash = value => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const equal = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
};

export function oauthConfig(env = process.env) {
  const redirects = String(env.ALEXA_REDIRECT_URIS || '').split(',').map(s => s.trim()).filter(Boolean);
  let validUrls = false;
  try {
    const publicUrl = new URL(env.PUBLIC_URL);
    validUrls = (publicUrl.protocol === 'https:' || (publicUrl.protocol === 'http:' && ['localhost','127.0.0.1'].includes(publicUrl.hostname)))
      && redirects.every(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password
        && ['pitangui.amazon.com','layla.amazon.com','alexa.amazon.co.jp'].includes(url.hostname) && /^\/api\/skill\/link\/[A-Za-z0-9]+$/.test(url.pathname) && !url.search && !url.hash; });
  } catch { /* Invalid or incomplete configuration disables OAuth. */ }
  return {
    enabled: Boolean(validUrls && env.ALEXA_OAUTH_CLIENT_ID && env.ALEXA_OAUTH_CLIENT_SECRET?.length >= 32 && env.JWT_SECRET?.length >= 32 && redirects.length),
    clientId: env.ALEXA_OAUTH_CLIENT_ID || '', clientSecret: env.ALEXA_OAUTH_CLIENT_SECRET || '',
    signingKey: env.JWT_SECRET || '', redirects, publicUrl: env.PUBLIC_URL || '',
    skillId: env.ALEXA_SKILL_ID || '', legacyEnabled: env.ALEXA_LEGACY_PAIRING === 'true',
  };
}

export class OAuthStore {
  constructor(pool, config, clock = () => new Date()) {
    this.pool = pool;
    this.config = config;
    this.clock = clock;
  }
  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  validateAuthorization(query) {
    if (!this.config.enabled) throw new Error('temporarily_unavailable');
    if (query.client_id !== this.config.clientId || !this.config.redirects.includes(query.redirect_uri)) throw new Error('invalid_request');
    if (query.response_type !== 'code' || typeof query.state !== 'string' || !query.state || query.state.length > 1024) throw new Error('invalid_request');
    if (query.scope !== 'alexa' || query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge || '')) throw new Error('invalid_request');
    return Object.fromEntries(['client_id', 'redirect_uri', 'state', 'scope', 'code_challenge'].map(k => [k, query[k]]));
  }
  browserTransaction(query, binding) {
    return jwt.sign({ ...this.validateAuthorization(query), binding: hash(binding) }, this.config.signingKey,
      { algorithm: 'HS256', audience: 'nexo-alexa-consent', issuer: 'nexo-ia', expiresIn: '10m', jwtid: randomUUID() });
  }
  readBrowserTransaction(token, binding) {
    const context = jwt.verify(token, this.config.signingKey, { algorithms: ['HS256'], audience: 'nexo-alexa-consent', issuer: 'nexo-ia' });
    if (!binding || !equal(context.binding, hash(binding))) throw new Error('invalid_request');
    this.validateAuthorization({ ...context, response_type: 'code', code_challenge_method: 'S256' });
    return context;
  }
  async authorize(userId, context) {
    const code = opaque();
    await this.transaction(async client => {
    const used = await client.query('INSERT INTO oauth_consents(id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [context.jti, userId]);
    if (!used.rowCount) throw new Error('Consent already used');
    await client.query(`INSERT INTO oauth_codes(code_hash,user_id,client_id,redirect_uri,code_challenge,scope,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [hash(code), userId, context.client_id, context.redirect_uri,
      context.code_challenge, context.scope, new Date(this.clock().getTime() + 120000)]);
    });
    return code;
  }
  authenticateClient(header, body) {
    if (!this.config.enabled) return false;
    let clientId = body.client_id;
    let secret = body.client_secret;
    if (header?.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const split = decoded.indexOf(':');
      if (split < 0) return false;
      try { clientId = decodeURIComponent(decoded.slice(0, split)); secret = decodeURIComponent(decoded.slice(split + 1)); }
      catch { return false; }
    }
    return equal(clientId, this.config.clientId) && equal(secret, this.config.clientSecret);
  }
  async issue(client, grantId) {
    const access = opaque(), refresh = opaque();
    const now = this.clock().getTime();
    await client.query(`INSERT INTO oauth_tokens(token_hash,grant_id,kind,expires_at) VALUES
      ($1,$3,'access',$4),($2,$3,'refresh',$5)`, [hash(access), hash(refresh), grantId,
      new Date(now + 3600000), new Date(now + 30 * 86400000)]);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'alexa' };
  }
  async exchange(body) {
    if (body.grant_type === 'authorization_code') {
      if (typeof body.code !== 'string' || body.code.length > 256 || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier || '')) return null;
      return this.transaction(async client => {
        const { rows: [code] } = await client.query('SELECT * FROM oauth_codes WHERE code_hash=$1 FOR UPDATE', [hash(body.code)]);
        const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
        if (!code || code.consumed_at || code.expires_at <= this.clock() || code.client_id !== this.config.clientId || code.redirect_uri !== body.redirect_uri || !equal(challenge, code.code_challenge)) return null;
        const grantId = randomUUID();
        await client.query('UPDATE oauth_codes SET consumed_at=$2 WHERE code_hash=$1', [hash(body.code), this.clock()]);
        await client.query('INSERT INTO oauth_grants(id,user_id,client_id) VALUES ($1,$2,$3)', [grantId, code.user_id, code.client_id]);
        return this.issue(client, grantId);
      });
    }
    if (body.grant_type === 'refresh_token') {
      if (typeof body.refresh_token !== 'string' || body.refresh_token.length > 256) return null;
      return this.transaction(async client => {
        const { rows: [token] } = await client.query(`SELECT t.*,g.revoked_at AS grant_revoked,g.client_id
          FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id
          WHERE t.token_hash=$1 FOR UPDATE OF t,g`, [hash(body.refresh_token)]);
        if (!token || token.kind !== 'refresh' || token.grant_revoked || token.client_id !== this.config.clientId || token.expires_at <= this.clock()) return null;
        if (token.consumed_at || token.revoked_at) {
          // Refresh-token reuse revokes the entire grant. Commit the revocation before returning the error.
          await client.query('UPDATE oauth_grants SET revoked_at=$2 WHERE id=$1', [token.grant_id, this.clock()]);
          return null;
        }
        await client.query('UPDATE oauth_tokens SET consumed_at=$2 WHERE token_hash=$1', [hash(body.refresh_token), this.clock()]);
        await client.query("UPDATE oauth_tokens SET revoked_at=$2 WHERE grant_id=$1 AND kind='access'", [token.grant_id, this.clock()]);
        return this.issue(client, token.grant_id);
      });
    }
    throw new Error('unsupported_grant_type');
  }
  async identity(accessToken, alexaUserId) {
    if (!this.config.enabled || typeof accessToken !== 'string' || accessToken.length > 256 || !alexaUserId || alexaUserId === 'unknown-user') return null;
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['alexa:' + alexaUserId]);
      const { rows: [grant] } = await client.query(`SELECT g.id,g.user_id,g.alexa_user_id FROM oauth_tokens t
        JOIN oauth_grants g ON g.id=t.grant_id JOIN users u ON u.id=g.user_id
        WHERE t.token_hash=$1 AND t.kind='access' AND t.revoked_at IS NULL AND t.expires_at>$2
        AND g.revoked_at IS NULL AND g.client_id=$3 AND u.email_verified=true FOR UPDATE OF g`,
      [hash(accessToken), this.clock(), this.config.clientId]);
      if (!grant || (grant.alexa_user_id && grant.alexa_user_id !== alexaUserId)) return null;
      await client.query('UPDATE oauth_grants SET revoked_at=$3 WHERE alexa_user_id=$1 AND id<>$2 AND revoked_at IS NULL', [alexaUserId,grant.id,this.clock()]);
      await client.query('UPDATE oauth_grants SET alexa_user_id=$2 WHERE id=$1', [grant.id, alexaUserId]);
      const { rows: [link] } = await client.query(`INSERT INTO alexa_links(alexa_user_id,user_id,preferred_ia,link_method,oauth_grant_id)
        VALUES ($1,$2,'auto','oauth',$3) ON CONFLICT (alexa_user_id) DO UPDATE SET
        preferred_ia=CASE WHEN alexa_links.user_id=EXCLUDED.user_id THEN alexa_links.preferred_ia ELSE 'auto' END,
        user_id=EXCLUDED.user_id, link_method='oauth', oauth_grant_id=EXCLUDED.oauth_grant_id,updated_at=CURRENT_TIMESTAMP
        RETURNING user_id,preferred_ia`, [alexaUserId, grant.user_id, grant.id]);
      return link;
    });
  }
  async revoke(userId) {
    await this.pool.query('UPDATE oauth_grants SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [userId, this.clock()]);
  }
}

function escape(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function consentPage(transaction) {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Vincular Alexa · Nexo IA</title><link rel="stylesheet" href="/oauth/style.css">
  <main><span>NEXO IA + ALEXA</span><h1>Conecta tu cuenta</h1><p>Alexa podrá enviar tus preguntas a Nexo IA y guardar las respuestas en tu historial. Cada consulta usa el cupo de tu plan.</p>
  <form id="consent"><label>Correo de Nexo IA<input id="email" type="email" autocomplete="username" required maxlength="254"></label>
  <label>Contraseña<input id="password" type="password" autocomplete="current-password" required maxlength="256"></label>
  <p>Al pulsar Vincular autorizas esta conexión. Puedes revocarla desde la app.</p>
  <input id="transaction" type="hidden" value="${escape(transaction)}"><button type="submit">Vincular mi cuenta con Alexa</button>
  <button type="button" id="cancel">Cancelar</button><p id="status" role="status" aria-live="polite"></p></form>
  <p>Si aún no tienes una cuenta o necesitas recuperar tu acceso, <a href="/" target="_blank" rel="noopener noreferrer">abre Nexo IA</a> y vuelve aquí.</p>
  <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacidad</a></main><script src="/oauth/consent.js" defer></script></html>`;
}

const consentScript = `const form=document.getElementById('consent'),status=document.getElementById('status');
const transaction=document.getElementById('transaction').value;
async function decide(deny=false){const buttons=form.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);status.textContent=deny?'Cancelando…':'Conectando…';
try{let token='';if(!deny){const login=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('password').value})});const data=await login.json();if(!login.ok||!data.token)throw new Error(data.needs_verification?'Verifica primero tu correo desde Nexo IA y vuelve a intentarlo.':data.error||'No pudimos iniciar sesión.');token=data.token;document.getElementById('password').value='';}
const response=await fetch('/oauth/authorize',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:token}:{})},body:JSON.stringify({transaction,decision:deny?'deny':'approve'})});const data=await response.json();if(!response.ok)throw new Error('La solicitud expiró. Vuelve a iniciar la vinculación desde Alexa.');window.location.replace(data.redirect);
}catch(error){status.textContent=error.message||'No pudimos conectar. Intenta de nuevo.';buttons.forEach(b=>b.disabled=false);}}
form.addEventListener('submit',event=>{event.preventDefault();decide();});document.getElementById('cancel').addEventListener('click',()=>decide(true));`;

export function mountOAuth(app, { store, auth }) {
  const cookieName = store.config.publicUrl.startsWith('https:') ? '__Host-nexo-oauth' : 'nexo-oauth-local';
  const headers = (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    next();
  };
  app.use('/oauth', headers);
  app.get('/oauth/style.css', (req,res) => res.type('css').send('body{background:#020617;color:#f8fafc;font:16px/1.6 system-ui;margin:0;padding:24px}main{max-width:440px;margin:32px auto;background:#0f172a;padding:28px;border-radius:24px;border:1px solid #334155}h1{line-height:1.2}span,a{color:#7dd3fc}label{display:block;margin:16px 0}input{display:block;box-sizing:border-box;width:100%;padding:12px;border-radius:10px;border:1px solid #64748b;background:#020617;color:white;font:inherit}button{width:100%;padding:13px;border:0;border-radius:10px;background:#2563eb;color:white;font:inherit;font-weight:700;margin:8px 0;cursor:pointer}button:disabled{opacity:.6}#cancel{background:#334155}#status{color:#fda4af}'));
  app.get('/oauth/consent.js', (req,res) => res.type('js').send(consentScript));
  app.get('/oauth/authorize', (req,res) => {
    try {
      const binding = opaque();
      const transaction = store.browserTransaction(req.query, binding);
      res.cookie(cookieName, binding, { httpOnly: true, secure: store.config.publicUrl.startsWith('https:'), sameSite: 'lax', path: '/', maxAge: 600000 });
      res.type('html').send(consentPage(transaction));
    } catch {
      // Log only validation results. Never log OAuth state, challenge, credentials, or the full URL.
      const query = req.query;
      console.warn('[OAUTH_AUTHORIZATION_REJECTED]', JSON.stringify({
        enabled: store.config.enabled, client_matches: query.client_id === store.config.clientId,
        redirect_matches: store.config.redirects.includes(query.redirect_uri), response_code: query.response_type === 'code',
        state_length: typeof query.state === 'string' ? query.state.length : -1,
        scope_matches: query.scope === 'alexa', pkce_s256: query.code_challenge_method === 'S256',
        challenge_length: typeof query.code_challenge === 'string' ? query.code_challenge.length : -1,
        challenge_format: /^[A-Za-z0-9_-]{43}$/.test(query.code_challenge || ''),
      }));
      res.status(store.config.enabled ? 400 : 503).type('text').send('No se pudo iniciar la vinculación. Vuelve a abrirla desde Alexa.');
    }
  });
  app.post('/oauth/authorize', async (req,res,next) => {
    try {
      if (req.get('origin') !== new URL(store.config.publicUrl).origin) throw new Error('invalid_origin');
      const cookie = String(req.headers.cookie || '').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);
      req.oauthContext = store.readBrowserTransaction(req.body.transaction, cookie);
      if (req.body.decision === 'deny') {
        const redirect = new URL(req.oauthContext.redirect_uri); redirect.searchParams.set('error','access_denied'); redirect.searchParams.set('state',req.oauthContext.state);
        return res.json({ redirect: redirect.toString() });
      }
      if (req.body.decision !== 'approve') throw new Error('invalid_decision');
      return auth(req,res,next);
    } catch { res.status(400).json({ error: 'invalid_request' }); }
  }, async (req,res) => {
    try {
      const code = await store.authorize(req.user.user_id, req.oauthContext);
      const redirect = new URL(req.oauthContext.redirect_uri); redirect.searchParams.set('code',code); redirect.searchParams.set('state',req.oauthContext.state);
      res.json({ redirect: redirect.toString() });
    } catch { res.status(503).json({ error: 'temporarily_unavailable' }); }
  });
  app.post('/oauth/token', async (req,res) => {
    if (!store.authenticateClient(req.headers.authorization, req.body)) {
      res.set('WWW-Authenticate', 'Basic realm="Alexa OAuth"');
      return res.status(401).json({ error: 'invalid_client' });
    }
    try {
      const tokens = await store.exchange(req.body);
      if (!tokens) return res.status(400).json({ error: 'invalid_grant' });
      res.json(tokens);
    } catch (error) { res.status(error.message === 'unsupported_grant_type' ? 400 : 503).json({ error: error.message === 'unsupported_grant_type' ? 'unsupported_grant_type' : 'temporarily_unavailable' }); }
  });
}
