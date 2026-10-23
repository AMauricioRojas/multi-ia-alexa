import pg from 'pg';
import bcrypt from 'bcrypt';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createApp} from '../index.js';
import {oauthConfig} from '../lib/oauth.js';

const url=new URL(process.env.TEST_DATABASE_URL||'postgresql://invalid/invalid');
if(process.env.NEXO_ISOLATED_TEST!=='true'||url.hostname!=='127.0.0.1'||url.pathname!=='/nexo_plans_test'||!url.port||url.port==='5432')throw new Error('Use npm run preview:oauth');
const pool=new pg.Pool({connectionString:url.toString()});
const oauth=oauthConfig({JWT_SECRET:process.env.JWT_SECRET,PUBLIC_URL:'http://127.0.0.1:57642',
  ALEXA_OAUTH_CLIENT_ID:'synthetic-alexa-client',ALEXA_OAUTH_CLIENT_SECRET:'synthetic-only-for-local-visual-preview',
  ALEXA_REDIRECT_URIS:'https://pitangui.amazon.com/api/skill/link/TESTVENDOR'});
const app=createApp({pool,oauth,providerCall:async()=>({text:'Respuesta local simulada',usage:{input_tokens:2,output_tokens:3,total_tokens:5}})});
await app.locals.initializeLegacyDatabase();
for(const file of ['001-plans-consumption.sql','002-alexa-oauth.sql'])await pool.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
await pool.query('INSERT INTO users(email,password,email_verified) VALUES ($1,$2,true)', ['beta@example.test',await bcrypt.hash('Beta-solo-local-2026!',4)]);
const challenge=createHash('sha256').update('v'.repeat(64)).digest('base64url');
const query=new URLSearchParams({client_id:oauth.clientId,redirect_uri:oauth.redirects[0],response_type:'code',state:'synthetic-local-state',scope:'alexa',code_challenge:challenge,code_challenge_method:'S256'});
const server=app.listen(57642,'127.0.0.1',()=>console.log('Consentimiento local: http://127.0.0.1:57642/oauth/authorize?'+query));
app.get('/_test/stop',(req,res)=>{res.send('Prueba local finalizada.');server.close(async()=>{await pool.end();});});
