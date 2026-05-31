// Postgres connection — single shared Pool.
// Env: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS (see .env.example).
// In production behind PgBouncer in transaction mode, set
// PG_STATEMENT_TIMEOUT=10000 to bound long queries.

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST || '127.0.0.1',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'vaultchat',
  user:     process.env.DB_USER || 'vaultchat_user',
  password: process.env.DB_PASS || '',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT || '10000', 10),
});

pool.on('error', (err) => {
  console.error('[db] pool error:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    if (process.env.LOG_SQL === '1') {
      console.log(`[db] ${Date.now() - start}ms ${text.split('\n')[0].slice(0, 80)}`);
    }
    return res;
  } catch (err) {
    console.error('[db] query failed:', text.split('\n')[0].slice(0, 80), '-', err.message);
    throw err;
  }
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function ping() {
  const r = await query('SELECT 1 AS ok');
  return r.rows[0].ok === 1;
}

async function shutdown() {
  await pool.end();
}

module.exports = { pool, query, transaction, ping, shutdown };
