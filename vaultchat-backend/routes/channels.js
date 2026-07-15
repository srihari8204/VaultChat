// Broadcast channels (Telegram-style one-to-many).
//
// All routes require Bearer JWT. An admin creates a channel and is the only
// one who can post; everyone else subscribes (by invite code) and reads.
// Access is enforced here at the route layer — the channel tables carry no
// RLS (same posture as bookmarks / invite_links).
//
// Endpoints:
//   GET    /channels                 — channels you admin or subscribe to
//   POST   /channels                 — create { name, description? }
//   POST   /channels/join            — subscribe { code }
//   GET    /channels/:id/posts       — list posts (subscriber/admin)
//   POST   /channels/:id/posts       — post { text } (admin only)

const express = require('express');
const crypto  = require('crypto');
const jwtUtil = require('../jwt');
const db      = require('../db');
const vault   = require('../lib/vault');
const { sendPushToTokens } = require('../push');

const router = express.Router();
router.use(jwtUtil.requireAuth);

// Realtime fan-out — injected by server.js at boot (emits to `channel:<id>`).
let broadcastChannel = (_channelId, _event, _payload) => {};
function setBroadcaster(fn) { if (fn) broadcastChannel = fn; }

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
function genChannelCode() {
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) { if (i === 4) s += '-'; s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length]; }
  return s; // e.g. "ABCD-2F9K"
}

function publicChannel(row, myId) {
  return {
    id:              row.id,
    name:            row.name,
    description:     row.description,
    adminId:         row.admin_id,
    isAdmin:         row.admin_id === myId,
    inviteCode:      row.invite_code,
    createdAt:       row.created_at,
    lastPostAt:      row.last_post_at,
    lastPost:        row.last_post,
    subscriberCount: row.subscriber_count != null ? parseInt(row.subscriber_count, 10) : undefined,
  };
}

function publicPost(p) {
  const authorName = vault.identityFromRow({
    name: p.author_name, first_name_cipher: p.author_fnc, last_name_cipher: p.author_lnc, email_cipher: p.author_ec,
  }).name;
  return { id: p.id, text: p.text, authorId: p.author_id, authorName, createdAt: p.created_at };
}

async function loadChannel(id) {
  const r = await db.query(`SELECT * FROM channels WHERE id = $1 LIMIT 1`, [id]);
  return r.rows[0] || null;
}
async function isSubscriber(channelId, userId) {
  const r = await db.query(
    `SELECT 1 FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId]
  );
  return r.rowCount > 0;
}

// GET /channels — channels the caller admins or is subscribed to
router.get('/', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM channel_subscribers cs WHERE cs.channel_id = c.id) AS subscriber_count
         FROM channels c
        WHERE c.admin_id = $1
           OR EXISTS (SELECT 1 FROM channel_subscribers cs WHERE cs.channel_id = c.id AND cs.user_id = $1)
        ORDER BY c.last_post_at DESC NULLS LAST, c.created_at DESC
        LIMIT 200`,
      [req.user.id]
    );
    res.json(r.rows.map(row => publicChannel(row, req.user.id)));
  } catch (err) {
    console.error('[channels GET]', err.message);
    res.status(500).json({ error: 'Failed to list channels' });
  }
});

// POST /channels — create { name, description? }
router.post('/', async (req, res) => {
  try {
    const name = (req.body?.name || '').toString().trim().slice(0, 100);
    const description = (req.body?.description || '').toString().trim().slice(0, 500) || null;
    if (!name) return res.status(400).json({ error: 'name required' });

    const created = await db.transaction(async (client) => {
      let row;
      for (let i = 0; i < 5; i++) {
        try {
          const r = await client.query(
            `INSERT INTO channels (name, description, admin_id, invite_code, last_post_at)
             VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
            [name, description, req.user.id, genChannelCode()]
          );
          row = r.rows[0];
          break;
        } catch (e) {
          if (i === 4) throw e; // exhausted retries on unique invite_code collision
        }
      }
      await client.query(
        `INSERT INTO channel_subscribers (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [row.id, req.user.id]
      );
      return row;
    });
    res.json({ ...publicChannel(created, req.user.id), subscriberCount: 1 });
  } catch (err) {
    console.error('[channels POST]', err.message);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// POST /channels/join — subscribe { code }
router.post('/join', async (req, res) => {
  try {
    const code = (req.body?.code || '').toString().trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'code required' });
    const cr = await db.query(`SELECT * FROM channels WHERE invite_code = $1 LIMIT 1`, [code]);
    const ch = cr.rows[0];
    if (!ch) return res.status(404).json({ error: 'No channel with that code' });
    await db.query(
      `INSERT INTO channel_subscribers (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [ch.id, req.user.id]
    );
    const cnt = await db.query(`SELECT COUNT(*) AS n FROM channel_subscribers WHERE channel_id = $1`, [ch.id]);
    res.json({ ...publicChannel(ch, req.user.id), subscriberCount: parseInt(cnt.rows[0].n, 10) });
  } catch (err) {
    console.error('[channels join]', err.message);
    res.status(500).json({ error: 'Failed to join channel' });
  }
});

// GET /channels/:id/posts — newest first, keyset paginated
router.get('/:id/posts', async (req, res) => {
  try {
    const ch = await loadChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    if (ch.admin_id !== req.user.id && !(await isSubscriber(ch.id, req.user.id))) {
      return res.status(403).json({ error: 'Not subscribed' });
    }
    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const params = [ch.id];
    let where = `p.channel_id = $1`;
    if (before && Number.isFinite(before)) { params.push(before); where += ` AND p.id < $${params.length}`; }
    params.push(limit);
    const r = await db.query(
      `SELECT p.*, u.name AS author_name, u.first_name_cipher AS author_fnc,
              u.last_name_cipher AS author_lnc, u.email_cipher AS author_ec
         FROM channel_posts p JOIN users u ON u.id = p.author_id
        WHERE ${where} ORDER BY p.id DESC LIMIT $${params.length}`,
      params
    );
    res.json(r.rows.map(publicPost));
  } catch (err) {
    console.error('[channel posts GET]', err.message);
    res.status(500).json({ error: 'Failed to load posts' });
  }
});

// POST /channels/:id/posts — admin only { text }
router.post('/:id/posts', async (req, res) => {
  try {
    const ch = await loadChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    if (ch.admin_id !== req.user.id) return res.status(403).json({ error: 'Only the admin can post' });
    const text = (req.body?.text || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > 4000) return res.status(413).json({ error: 'post too long (max 4000)' });

    const post = await db.transaction(async (client) => {
      const r = await client.query(
        `INSERT INTO channel_posts (channel_id, author_id, text) VALUES ($1, $2, $3) RETURNING *`,
        [ch.id, req.user.id, text]
      );
      await client.query(
        `UPDATE channels SET last_post = $1, last_post_at = $2 WHERE id = $3`,
        [text.slice(0, 80), r.rows[0].created_at, ch.id]
      );
      return r.rows[0];
    });

    // Realtime: push the new post to every subscriber currently viewing.
    const nameR = await db.query(
      `SELECT name, first_name_cipher, last_name_cipher, email_cipher FROM users WHERE id = $1`, [req.user.id]
    );
    const out = {
      id: post.id, text: post.text, authorId: post.author_id,
      authorName: vault.identityFromRow(nameR.rows[0] || {}).name, createdAt: post.created_at,
    };
    broadcastChannel(ch.id, 'channel_post', out);
    res.json(out);

    // Fire-and-forget push to subscribers (excluding the author).
    (async () => {
      try {
        const subR = await db.query(
          `SELECT user_id FROM channel_subscribers WHERE channel_id = $1 AND user_id <> $2`,
          [ch.id, req.user.id]
        );
        if (!subR.rows.length) return;
        const tokR = await db.query(
          `SELECT push_token FROM devices WHERE user_id = ANY($1::uuid[])`,
          [subR.rows.map(r => r.user_id)]
        );
        const tokens = tokR.rows.map(r => r.push_token).filter(Boolean);
        if (tokens.length) {
          // Content-free (F2): never put the post text or channel name in the
          // push — it transits Expo + FCM/APNs in the clear. Routing data only.
          await sendPushToTokens(tokens, {
            title: 'VaultChat',
            body:  'New channel post',
            data:  { type: 'channel_post', channelId: ch.id },
          });
        }
      } catch (e) { console.error('[channel push]', e.message); }
    })();
  } catch (err) {
    console.error('[channel posts POST]', err.message);
    res.status(500).json({ error: 'Failed to post' });
  }
});

module.exports = router;
module.exports.setBroadcaster = setBroadcaster;
