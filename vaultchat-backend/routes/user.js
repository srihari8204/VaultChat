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

    // Phone hash for contact-matching lookup (Phase 5+)
    if (b.phone) {
      const h = await sha256Hex(b.phone.toString().trim());
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

module.exports = router;
