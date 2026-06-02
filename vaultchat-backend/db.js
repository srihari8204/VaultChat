// Postgres connection — single shared Pool.
// Env: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS (see .env.example).
//
// Note: PgBouncer in transaction mode rejects `statement_timeout` as a
// startup parameter. To bound long queries enforce it server-side with:
//   ALTER USER vaultchat_app SET statement_timeout = '10s';
// (applied as the user's default — works through PgBouncer without
// any startup-parameter forwarding).

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

// ── User-bound transaction (RLS) ───────────────────────────
// Acquires a dedicated pool client, BEGINs a transaction, sets
// `app.current_user_id` so the RLS policies in 004_rls.sql can see
// who is making the request, runs the callback, COMMITs, releases.
//
// Usage:
//   const rows = await db.withUser(req.user.id, async (c) => {
//     const r = await c.query('SELECT * FROM messages WHERE chat_id = $1', [chatId]);
//     return r.rows;
//   });
//
// Throws and ROLLBACKs on any error. Idempotent if the callback is.
async function withUser(userId, fn) {
  if (!userId) throw new Error('withUser requires a userId');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_user_id = '${String(userId).replace(/'/g, "''")}'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

// Convenience: single-query under a user binding.
async function queryAs(userId, text, params) {
  return withUser(userId, (c) => c.query(text, params));
}

module.exports = { pool, query, transaction, withUser, queryAs, ping, shutdown };
