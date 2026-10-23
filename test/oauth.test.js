import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { createApp } from '../index.js';
import { OAuthStore,oauthConfig } from '../lib/oauth.js';
import { planConfig } from '../lib/plans.js';

const db = new URL(process.env.TEST_DATABASE_URL || 'postgresql://invalid/invalid');
if(process.env.NEXO_ISOLATED_TEST!=='true'||db.hostname!=='127.0.0.1'||db.pathname!=='/nexo_plans_test'||!db.port||db.port==='5432')throw new Error('Use npm run test:consumption');
const pool=new pg.Pool({connectionString:db.toString()});
const env={ALEXA_OAUTH_CLIENT_ID:'synthetic-alexa-client',ALEXA_OAUTH_CLIENT_SECRET:'synthetic-client-secret-only-for-isolated-tests',
  JWT_SECRET:process.env.JWT_SECRET,PUBLIC_URL:'http://127.0.0.1',ALEXA_REDIRECT_URIS:'https://pitangui.amazon.com/api/skill/link/TESTVENDOR'};
let config,store,server,base,users,calls;
const verifier=randomBytes(32).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');
function query(extra={}){return {client_id:config.clientId,redirect_uri:config.redirects[0],response_type:'code',state:'synthetic-state',scope:'alexa',code_challenge:challenge,code_challenge_method:'S256',...extra};}
const token=userId=>jwt.sign({user_id:userId},process.env.JWT_SECRET,{expiresIn:'1h'});
async function call(route,{body,auth,cookie,origin=base,headers={}}={}){
  const response=await fetch(base+route,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(auth?{Authorization:auth}:{}),...(cookie?{Cookie:cookie}:{}),Origin:origin,...headers},body:body?JSON.stringify(body):undefined,redirect:'manual'});
  return response;
}
async function codeFor(userId=users[0]){
  const context={...query(),jti:randomUUID()};
  return store.authorize(userId,context);
}
async function exchange(code,extra={}){
  return store.exchange({grant_type:'authorization_code',code,redirect_uri:config.redirects[0],code_verifier:verifier,...extra});
}
before(async()=>{
  config=oauthConfig(env);
  const app=createApp({pool,oauth:config,config:planConfig({}),alexaVerifier:async()=>{},providerCall:async()=>{calls++;return {text:'Respuesta OAuth sintética',usage:{input_tokens:2,output_tokens:3,total_tokens:5}};}});
  await app.locals.initializeLegacyDatabase();
  for(const file of ['001-plans-consumption.sql','002-alexa-oauth.sql'])await pool.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;config.publicUrl=base;
  store=new OAuthStore(pool,config);
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE users,ai_budget_periods RESTART IDENTITY CASCADE');
  const {rows}=await pool.query("INSERT INTO users(email,password,email_verified) VALUES ('oauth-one@example.test','synthetic-hash',true),('oauth-two@example.test','synthetic-hash',true) RETURNING id");
  users=rows.map(r=>r.id);calls=0;
});
test('configuración incompleta o callbacks ajenos desactivan OAuth',()=>{
  assert.equal(config.enabled,true);
  assert.equal(oauthConfig({}).enabled,false);
  assert.equal(oauthConfig({...env,ALEXA_REDIRECT_URIS:'https://evil.test/callback'}).enabled,false);
});
test('PKCE obligatorio, estado obligatorio y redirección exacta',()=>{
  for(const extra of [{redirect_uri:config.redirects[0]+'/evil'},{client_id:'other'},{code_challenge_method:'plain'},{code_challenge:''},{state:''},{scope:'admin'}]){
    assert.throws(()=>store.validateAuthorization(query(extra)));
  }
});
test('página de consentimiento: cookie HttpOnly, CSP y sin redirección abierta',async()=>{
  const page=await call('/oauth/authorize?'+new URLSearchParams(query()));
  assert.equal(page.status,200);assert.match(page.headers.get('set-cookie'),/HttpOnly/);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.match(await page.text(),/Vincular mi cuenta con Alexa/);
  const bad=await call('/oauth/authorize?'+new URLSearchParams(query({redirect_uri:'https://evil.test'})));
  assert.equal(bad.status,400);assert.equal(bad.headers.get('location'),null);
});
async function consent(){
  const page=await call('/oauth/authorize?'+new URLSearchParams(query()));
  const html=await page.text();
  return {transaction:html.match(/id="transaction" type="hidden" value="([^"]+)"/)[1],cookie:page.headers.get('set-cookie').split(';')[0]};
}
test('consentimiento requiere sesión, cookie y mismo origen; conserva state',async()=>{
  const ctx=await consent(),body={transaction:ctx.transaction,decision:'approve'};
  assert.equal((await call('/oauth/authorize',{body,cookie:ctx.cookie})).status,401);
  assert.equal((await call('/oauth/authorize',{body,auth:token(users[0]),cookie:ctx.cookie,origin:'https://evil.test'})).status,400);
  assert.equal((await call('/oauth/authorize',{body,auth:token(users[0])})).status,400);
  const approved=await call('/oauth/authorize',{body,auth:token(users[0]),cookie:ctx.cookie});
  assert.equal(approved.status,200);
  const redirect=new URL((await approved.json()).redirect);
  assert.equal(redirect.searchParams.get('state'),'synthetic-state');assert.ok(redirect.searchParams.get('code'));
  assert.equal((await call('/oauth/authorize',{body,auth:token(users[0]),cookie:ctx.cookie})).status,503);
});
test('cancelación no emite códigos',async()=>{
  const ctx=await consent();
  const response=await call('/oauth/authorize',{body:{transaction:ctx.transaction,decision:'deny'},cookie:ctx.cookie});
  assert.equal(new URL((await response.json()).redirect).searchParams.get('error'),'access_denied');
  assert.equal((await pool.query('SELECT * FROM oauth_codes')).rowCount,0);
});
test('canje con PKCE, código de un uso y almacenamiento sólo de hashes',async()=>{
  const code=await codeFor();
  assert.equal(await exchange(code,{code_verifier:'x'.repeat(43)}),null);
  const tokens=await exchange(code);
  assert.ok(tokens.access_token);assert.equal(tokens.expires_in,3600);
  assert.equal(await exchange(code),null);
  const rows=(await pool.query('SELECT token_hash FROM oauth_tokens')).rows;
  assert.ok(rows.every(row=>/^[a-f0-9]{64}$/.test(row.token_hash)));
  assert.ok(!JSON.stringify(rows).includes(tokens.access_token));
});
test('dos canjes simultáneos crean un único grant',async()=>{
  const code=await codeFor();const results=await Promise.all([exchange(code),exchange(code)]);
  assert.equal(results.filter(Boolean).length,1);
  assert.equal((await pool.query('SELECT * FROM oauth_grants')).rowCount,1);
});
test('endpoint token usa HTTP Basic y errores OAuth sin detalles privados',async()=>{
  const code=await codeFor();
  const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:config.redirects[0],code_verifier:verifier});
  const options={method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body};
  assert.equal((await fetch(base+'/oauth/token',options)).status,401);
  options.headers.Authorization='Basic '+Buffer.from(config.clientId+':'+config.clientSecret).toString('base64');
  const response=await fetch(base+'/oauth/token',options);
  assert.equal(response.status,200);assert.equal((await response.json()).token_type,'Bearer');
  assert.equal(response.headers.get('cache-control'),'no-store');
});
test('renovación rota tokens; reutilizar refresh revoca el grant completo',async()=>{
  const tokens=await exchange(await codeFor());
  assert.ok(await store.identity(tokens.access_token,'synthetic-amazon-user'));
  const rotated=await store.exchange({grant_type:'refresh_token',refresh_token:tokens.refresh_token});
  assert.equal(await store.identity(tokens.access_token,'synthetic-amazon-user'),null);
  assert.ok(await store.identity(rotated.access_token,'synthetic-amazon-user'));
  assert.equal(await store.exchange({grant_type:'refresh_token',refresh_token:tokens.refresh_token}),null);
  assert.equal(await store.identity(rotated.access_token,'synthetic-amazon-user'),null);
});
test('un access token no se puede reutilizar en otra identidad de Alexa',async()=>{
  const tokens=await exchange(await codeFor());
  assert.ok(await store.identity(tokens.access_token,'amazon-a'));
  assert.equal(await store.identity(tokens.access_token,'amazon-b'),null);
});
test('revincular la identidad de Alexa a otra cuenta revoca el grant anterior',async()=>{
  const first=await exchange(await codeFor(users[0]));
  const second=await exchange(await codeFor(users[1]));
  await store.identity(first.access_token,'amazon-shared');
  await store.identity(second.access_token,'amazon-shared');
  assert.equal(await store.identity(first.access_token,'amazon-shared'),null);
  assert.equal((await store.identity(second.access_token,'amazon-shared')).user_id,users[1]);
});
test('incrementar versión de sesión invalida el JWT antiguo sin afectar a otras cuentas',async()=>{
  const session=token(users[0]);
  await pool.query('UPDATE users SET session_version=session_version+1 WHERE id=$1',[users[0]]);
  assert.equal((await call('/me/usage',{auth:session})).status,401);
  assert.equal((await call('/me/usage',{auth:token(users[1])})).status,200);
});
test('tokens y códigos vencidos se rechazan',async()=>{
  const code=await codeFor();await pool.query("UPDATE oauth_codes SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'");
  assert.equal(await exchange(code),null);
  const tokens=await exchange(await codeFor());
  await pool.query("UPDATE oauth_tokens SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'");
  assert.equal(await store.identity(tokens.access_token,'amazon-a'),null);
});
const alexaBody=access=>({context:{System:{user:{userId:'amazon-linked-user',...(access?{accessToken:access}:{})}}},request:{type:'IntentRequest',requestId:'synthetic-question',intent:{name:'PreguntaIntent',slots:{pregunta:{value:'Hola desde Alexa'}}}}});
test('skill usa identidad OAuth y cuota común; token inválido pide vincular sin llamar IA',async()=>{
  const tokens=await exchange(await codeFor());
  assert.equal((await call('/alexa/skill',{body:alexaBody('invalid')})).status,200);
  assert.equal(calls,0);
  const response=await call('/alexa/skill',{body:alexaBody(tokens.access_token)});
  assert.match((await response.json()).response.outputSpeech.text,/Respuesta OAuth/);assert.equal(calls,1);
  const usage=await (await call('/me/usage',{auth:token(users[0])})).json();assert.equal(usage.quota.used,1);
});
test('desvincular revoca acceso y refresh; un token inválido nunca usa el vínculo antiguo',async()=>{
  const tokens=await exchange(await codeFor());await store.identity(tokens.access_token,'amazon-linked-user');
  const response=await fetch(base+'/alexa/unlink',{method:'DELETE',headers:{Authorization:token(users[0])}});
  assert.equal(response.status,200);
  assert.equal(await store.identity(tokens.access_token,'amazon-linked-user'),null);
  assert.equal(await store.exchange({grant_type:'refresh_token',refresh_token:tokens.refresh_token}),null);
  const skill=await call('/alexa/skill',{body:alexaBody(tokens.access_token)});
  assert.equal((await skill.json()).response.card.type,'LinkAccount');assert.equal(calls,0);
});
test('endpoint de código antiguo exige sesión y está deshabilitado por defecto',async()=>{
  assert.equal((await call('/alexa/preguntar',{body:{code:'123456',mensaje:'hola'}})).status,401);
  assert.equal((await call('/alexa/preguntar',{body:{code:'123456',mensaje:'hola'},auth:token(users[0])})).status,410);
  assert.equal(calls,0);
});
test('reportes sólo sobre respuestas propias y sesión eliminada no vuelve a entrar',async()=>{
  const {rows:[chat]}=await pool.query("INSERT INTO chats(user_id,role,mensaje,conversation_id) VALUES ($1,'ai','sintética','report-test') RETURNING id",[users[0]]);
  const body={chat_id:chat.id,category:'unsafe'};
  assert.equal((await call('/content-reports',{body,auth:token(users[1])})).status,404);
  assert.equal((await call('/content-reports',{body,auth:token(users[0])})).status,201);
  const session=token(users[0]);await pool.query('DELETE FROM users WHERE id=$1',[users[0]]);
  assert.equal((await call('/me/usage',{auth:session})).status,401);
});
test('JWT de consentimiento no sirve como sesión de usuario',async()=>{
  const consentToken=store.browserTransaction(query(),'synthetic-binding');
  assert.equal((await call('/me/usage',{auth:consentToken})).status,401);
});
test('ruta HTTPS real rechaza solicitudes sin firma antes de llamar al proveedor',async()=>{
  const app=createApp({pool,oauth:{...config,skillId:'amzn1.ask.skill.required'},providerCall:async()=>assert.fail('No AI expected')});
  const secure=app.listen(0,'127.0.0.1');await new Promise(resolve=>secure.once('listening',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${secure.address().port}/alexa/skill`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(alexaBody())});
    assert.equal(response.status,401);
  }finally{await new Promise(resolve=>secure.close(resolve));}
});
