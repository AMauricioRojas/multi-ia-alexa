// Require certificate and hostname verification for remote PostgreSQL connections.
// Setting sslmode in the URL avoids pg replacing an explicit ssl object during parsing.
export function databaseConfig(env = process.env) {
  if (!env.DATABASE_URL) return {
    user: 'postgres', host: 'localhost', database: 'ai_platform', password: env.DB_PASSWORD, port: 5432,
  };
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL debe ser PostgreSQL.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local) {
    url.searchParams.set('sslmode', 'verify-full');
    url.searchParams.delete('ssl');
  }
  return { connectionString: url.toString(), max: 5, idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000, enableChannelBinding: true };
}
