import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';

// Always creates a NEW cluster. Never reads .env, DATABASE_URL, DB_PASSWORD or the normal PG service.
const root = mkdtempSync(path.join(tmpdir(), 'nexo-plans-test-'));
let bin = process.env.NEXO_TEST_PG_BIN;
if (!bin && process.platform === 'win32') {
  const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL');
  if (existsSync(base)) bin = readdirSync(base).sort().reverse().map(version => path.join(base, version, 'bin'))
    .find(dir => existsSync(path.join(dir, 'initdb.exe')));
}
const command = name => bin ? path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')) : name;
function run(name, args) {
  // A Windows postgres child can retain pg_ctl's pipe handles after pg_ctl exits.
  const result = spawnSync(command(name), args, { encoding: 'utf8', windowsHide: true,
    stdio: name === 'pg_ctl' ? 'ignore' : 'pipe' });
  if (result.error || result.status !== 0) throw new Error(`${name}: ${result.error?.message || result.stderr || result.stdout}`);
}
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const data = path.join(root, 'data');
let started = false;
try {
  run('initdb', ['-D', data, '-U', 'nexo_test', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-w', 'start', '-o', `-h 127.0.0.1 -p ${port} -F`]);
  started = true;
  const admin = new pg.Client({ host: '127.0.0.1', port, database: 'postgres', user: 'nexo_test' });
  await admin.connect();
  await admin.query('CREATE DATABASE nexo_plans_test');
  await admin.end();
  console.log('PostgreSQL temporal iniciado en loopback. Proveedores simulados; sin archivo .env.');
  const env = { ...process.env, NODE_ENV: 'test', NEXO_ISOLATED_TEST: 'true',
    TEST_DATABASE_URL: `postgresql://nexo_test@127.0.0.1:${port}/nexo_plans_test`,
    NEXO_TEST_PSQL: command('psql'), NEXO_TEST_PG_DUMP: command('pg_dump'),
    JWT_SECRET: 'synthetic-isolated-test-signing-key' };
  for (const key of Object.keys(env)) {
    if (/API_KEY|DATABASE_URL|DB_PASSWORD|ADMIN_SECRET|RESEND|PUBLIC_URL/i.test(key) && key !== 'TEST_DATABASE_URL') delete env[key];
  }
  const targets = process.argv.includes('--verify-backup') ? ['scripts/verify-backup.mjs']
    : process.argv.includes('--preview') ? ['test/oauth-preview.mjs']
    : ['--test', '--test-concurrency=1', 'test/consumption.test.js', 'test/providers.test.js', 'test/oauth.test.js', 'test/alexa-security.test.js', 'test/database.test.js'];
  const result = spawnSync(process.execPath, targets, {
    env, stdio: 'inherit', windowsHide: true,
  });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started) {
    run('pg_ctl', ['-D', data, '-w', 'stop', '-m', 'fast']);
    console.log('PostgreSQL temporal detenido.');
  }
}
