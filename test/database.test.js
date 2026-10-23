import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { databaseConfig } from '../lib/database.js';

test('remote database URLs require valid certificates even when URL tries to weaken TLS', () => {
  for (const query of ['', '?sslmode=require', '?sslmode=no-verify', '?ssl=0&sslmode=disable', '?uselibpqcompat=true&sslmode=prefer']) {
    const client = new pg.Client(databaseConfig({ DATABASE_URL: `postgresql://synthetic:fake@db.example.test/nexo${query}` }));
    assert.ok(client.connectionParameters.ssl);
    assert.notEqual(client.connectionParameters.ssl.rejectUnauthorized, false);
    assert.equal(client.connectionParameters.ssl.checkServerIdentity, undefined);
    assert.equal(client.connectionParameters.host, 'db.example.test');
  }
});

test('loopback development can use its isolated non-TLS PostgreSQL', () => {
  const client = new pg.Client(databaseConfig({ DATABASE_URL: 'postgresql://test@127.0.0.1:5439/nexo?sslmode=disable' }));
  assert.equal(client.connectionParameters.ssl, false);
  assert.equal(client.connectionParameters.port, 5439);
});
