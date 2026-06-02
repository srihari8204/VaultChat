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
const jwtUtil   = require('../jwt');
const db        = require('../db');
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

    // Query users by phone_hash. RLS is not enabled on users — we filter
    // discoverable here. Self is excluded so the user doesn't get a row
    // for their own number.
    const r = await db.query(
      `SELECT id, name, photo_url, phone_hash
       FROM users
       WHERE phone_hash = ANY($1::text[])
         AND discoverable = TRUE
         AND is_deleted = FALSE
         AND id <> $2`,
      [hashes, req.user.id]
    );

    res.json(r.rows.map(row => ({
      id:        row.id,
      name:      row.name,
      photoURL:  row.photo_url,
      phoneHash: row.phone_hash,
    })));
  } catch (err) {
    console.error('[contacts/match]', err.message);
    res.status(500).json({ error: 'Contact match failed' });
  }
});

module.exports = router;
