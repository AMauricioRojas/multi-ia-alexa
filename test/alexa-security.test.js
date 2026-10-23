import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sign, X509Certificate } from 'node:crypto';
import { createAlexaVerifier, validateCertificateChain } from '../lib/alexa-security.js';

let leaf, root, privateKey;
const skillId = 'amzn1.ask.skill.synthetic-test';
const envelope = () => ({ context: { System: { application: { applicationId: skillId } } },
  request: { requestId: 'synthetic-request', timestamp: new Date().toISOString(), type: 'LaunchRequest' } });
before(() => {
  const dir = mkdtempSync(path.join(tmpdir(),'nexo-alexa-cert-test-'));
  const openssl = process.env.NEXO_TEST_OPENSSL_BIN || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
  const run = args => { const result = spawnSync(openssl,args,{cwd:dir,encoding:'utf8',windowsHide:true}); assert.equal(result.status,0,result.stderr); };
  run(['req','-x509','-newkey','rsa:2048','-noenc','-keyout','root.key','-out','root.pem','-subj','/CN=Nexo isolated test root','-days','2','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  run(['req','-new','-newkey','rsa:2048','-noenc','-keyout','leaf.key','-out','leaf.csr','-subj','/CN=echo-api.amazon.com']);
  writeFileSync(path.join(dir,'ext'),'subjectAltName=DNS:echo-api.amazon.com\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n');
  run(['x509','-req','-in','leaf.csr','-CA','root.pem','-CAkey','root.key','-set_serial','1','-out','leaf.pem','-days','2','-extfile','ext']);
  root = new X509Certificate(readFileSync(path.join(dir,'root.pem')));
  leaf = readFileSync(path.join(dir,'leaf.pem'),'utf8');
  privateKey = readFileSync(path.join(dir,'leaf.key'));
});
function headers(raw, url = 'https://s3.amazonaws.com/echo.api/test.pem') {
  return { signaturecertchainurl: url, 'signature-256': sign('RSA-SHA256',Buffer.from(raw),privateKey).toString('base64') };
}
const verifier = (options = {}) => createAlexaVerifier({ skillId, roots: [root],
  fetchImpl: async () => ({ ok:true, text:async()=>leaf }), ...options });
test('firma RSA-SHA256 real y certificado de prueba válido', async () => {
  const body = envelope(), raw = JSON.stringify(body);
  await verifier()(Buffer.from(raw),headers(raw),body);
});
test('cuerpo manipulado y firma inexistente se rechazan', async () => {
  const body = envelope(), raw = JSON.stringify(body);
  await assert.rejects(verifier()(Buffer.from(raw+' '),headers(raw),body));
  await assert.rejects(verifier()(Buffer.from(raw),{},body));
});
test('skill equivocada y timestamps pasados o futuros se rechazan antes de buscar certificados', async () => {
  for (const scenario of ['skill','past','future','invalid']) {
    const body = envelope();
    if (scenario === 'skill') body.context.System.application.applicationId = 'foreign-skill';
    else body.request.timestamp = scenario === 'invalid' ? 'invalid' : new Date(Date.now()+(scenario==='past'?-180000:180000)).toISOString();
    const raw=JSON.stringify(body);
    await assert.rejects(verifier({ fetchImpl:()=>assert.fail('No certificate request expected') })(Buffer.from(raw),headers(raw),body));
  }
});
test('SSRF: se rechazan hosts, rutas, puertos, esquemas y redirecciones ajenos a Amazon', async () => {
  const body=envelope(),raw=JSON.stringify(body);
  for (const url of ['http://s3.amazonaws.com/echo.api/a','https://evil.test/echo.api/a','https://s3.amazonaws.com.evil.test/echo.api/a',
    'https://s3.amazonaws.com/other/a','https://s3.amazonaws.com:444/echo.api/a','https://user@s3.amazonaws.com/echo.api/a']) {
    await assert.rejects(verifier({fetchImpl:()=>assert.fail('No network expected')})(Buffer.from(raw),headers(raw,url),body));
  }
});
test('cadenas no confiables, vencidas y certificados CA no son firmantes válidos', () => {
  assert.throws(()=>validateCertificateChain(leaf,{roots:[]}));
  assert.throws(()=>validateCertificateChain(leaf,{roots:[root],now:Date.now()+3*86400000}));
  assert.throws(()=>validateCertificateChain(root.toString(),{roots:[root]}));
});
test('caché de certificados se usa sin omitir la verificación de cada firma', async () => {
  let calls=0;
  const verify=verifier({fetchImpl:async()=>{calls++;return {ok:true,text:async()=>leaf};}});
  const body=envelope(),raw=JSON.stringify(body);
  await verify(Buffer.from(raw),headers(raw),body);
  await verify(Buffer.from(raw),headers(raw),body);
  assert.equal(calls,1);
  await assert.rejects(verify(Buffer.from(raw+' '),headers(raw),body));
});
