// routes/admin.js — Admin Console API.
//
// Protected by an x-admin-key header checked against process.env.ADMIN_KEY
// (NOT user JWT). Rate-limited. Privacy-preserving: message content / ciphertext
// is NEVER returned — only metadata. The live runtime (Socket.IO instance +
// online-user map) is injected by server.js via setRuntime().

const express   = require('express');
const os        = require('os');
const crypto    = require('crypto');
const db        = require('../db');
const redis     = require('../redis');
const rateLimit = require('../rateLimit');

const router = express.Router();

// Constant-time key comparison (hash both sides so length never leaks and the
// compare time can't be used to recover the key byte-by-byte).
function safeKeyEqual(a, b) {
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ── Runtime injected from server.js ─────────────────────────────────
let io = null;
let getOnlineCount = () => 0;   // () => userSockets.size
function setRuntime(rt) {
  if (rt.io) io = rt.io;
  if (typeof rt.getOnlineCount === 'function') getOnlineCount = rt.getOnlineCount;
}

// ── Auth + rate limit ───────────────────────────────────────────────
async function adminAuth(req, res, next) {
  const key = req.get('x-admin-key') || '';
  const expected = process.env.ADMIN_KEY || '';
  if (!expected) return res.status(503).json({ error: 'ADMIN_KEY not configured on server' });
  if (!safeKeyEqual(key, expected)) return res.status(401).json({ error: 'Invalid admin key' });
  try {
    // Real client IP behind Cloudflare→nginx. CF-Connecting-IP can't be spoofed
    // through Cloudflare; fall back through nginx's X-Real-IP / XFF / req.ip.
    const ip = (req.get('cf-connecting-ip') || req.get('x-real-ip')
      || (req.headers['x-forwarded-for'] || '').toString().split(',')[0] || req.ip || 'admin').toString().trim();
    const rl = await rateLimit.consume(`admin:${ip}`, 120, 60); // 120 req / min
    if (!rl.allowed) return res.status(429).json({ error: 'Rate limited', retryAfter: rl.resetInSec });
  } catch { /* fail open on limiter error */ }
  next();
}
router.use(adminAuth);

// ── GET /api/admin/stats ────────────────────────────────────────────
router.get('/stats', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE is_deleted = FALSE)                               AS total_users,
        (SELECT COUNT(*) FROM messages)                                                     AS total_messages,
        (SELECT COUNT(*) FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > NOW()) AS active_sessions,
        (SELECT pg_database_size(current_database()))                                       AS db_size`);
    const row = r.rows[0];
    res.json({
      totalUsers:     parseInt(row.total_users, 10),
      onlineNow:      getOnlineCount(),
      totalMessages:  parseInt(row.total_messages, 10),
      activeSessions: parseInt(row.active_sessions, 10),
      dbSizeMB:       Math.round((parseInt(row.db_size, 10) / 1048576) * 10) / 10,
      uptime:         Math.round(process.uptime()),
    });
  } catch (err) {
    console.error('[admin/stats]', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── GET /api/admin/users?limit=&offset=&q= ──────────────────────────
router.get('/users', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const q      = (req.query.q || '').toString().trim();
    const like   = `%${q.replace(/[%_]/g, '\\$&')}%`;

    const where  = q ? `WHERE name ILIKE $1 OR email::text ILIKE $1 OR phone ILIKE $1` : '';
    const params = q ? [like, limit, offset] : [limit, offset];
    const li = q ? '$2' : '$1';
    const oi = q ? '$3' : '$2';

    const rows = await db.query(
      `SELECT id, name, email, phone, online, last_seen_at, created_at, is_deleted, auth_provider
         FROM users ${where}
        ORDER BY created_at DESC
        LIMIT ${li} OFFSET ${oi}`,
      params
    );
    const total = await db.query(
      `SELECT COUNT(*) AS n FROM users ${q ? 'WHERE name ILIKE $1 OR email::text ILIKE $1 OR phone ILIKE $1' : ''}`,
      q ? [like] : []
    );
    res.json({
      total: parseInt(total.rows[0].n, 10),
      limit, offset,
      users: rows.rows.map(u => ({
        id: u.id, displayName: u.name, email: u.email, phone: u.phone,
        isOnline: u.online, lastSeen: u.last_seen_at, createdAt: u.created_at,
        isDeleted: u.is_deleted, authProvider: u.auth_provider,
      })),
    });
  } catch (err) {
    console.error('[admin/users]', err.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ── GET /api/admin/messages?limit= — METADATA ONLY (no content) ─────
router.get('/messages', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const r = await db.query(
      `SELECT id, chat_id, sender_id, type, reply_to_id, edited_at, deleted_at, created_at
         FROM messages ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    res.json({
      messages: r.rows.map(m => ({
        id: String(m.id), chatId: m.chat_id, senderId: m.sender_id, type: m.type,
        replyToId: m.reply_to_id ? String(m.reply_to_id) : null,
        // No per-message delivery column exists (delivery tracked per member);
        // derive a coarse status from the metadata we DO have.
        status: m.deleted_at ? 'deleted' : m.edited_at ? 'edited' : 'sent',
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    console.error('[admin/messages]', err.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// ── GET /api/admin/sessions — active refresh tokens (= sessions) ────
router.get('/sessions', async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT rt.id, rt.user_id, u.email, u.name, rt.user_agent, rt.ip,
              rt.created_at, rt.last_used_at, rt.expires_at
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.revoked_at IS NULL AND rt.expires_at > NOW()
        ORDER BY rt.last_used_at DESC NULLS LAST
        LIMIT 200`
    );
    res.json({
      sessions: r.rows.map(s => ({
        id: String(s.id), userId: s.user_id, email: s.email, name: s.name,
        device: s.user_agent || 'Unknown device', ip: s.ip,
        createdAt: s.created_at, lastUsedAt: s.last_used_at, expiresAt: s.expires_at,
      })),
    });
  } catch (err) {
    console.error('[admin/sessions]', err.message);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

// ── DELETE /api/admin/sessions/:id — revoke ─────────────────────────
router.delete('/sessions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const r = await db.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Session not found or already revoked' });
    res.json({ ok: true, revoked: String(id) });
  } catch (err) {
    console.error('[admin/sessions DELETE]', err.message);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

// ── POST /api/admin/broadcast { type, text } ────────────────────────
router.post('/broadcast', (req, res) => {
  try {
    const type = (req.body?.type || 'info').toString().slice(0, 32);
    const text = (req.body?.text || '').toString().trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'text required' });
    if (!io) return res.status(503).json({ error: 'Socket layer not ready' });
    const payload = { type, text, ts: Date.now() };
    io.emit('system:announcement', payload);
    res.json({ ok: true, delivered: getOnlineCount(), payload });
  } catch (err) {
    console.error('[admin/broadcast]', err.message);
    res.status(500).json({ error: 'Failed to broadcast' });
  }
});

// ── GET /api/admin/health-detail ────────────────────────────────────
router.get('/health-detail', async (_req, res) => {
  // Postgres ping
  let pgMs = null, pgOk = false;
  try { const t = Date.now(); await db.ping(); pgMs = Date.now() - t; pgOk = true; } catch {}

  // Redis ping
  let redisMs = null, redisOk = redis.isConnected();
  try { const t = Date.now(); await redis.client.ping(); redisMs = Date.now() - t; redisOk = true; } catch {}

  // App pg pool (PgBouncer sits in front; these are the app-side pool stats)
  const pool = db.pool || {};
  const poolStats = {
    total:   pool.totalCount ?? null,
    idle:    pool.idleCount ?? null,
    waiting: pool.waitingCount ?? null,
  };

  // Ollama reachability (local LLM, if deployed)
  let ollama = false;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch('http://localhost:11434/api/tags', { signal: ctrl.signal });
    clearTimeout(to);
    ollama = r.ok;
  } catch { ollama = false; }

  const mem = process.memoryUsage();
  res.json({
    postgres: { ok: pgOk, pingMs: pgMs },
    redis:    { ok: redisOk, pingMs: redisMs },
    pgbouncer: poolStats,
    ollama:   { reachable: ollama },
    system: {
      uptimeSec:    Math.round(process.uptime()),
      loadAvg:      os.loadavg().map(n => Math.round(n * 100) / 100),
      cpuCount:     os.cpus().length,
      totalMemMB:   Math.round(os.totalmem() / 1048576),
      freeMemMB:    Math.round(os.freemem() / 1048576),
      rssMB:        Math.round(mem.rss / 1048576),
      heapUsedMB:   Math.round(mem.heapUsed / 1048576),
      nodeVersion:  process.version,
    },
  });
});

module.exports = router;
module.exports.setRuntime = setRuntime;
