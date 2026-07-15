// POST /contacts/match  (Bearer)
//   body: { phoneHashes: [sha256(normalizedDigits), ...] }   // hex strings
//   returns: [{ id, name, photoURL, phoneHash }, ...]
//
// Lets the mobile app reveal which of the user's address-book contacts
// are also on VaultChat. The phone numbers themselves never reach our
// server — only their SHA-256 hashes (normalized to digits-only, India
// prefix for 10-digit) which match the way we store users.phone_hash.
//
// Rate limit: 5 requests / minute / user, max 5000 hashes per request.
// Privacy: only returns users with discoverable=TRUE.

const express   = require('express');
const crypto    = require('crypto');
const jwtUtil   = require('../jwt');
const db        = require('../db');
const vault     = require('../lib/vault');
const rateLimit = require('../rateLimit');

const router = express.Router();
router.use(jwtUtil.requireAuth);

const MAX_HASHES_PER_REQUEST = 5000;
const HEX64_RE = /^[a-f0-9]{64}$/i;

router.post('/match', async (req, res) => {
  try {
    const rl = await rateLimit.consume(`contacts:${req.user.id}`, 5, 60);
    if (!rl.allowed) {
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: rl.resetInSec,
      });
    }

    const raw = Array.isArray(req.body?.phoneHashes) ? req.body.phoneHashes : null;
    if (!raw) return res.status(400).json({ error: 'phoneHashes array required' });
    if (raw.length > MAX_HASHES_PER_REQUEST) {
      return res.status(413).json({ error: `Max ${MAX_HASHES_PER_REQUEST} hashes per request` });
    }

    // Sanitize: only accept proper SHA-256 hex strings
    const hashes = Array.from(new Set(
      raw.map(s => String(s || '').trim().toLowerCase())
         .filter(s => HEX64_RE.test(s))
    ));
    if (hashes.length === 0) return res.json([]);

    // Pepper each client hash server-side (F1): the stored phone_hash is
    // HMAC(pepper, sha256(digits)), so a stolen users-table dump alone can't be
    // brute-forced over the ~10^10 phone space. Keep a peppered→original map —
    // the client keys its contact list by the hash IT computed, so we must echo
    // that original hash back, never the peppered one.
    const map = new Map();
    for (const h of hashes) map.set(vault.discoveryHash(h), h);

    // Query users by (peppered) phone_hash. RLS is not enabled on users — we
    // filter discoverable here. Self is excluded so the user doesn't get a row
    // for their own number.
    const r = await db.query(
      `SELECT id, name, first_name_cipher, last_name_cipher, email_cipher, photo_url, phone_hash
       FROM users
       WHERE phone_hash = ANY($1::text[])
         AND discoverable = TRUE
         AND is_deleted = FALSE
         AND id <> $2`,
      [Array.from(map.keys()), req.user.id]
    );

    res.json(r.rows.map(row => ({
      id:        row.id,
      name:      vault.identityFromRow(row).name,
      photoURL:  row.photo_url,
      phoneHash: map.get(row.phone_hash) || null,   // the client's ORIGINAL hash
    })));
  } catch (err) {
    console.error('[contacts/match]', err.message);
    res.status(500).json({ error: 'Contact match failed' });
  }
});

// ─── Mutual-consent contact sync ───────────────────────────────────
// One user generates a 6-digit code (5-min, single-use); the other enters
// it to consent. On verify both learn each other's public stub.
function genSyncCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// POST /contacts/sync/create — generate a fresh code (replaces any prior one)
router.post('/sync/create', async (req, res) => {
  try {
    await db.query(`DELETE FROM sync_codes WHERE initiator_id = $1`, [req.user.id]);
    for (let i = 0; i < 6; i++) {
      try {
        const code = genSyncCode();
        await db.query(
          `INSERT INTO sync_codes (code, initiator_id, expires_at)
           VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
          [code, req.user.id]
        );
        return res.json({ success: true, code });
      } catch (e) {
        if (i === 5) throw e; // collided with a live code; retry
      }
    }
  } catch (err) {
    console.error('[sync create]', err.message);
    res.status(500).json({ error: 'Failed to create code' });
  }
});

// GET /contacts/sync/:code — initiator polls for the other party's consent
router.get('/sync/:code', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT expires_at, verified_at FROM sync_codes WHERE code = $1 AND initiator_id = $2 LIMIT 1`,
      [req.params.code, req.user.id]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'expired' });
    res.json({ verified: !!row.verified_at });
  } catch (err) {
    console.error('[sync status]', err.message);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// POST /contacts/sync/verify { code } — the other party consents
router.post('/sync/verify', async (req, res) => {
  try {
    const code = (req.body?.code || '').toString().trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '6-digit code required' });

    const r = await db.query(`SELECT * FROM sync_codes WHERE code = $1 LIMIT 1`, [code]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Invalid code' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Code expired' });
    if (row.initiator_id === req.user.id) return res.status(400).json({ error: 'Cannot sync with yourself' });
    if (row.verified_at) return res.status(409).json({ error: 'Code already used' });

    await db.query(
      `UPDATE sync_codes SET verified_by = $1, verified_at = NOW() WHERE code = $2`,
      [req.user.id, code]
    );
    const u = await db.query(
      `SELECT id, name, email, phone FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1`,
      [row.initiator_id]
    );
    const init = u.rows[0];
    if (!init) return res.status(404).json({ error: 'Initiator no longer exists' });
    res.json({
      success: true,
      initiator: { userId: init.id, displayName: init.name, email: init.email, phoneNumber: init.phone },
    });
  } catch (err) {
    console.error('[sync verify]', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ─── Trusted (emergency) contacts ──────────────────────────────────
const MAX_TRUSTED = 3;

// GET /contacts/trusted — list with public detail
router.get('/trusted', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT tc.contact_id, u.name, u.vault_id, u.online
         FROM trusted_contacts tc JOIN users u ON u.id = tc.contact_id
        WHERE tc.owner_id = $1
        ORDER BY tc.created_at`,
      [req.user.id]
    );
    res.json(r.rows.map(row => ({
      userId:  row.contact_id,
      name:    row.name,
      vaultId: row.vault_id,
      online:  !!row.online,
    })));
  } catch (err) {
    console.error('[trusted GET]', err.message);
    res.status(500).json({ error: 'Failed to load trusted contacts' });
  }
});

// POST /contacts/trusted { vaultId } — add by VaultID handle (max 3)
router.post('/trusted', async (req, res) => {
  try {
    const vid = (req.body?.vaultId || '').toString().replace(/^@/, '').trim();
    if (!vid) return res.status(400).json({ error: 'vaultId required' });

    const u = await db.query(
      `SELECT id, name, vault_id, online FROM users WHERE vault_id = $1 AND is_deleted = FALSE LIMIT 1`,
      [vid]
    );
    const peer = u.rows[0];
    if (!peer) return res.status(404).json({ error: 'No user with that VaultID' });
    if (peer.id === req.user.id) return res.status(400).json({ error: "You can't add yourself" });

    const cnt = await db.query(`SELECT COUNT(*)::int AS n FROM trusted_contacts WHERE owner_id = $1`, [req.user.id]);
    if (cnt.rows[0].n >= MAX_TRUSTED) {
      return res.status(409).json({ error: `Maximum ${MAX_TRUSTED} trusted contacts` });
    }

    const ins = await db.query(
      `INSERT INTO trusted_contacts (owner_id, contact_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING contact_id`,
      [req.user.id, peer.id]
    );
    if (ins.rowCount === 0) return res.status(409).json({ error: 'Already a trusted contact' });

    res.json({ userId: peer.id, name: peer.name, vaultId: peer.vault_id, online: !!peer.online });
  } catch (err) {
    console.error('[trusted POST]', err.message);
    res.status(500).json({ error: 'Failed to add trusted contact' });
  }
});

// DELETE /contacts/trusted/:userId — remove
router.delete('/trusted/:userId', async (req, res) => {
  try {
    await db.query(
      `DELETE FROM trusted_contacts WHERE owner_id = $1 AND contact_id = $2`,
      [req.user.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[trusted DELETE]', err.message);
    res.status(500).json({ error: 'Failed to remove trusted contact' });
  }
});

module.exports = router;
