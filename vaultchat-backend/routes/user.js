// GET    /user/profile         (Bearer)               → user
// PUT    /user/profile         (Bearer)  { name?, phone?, dob?, photoURL?, status?, securityQ1?, securityA1?, securityQ2?, securityA2? }
// POST   /user/pin             (Bearer)  { pin }      → { ok: true }      (4-8 digits, hashed)
// POST   /user/pin/verify      (Bearer)  { pin }      → { ok: boolean }
// DELETE /user/account         (Bearer)               → soft delete

const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');

const db      = require('../db');
const jwtUtil = require('../jwt');

const router = express.Router();

router.use(jwtUtil.requireAuth);

const PIN_BCRYPT_ROUNDS = 10;

function publicUser(row) {
  if (!row) return null;
  return {
    id:        row.id,
    email:     row.email,
    name:      row.name,
    phone:     row.phone,
    photoURL:  row.photo_url,
    dob:       row.dob,
    status:    row.status,
    online:    row.online,
    lastSeen:  row.last_seen_at,
    authProvider: row.auth_provider,
    hasPin:    !!row.pin_hash,
    faceCount: row.face_count,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
  };
}

async function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// GET /user/profile
router.get('/profile', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT * FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1`,
      [req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json(publicUser(r.rows[0]));
  } catch (err) {
    console.error('[user/profile GET]', err.message);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PUT /user/profile
router.put('/profile', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [];
    const params = [req.user.id];

    function add(col, val, transform) {
      if (val === undefined) return;
      const v = transform ? transform(val) : val;
      if (v === null || v === '') {
        params.push(null);
      } else {
        params.push(v);
      }
      sets.push(`${col} = $${params.length}`);
    }

    add('name',      b.name,      (v) => v.toString().trim().slice(0, 100));
    add('phone',     b.phone,     (v) => v.toString().trim().slice(0, 32));
    add('photo_url', b.photoURL,  (v) => v.toString().trim().slice(0, 1024));
    add('status',    b.status,    (v) => v.toString().trim().slice(0, 200));

    if (b.dob) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.dob)) {
        return res.status(400).json({ error: 'dob must be YYYY-MM-DD' });
      }
      params.push(b.dob);
      sets.push(`dob = $${params.length}`);
    }

    // Phone — normalize (digits-only, India default for 10-digit input),
    // store hash for contact lookup. Same normalization used by
    // routes/chats.js so writes and lookups produce matching hashes.
    if (b.phone) {
      const raw = b.phone.toString();
      let digits = raw.replace(/\D/g, '');
      if (digits.length === 10) digits = '91' + digits;
      const h = crypto.createHash('sha256').update(digits, 'utf8').digest('hex');
      params.push(h);
      sets.push(`phone_hash = $${params.length}`);
    }

    // Security Qs — hash answers, never store raw
    if (b.securityQ1 !== undefined) { params.push(b.securityQ1 || null); sets.push(`security_q1 = $${params.length}`); }
    if (b.securityA1 !== undefined) {
      const h = b.securityA1 ? await sha256Hex(b.securityA1.toString().toLowerCase().trim()) : null;
      params.push(h);
      sets.push(`security_a1_hash = $${params.length}`);
    }
    if (b.securityQ2 !== undefined) { params.push(b.securityQ2 || null); sets.push(`security_q2 = $${params.length}`); }
    if (b.securityA2 !== undefined) {
      const h = b.securityA2 ? await sha256Hex(b.securityA2.toString().toLowerCase().trim()) : null;
      params.push(h);
      sets.push(`security_a2_hash = $${params.length}`);
    }

    if (!sets.length) {
      // Nothing to update — return current profile
      const cur = await db.query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [req.user.id]);
      return res.json(publicUser(cur.rows[0]));
    }

    const r = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1 AND is_deleted = FALSE RETURNING *`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json(publicUser(r.rows[0]));
  } catch (err) {
    console.error('[user/profile PUT]', err.message);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /user/pin — set or update the app PIN (4-8 digits, hashed)
router.post('/pin', async (req, res) => {
  try {
    const pin = (req.body?.pin || '').toString();
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4-8 digits' });
    const hash = await bcrypt.hash(pin, PIN_BCRYPT_ROUNDS);
    await db.query(`UPDATE users SET pin_hash = $1 WHERE id = $2 AND is_deleted = FALSE`, [hash, req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[user/pin POST]', err.message);
    return res.status(500).json({ error: 'Failed to save PIN' });
  }
});

// POST /user/pin/verify — verify the app PIN
router.post('/pin/verify', async (req, res) => {
  try {
    const pin = (req.body?.pin || '').toString();
    if (!/^\d{4,8}$/.test(pin)) return res.json({ ok: false });
    const r = await db.query(`SELECT pin_hash FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1`, [req.user.id]);
    const h = r.rows[0]?.pin_hash;
    if (!h) return res.json({ ok: false });
    const ok = await bcrypt.compare(pin, h);
    return res.json({ ok });
  } catch (err) {
    console.error('[user/pin/verify]', err.message);
    return res.status(500).json({ error: 'PIN verification failed' });
  }
});

// ─── Push notification devices ───────────────────────────────
// POST /user/devices  { pushToken, platform, deviceName?, appVersion? }
//   Register or refresh a push token for the current user. Idempotent —
//   safe to call on every cold start.
router.post('/devices', async (req, res) => {
  try {
    const pushToken  = (req.body?.pushToken  || '').toString().trim();
    const platform   = (req.body?.platform   || '').toString().trim().toLowerCase();
    const deviceName = req.body?.deviceName  ? String(req.body.deviceName).slice(0, 100) : null;
    const appVersion = req.body?.appVersion  ? String(req.body.appVersion).slice(0, 32)  : null;

    if (!pushToken) return res.status(400).json({ error: 'pushToken required' });
    if (!['ios', 'android', 'web'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be ios | android | web' });
    }

    const r = await db.query(
      `INSERT INTO devices (user_id, push_token, platform, device_name, app_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, push_token) DO UPDATE SET
         platform     = EXCLUDED.platform,
         device_name  = COALESCE(EXCLUDED.device_name, devices.device_name),
         app_version  = COALESCE(EXCLUDED.app_version, devices.app_version),
         last_seen_at = NOW()
       RETURNING id`,
      [req.user.id, pushToken, platform, deviceName, appVersion]
    );
    res.json({ id: r.rows[0].id });
  } catch (err) {
    console.error('[devices POST]', err.message);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// DELETE /user/devices  { pushToken }   — unregister (call on sign-out)
router.delete('/devices', async (req, res) => {
  try {
    const pushToken = (req.body?.pushToken || '').toString().trim();
    if (!pushToken) return res.status(400).json({ error: 'pushToken required' });
    await db.query(
      `DELETE FROM devices WHERE user_id = $1 AND push_token = $2`,
      [req.user.id, pushToken]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[devices DELETE]', err.message);
    res.status(500).json({ error: 'Failed to unregister device' });
  }
});

// ─── TURN credentials for WebRTC calls ────────────────────────
// GET /user/turn  → { iceServers: [...] }
//   Returns time-limited TURN credentials suitable for use as the
//   `iceServers` entry of an RTCPeerConnection. Uses the standard
//   coturn "use-auth-secret" pattern:
//
//     username   = "<expiry-unix>:<user-id>"
//     credential = base64(HMAC-SHA1(TURN_SECRET, username))
//
// The TURN server (turn.corefinite.com) must be configured with the
// same TURN_SECRET we read here. Credentials valid for 24 hours.
router.get('/turn', (req, res) => {
  const secret = process.env.TURN_SECRET || '';
  if (!secret) {
    // No TURN configured — return STUN-only. WebRTC will still try direct
    // P2P; calls work between hosts on the same NAT but fail across most
    // public NATs without a relay.
    return res.json({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });
  }
  const ttlSec   = 24 * 3600;
  const expiry   = Math.floor(Date.now() / 1000) + ttlSec;
  const username = `${expiry}:${req.user.id}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  const host = process.env.TURN_HOST || 'turn.corefinite.com';
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [
          `turn:${host}:3478?transport=udp`,
          `turn:${host}:3478?transport=tcp`,
        ],
        username,
        credential,
      },
      {
        urls: `turns:${host}:5349?transport=tcp`,
        username,
        credential,
      },
    ],
    ttl: ttlSec,
  });
});

// GET /user/export — GDPR data export (Day 15).
// Returns the requesting user's data as one JSON blob: profile, chats they
// belong to, messages they sent or received (membership-scoped), attachments
// they own, devices, blocks, and settings. Stream-friendly content-type;
// client should save to a file.
//
// Caveats:
//   * Message content is opaque (currently plaintext, future ciphertext) —
//     we return it as-is. Clients can decrypt locally once Phase 3b ships.
//   * Attachments are listed as ids only (with filename + size). The actual
//     bytes need to be fetched via /uploads/:id. Including them inline would
//     blow up memory for big accounts.
//   * Bounded to most-recent 10k messages per user (cap). Heavy users can
//     paginate via ?before=:id.
router.get('/export', async (req, res) => {
  try {
    const profileR = await db.query(
      `SELECT * FROM users WHERE id = $1 LIMIT 1`,
      [req.user.id]
    );
    if (!profileR.rows[0]) return res.status(404).json({ error: 'User not found' });
    const profile = publicUser(profileR.rows[0]);

    const settingsR = await db.query(
      `SELECT discoverable, last_seen_visible, read_receipts, profile_photo_visible
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    const settings = settingsR.rows[0] || {};

    const blocksR = await db.query(
      `SELECT blocked_id, created_at FROM user_blocks WHERE blocker_id = $1`,
      [req.user.id]
    );

    const devicesR = await db.query(
      `SELECT platform, push_token, last_seen_at, created_at FROM devices WHERE user_id = $1`,
      [req.user.id]
    );

    const chatsR = await db.query(
      `SELECT c.id, c.type, c.name, c.photo_url, c.created_at,
              cm.role, cm.joined_at, cm.left_at, cm.last_read_message_id
         FROM chats c
         JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1`,
      [req.user.id]
    );

    const messagesR = await db.query(
      `SELECT m.id, m.chat_id, m.sender_id, m.type, m.content, m.meta,
              m.reply_to_id, m.created_at, m.edited_at, m.deleted_at
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
        WHERE cm.left_at IS NULL OR m.created_at <= cm.left_at
        ORDER BY m.id DESC
        LIMIT 10000`,
      [req.user.id]
    );

    const attR = await db.query(
      `SELECT id, filename, mime_type, size_bytes, created_at
         FROM attachments WHERE owner_user_id = $1`,
      [req.user.id]
    );

    const reactionsR = await db.query(
      `SELECT message_id, emoji, created_at
         FROM message_reactions WHERE user_id = $1`,
      [req.user.id]
    );

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vaultchat-export-${req.user.id}.json"`);
    res.json({
      schemaVersion: 1,
      exportedAt:    new Date().toISOString(),
      user: { profile, settings: {
        discoverable:        settings.discoverable,
        lastSeenVisible:     settings.last_seen_visible,
        readReceipts:        settings.read_receipts,
        profilePhotoVisible: settings.profile_photo_visible,
      }},
      blocks:   blocksR.rows.map(r => ({ userId: r.blocked_id, createdAt: r.created_at })),
      devices:  devicesR.rows.map(r => ({
        platform: r.platform,
        // Don't dump full push tokens (they're sensitive credentials) — truncate.
        pushTokenSuffix: (r.push_token || '').slice(-12),
        lastSeenAt: r.last_seen_at, createdAt: r.created_at,
      })),
      chats:    chatsR.rows.map(r => ({
        id: r.id, type: r.type, name: r.name, photoURL: r.photo_url,
        createdAt: r.created_at,
        role: r.role, joinedAt: r.joined_at, leftAt: r.left_at,
        lastReadMessageId: r.last_read_message_id,
      })),
      messages: messagesR.rows.map(r => ({
        id: r.id, chatId: r.chat_id, senderId: r.sender_id, type: r.type,
        content: r.content, meta: r.meta, replyToId: r.reply_to_id,
        createdAt: r.created_at, editedAt: r.edited_at, deletedAt: r.deleted_at,
      })),
      attachments: attR.rows.map(r => ({
        id: r.id, filename: r.filename, mime: r.mime_type, size: r.size_bytes,
        createdAt: r.created_at,
      })),
      reactions: reactionsR.rows.map(r => ({
        messageId: r.message_id, emoji: r.emoji, createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[user/export]', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
});

// DELETE /user/account — soft delete + revoke all refresh tokens
router.delete('/account', async (req, res) => {
  try {
    await db.transaction(async (client) => {
      await client.query(
        `UPDATE users SET is_deleted = TRUE, deleted_at = NOW() WHERE id = $1`,
        [req.user.id]
      );
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [req.user.id]
      );
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[user/account DELETE]', err.message);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ─── Key bundles (Phase 3b foundation) ────────────────────────
//
// X3DH-style prekey bundle distribution. Stored blobs are opaque to the
// server — we never look inside the base64. The crypto is enforced
// entirely on the client.
//
// GET  /user/:id/keybundle   → { identityKey, signedPreKey: {keyId,publicKey,signature}, oneTimePreKey?: {keyId,publicKey} }
//        Atomically claims one unused one-time-prekey for this fetch.
//        Falls back to bundle-without-OTPK if the pool is empty.
//
// POST /user/keybundle (Bearer)  Body: { identityKey?, signedPreKey?: {keyId,publicKey,signature}, oneTimePreKeys?: [{keyId,publicKey}] }
//        Upserts the caller's identity, rotates the signed prekey, and
//        adds the listed one-time prekeys to their pool. Idempotent on
//        keyId — re-uploading the same id is a no-op.
//
// Both routes are membership-agnostic (any signed-in user can fetch any
// public bundle; only the owner can write their own).

const MIN_OTPK_POOL = 10;   // client should top up below this
const MAX_OTPK_UPLOAD = 100; // cap per upload to prevent flood

router.get('/:id/keybundle', async (req, res) => {
  try {
    const targetId = req.params.id;
    if (!targetId) return res.status(400).json({ error: 'user id required' });

    // Atomic OTPK claim: SELECT ... FOR UPDATE SKIP LOCKED inside a tx,
    // stamp used_at, return the row. If pool empty, return bundle anyway.
    const result = await db.transaction(async (client) => {
      const idR = await client.query(
        `SELECT public_key_b64 FROM identity_keys WHERE user_id = $1`,
        [targetId]
      );
      if (!idR.rows[0]) return { missing: true };

      const spR = await client.query(
        `SELECT key_id, public_key_b64, signature_b64
           FROM signed_prekeys
          WHERE user_id = $1 AND retired_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [targetId]
      );

      const otpR = await client.query(
        `SELECT id, key_id, public_key_b64
           FROM one_time_prekeys
          WHERE user_id = $1 AND used_at IS NULL
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [targetId]
      );
      let oneTime = null;
      if (otpR.rows[0]) {
        await client.query(
          `UPDATE one_time_prekeys SET used_at = NOW() WHERE id = $1`,
          [otpR.rows[0].id]
        );
        oneTime = { keyId: otpR.rows[0].key_id, publicKey: otpR.rows[0].public_key_b64 };
      }

      // Tell client how many unused OTPKs remain so it can top up if low.
      const cntR = await client.query(
        `SELECT COUNT(*)::int AS n FROM one_time_prekeys WHERE user_id = $1 AND used_at IS NULL`,
        [targetId]
      );

      return {
        identityKey:    idR.rows[0].public_key_b64,
        signedPreKey:   spR.rows[0] ? {
          keyId:     spR.rows[0].key_id,
          publicKey: spR.rows[0].public_key_b64,
          signature: spR.rows[0].signature_b64,
        } : null,
        oneTimePreKey:  oneTime,
        remainingOtpk:  cntR.rows[0].n,
      };
    });

    if (result.missing) return res.status(404).json({ error: 'User has no key bundle' });
    res.json(result);
  } catch (err) {
    console.error('[user/keybundle GET]', err.message);
    res.status(500).json({ error: 'Failed to load key bundle' });
  }
});

router.post('/keybundle', async (req, res) => {
  try {
    const b = req.body || {};
    const userId = req.user.id;

    const otpkIn = Array.isArray(b.oneTimePreKeys) ? b.oneTimePreKeys : [];
    if (otpkIn.length > MAX_OTPK_UPLOAD) {
      return res.status(400).json({ error: `Too many one-time prekeys (max ${MAX_OTPK_UPLOAD})` });
    }

    await db.transaction(async (client) => {
      if (typeof b.identityKey === 'string' && b.identityKey.length > 0) {
        await client.query(
          `INSERT INTO identity_keys (user_id, public_key_b64)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET public_key_b64 = EXCLUDED.public_key_b64, updated_at = NOW()`,
          [userId, b.identityKey.slice(0, 8192)]
        );
      }

      if (b.signedPreKey
          && typeof b.signedPreKey.keyId     === 'number'
          && typeof b.signedPreKey.publicKey === 'string'
          && typeof b.signedPreKey.signature === 'string') {
        // Retire previous signed prekey, install new one
        await client.query(
          `UPDATE signed_prekeys SET retired_at = NOW()
            WHERE user_id = $1 AND retired_at IS NULL`,
          [userId]
        );
        await client.query(
          `INSERT INTO signed_prekeys (user_id, key_id, public_key_b64, signature_b64)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, key_id) DO UPDATE
             SET public_key_b64 = EXCLUDED.public_key_b64,
                 signature_b64  = EXCLUDED.signature_b64,
                 retired_at     = NULL`,
          [userId, b.signedPreKey.keyId, b.signedPreKey.publicKey.slice(0, 8192), b.signedPreKey.signature.slice(0, 8192)]
        );
      }

      for (const otpk of otpkIn) {
        if (typeof otpk?.keyId !== 'number' || typeof otpk?.publicKey !== 'string') continue;
        await client.query(
          `INSERT INTO one_time_prekeys (user_id, key_id, public_key_b64)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, key_id) DO NOTHING`,
          [userId, otpk.keyId, otpk.publicKey.slice(0, 8192)]
        );
      }
    });

    // Report current pool size so client knows whether it needs more
    const cnt = await db.query(
      `SELECT COUNT(*)::int AS n FROM one_time_prekeys WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );
    res.json({ ok: true, remainingOtpk: cnt.rows[0].n, minPool: MIN_OTPK_POOL });
  } catch (err) {
    console.error('[user/keybundle POST]', err.message);
    res.status(500).json({ error: 'Failed to save key bundle' });
  }
});

// ─── Settings / Privacy (Day 11) ─────────────────────────────
// Discoverable, last-seen visibility, read receipts, photo visibility.
// Stored on the users row; defaults are permissive (true) so the toggles
// match user expectation.

router.get('/settings', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT discoverable, last_seen_visible, read_receipts, profile_photo_visible
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    const row = r.rows[0] || {};
    res.json({
      discoverable:        !!row.discoverable,
      lastSeenVisible:     !!row.last_seen_visible,
      readReceipts:        !!row.read_receipts,
      profilePhotoVisible: !!row.profile_photo_visible,
    });
  } catch (err) {
    console.error('[user/settings GET]', err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [];
    const params = [req.user.id];
    function flag(col, val) {
      if (val === undefined) return;
      params.push(!!val);
      sets.push(`${col} = $${params.length}`);
    }
    flag('discoverable',          b.discoverable);
    flag('last_seen_visible',     b.lastSeenVisible);
    flag('read_receipts',         b.readReceipts);
    flag('profile_photo_visible', b.profilePhotoVisible);

    if (sets.length === 0) return res.json({ ok: true, noop: true });

    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
    res.json({ ok: true });
  } catch (err) {
    console.error('[user/settings PUT]', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ─── Blocks (Day 11) ─────────────────────────────────────────
// GET    /user/blocks            → [{ userId, name, email, photoURL, createdAt }]
// POST   /user/blocks            { userId }
// DELETE /user/blocks/:userId

router.get('/blocks', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT ub.blocked_id, ub.created_at,
              u.name, u.email, u.photo_url
         FROM user_blocks ub
         JOIN users u ON u.id = ub.blocked_id
        WHERE ub.blocker_id = $1
        ORDER BY ub.created_at DESC`,
      [req.user.id]
    );
    res.json(r.rows.map(row => ({
      userId:    row.blocked_id,
      name:      row.name,
      email:     row.email,
      photoURL:  row.photo_url,
      createdAt: row.created_at,
    })));
  } catch (err) {
    console.error('[user/blocks GET]', err.message);
    res.status(500).json({ error: 'Failed to load blocks' });
  }
});

router.post('/blocks', async (req, res) => {
  try {
    const target = (req.body?.userId || '').toString();
    if (!target) return res.status(400).json({ error: 'userId required' });
    if (target === req.user.id) return res.status(400).json({ error: 'cannot block yourself' });
    await db.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, target]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[user/blocks POST]', err.message);
    res.status(500).json({ error: 'Failed to block' });
  }
});

router.delete('/blocks/:userId', async (req, res) => {
  try {
    await db.query(
      `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [req.user.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[user/blocks DELETE]', err.message);
    res.status(500).json({ error: 'Failed to unblock' });
  }
});

module.exports = router;
