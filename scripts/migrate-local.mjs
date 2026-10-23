import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createApp } from '../index.js';

// Explicit local-only schema setup. Does not read .env or DATABASE_URL.
const url = new URL(process.env.NEXO_LOCAL_DATABASE_URL || 'postgresql://invalid/invalid');
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/nexo_ia_dev') {
  throw new Error('Define NEXO_LOCAL_DATABASE_URL con una base local llamada nexo_ia_dev. No se permiten otros destinos.');
}
const pool = new pg.Pool({ connectionString: url.toString() });
try {
  const app = createApp({ pool });
  await app.locals.initializeLegacyDatabase();
  await pool.query(await readFile(new URL('../migrations/001-plans-consumption.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/002-alexa-oauth.sql', import.meta.url), 'utf8'));
  console.log('Esquema local nexo_ia_dev preparado.');
} finally {
  await pool.end();
}
