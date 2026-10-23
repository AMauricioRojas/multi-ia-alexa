import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createApp } from '../index.js';

// Restore a supplied plain pg_dump only into the disposable cluster made by test-isolated.
// Never prints records, SQL errors with row data, credentials, or original file content.
const url = new URL(process.env.TEST_DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.NEXO_ISOLATED_TEST !== 'true' || url.hostname !== '127.0.0.1'
    || url.pathname !== '/nexo_plans_test') throw new Error('Se requiere el entorno temporal aislado.');
const backupPath = process.env.NEXO_VERIFY_BACKUP;
if (!backupPath) throw new Error('Define NEXO_VERIFY_BACKUP con el respaldo local que deseas verificar.');
const sql = await readFile(backupPath, 'utf8');
if (!sql.includes('-- PostgreSQL database dump') || /COPY[^;]*PROGRAM|CREATE\s+(?:FUNCTION|PROCEDURE|SERVER|EVENT\s+TRIGGER)|^\\(?:!|include|i\s|connect|c\s)/im.test(sql)) {
  throw new Error('El archivo necesita revisión manual antes de restaurarlo.');
}
const pool = new pg.Pool({ connectionString: url.toString() });
try {
  for (const owner of new Set([...sql.matchAll(/(?:OWNER TO |FOR ROLE )([a-zA-Z_][a-zA-Z0-9_]*)(?:;| )/g)].map(m => m[1]))) {
    if (owner !== 'nexo_test') await pool.query(`CREATE ROLE "${owner}"`);
  }
  const restored = spawnSync(process.env.NEXO_TEST_PSQL || 'psql', [
    '--no-psqlrc', '--single-transaction', '-v', 'ON_ERROR_STOP=1', '--dbname', url.toString(), '--file', backupPath,
  ], { encoding: 'utf8', windowsHide: true });
  if (restored.error || restored.status !== 0) {
    const stderr = restored.stderr || '';
    const missingRole = stderr.match(/(?:role|rol) "([a-zA-Z_][a-zA-Z0-9_]*)"/i)?.[1];
    console.error(JSON.stringify({ restore_exit_code: restored.status, executable_error: restored.error?.code,
      missing_role: missingRole, source_line: stderr.match(/:(\d+):/)?.[1],
      unsupported_command: /invalid command|comando no v.lido|unrecognized configuration/i.test(stderr) }));
    throw new Error('El respaldo no pudo restaurarse en la base temporal. No se modificó ningún destino externo.');
  }
  const before = await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM chats) AS chats,
    (SELECT count(*)::int FROM account_delete_requests WHERE status='pending') AS pending_deletions`);
  await createApp({ pool }).locals.initializeLegacyDatabase();
  for (const name of ['001-plans-consumption.sql', '002-alexa-oauth.sql']) {
    await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const after = await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM chats) AS chats,
    (SELECT count(*)::int FROM users WHERE session_version=0) AS session_versions_initialized`);
  if (before.rows[0].users !== after.rows[0].users || before.rows[0].chats !== after.rows[0].chats) {
    throw new Error('Los conteos de usuarios o chats cambiaron durante la verificación.');
  }
  if (process.env.NEXO_PORTABLE_BACKUP) {
    // Historical pairing/reset/verification codes must never regain validity in the new environment.
    await pool.query(`UPDATE users SET alexa_code=NULL, verification_code_hash=NULL,
      verification_expires_at=NULL, reset_code_hash=NULL, reset_expires_at=NULL;
      TRUNCATE alexa_links, alexa_pair_codes, alexa_pair_attempts, auth_attempts;
      UPDATE system_settings SET value='false' WHERE key='keep_alive_enabled'`);
    const exported = spawnSync(process.env.NEXO_TEST_PG_DUMP || 'pg_dump', [
      '--no-owner', '--no-acl', '--no-comments', '--dbname', url.toString(), '--file', process.env.NEXO_PORTABLE_BACKUP,
    ], { encoding: 'utf8', windowsHide: true });
    if (exported.error || exported.status !== 0) throw new Error('No se pudo crear la copia portátil local.');
    console.log('Copia portátil local preparada sin permisos del proveedor anterior ni códigos de acceso históricos.');
  }
  console.log(JSON.stringify({ restored_locally: true, migrations_compatible: true, before: before.rows[0], after: after.rows[0] }));
} finally {
  await pool.end();
}
