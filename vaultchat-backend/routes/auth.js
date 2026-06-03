// POST /auth/send-otp        { email }                       → 200 { ok: true }
// POST /auth/verify-otp      { email, otp, name? }           → 200 { accessToken, refreshToken, user, isNewUser }
// POST /auth/google          { idToken, name? }              → 200 { accessToken, refreshToken, user, isNewUser }
// POST /auth/refresh         { refreshToken }                → 200 { accessToken, refreshToken }
// POST /auth/logout          (Bearer)  { refreshToken? }     → 200 { ok: true }
//
// Email is the canonical identity. Phone is a profile field only.

const express  = require('express');
const crypto   = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const db        = require('../db');
const otp       = require('../otp');
const email     = require('../email');
const sms       = require('../sms');
const jwtUtil   = require('../jwt');
const rateLimit = require('../rateLimit');

const router = express.Router();

// ── helpers ─────────────────────────────────────────────────────────

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

// Shape sent to the client. Excludes hashes, internal flags, etc.
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
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
  };
}

async function findOrCreateUser({ email, name, googleSub, authProvider }) {
  // Upsert by email. If google_sub provided and user lacks one, link it.
  const existing = await db.query(
    `SELECT * FROM users WHERE email = $1 AND is_deleted = FALSE LIMIT 1`,
    [email]
  );
  if (existing.rows[0]) {
    const u = existing.rows[0];
    const updates = [];
    const params  = [u.id];
    if (googleSub && !u.google_sub) {
      params.push(googleSub);
      updates.push(`google_sub = $${params.length}`);
    }
    if (!u.email_verified_at) {
      updates.push(`email_verified_at = NOW()`);
    }
    if (updates.length) {
      const r = await db.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
        params
      );
      return { user: r.rows[0], isNewUser: false };
    }
    return { user: u, isNewUser: false };
  }
  const ins = await db.query(
    `INSERT INTO users (email, name, google_sub, auth_provider, email_verified_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
    [email, name || null, googleSub || null, authProvider || 'email']
  );
  return { user: ins.rows[0], isNewUser: true };
}

async function issueTokens(user, req) {
  const accessToken  = jwtUtil.signAccess({ sub: user.id, email: user.email });
  const refreshToken = jwtUtil.generateRefreshToken();
  const refreshHash  = await jwtUtil.hashRefresh(refreshToken);
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL, $4, $5)`,
    [
      user.id,
      refreshHash,
      jwtUtil.REFRESH_TTL_SEC.toString(),
      (req.headers['user-agent'] || '').slice(0, 500),
      req.ip || null,
    ]
  );
  return { accessToken, refreshToken };
}

// ── routes ──────────────────────────────────────────────────────────

// POST /auth/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const e = normalizeEmail(req.body?.email);
    if (!e) return res.status(400).json({ error: 'Invalid email' });

    // Rate limit: 3 sends per email per hour, 10 per IP per hour
    const perEmail = await rateLimit.consume(`otp:email:${e}`, 3, 3600);
    if (!perEmail.allowed) {
      return res.status(429).json({ error: 'Too many requests. Try again later.', retryAfter: perEmail.resetInSec });
    }
    const perIP = await rateLimit.consume(`otp:ip:${req.ip}`, 10, 3600);
    if (!perIP.allowed) {
      return res.status(429).json({ error: 'Too many requests. Try again later.', retryAfter: perIP.resetInSec });
    }

    const code = otp.generate();
    const codeHash = await otp.hash(code);

    // Invalidate any prior unconsumed OTPs for this email, then insert new
    await db.transaction(async (client) => {
      await client.query(
        `UPDATE otp_codes SET consumed_at = NOW()
         WHERE email = $1 AND consumed_at IS NULL`,
        [e]
      );
      await client.query(
        `INSERT INTO otp_codes (email, code_hash, expires_at)
         VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)`,
        [e, codeHash, otp.OTP_TTL_SECONDS.toString()]
      );
    });

    await email.sendOTP(e, code);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth/send-otp]', err.message);
    return res.status(500).json({ error: 'Failed to send code' });
  }
});

// POST /auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const e   = normalizeEmail(req.body?.email);
    const code = (req.body?.otp || '').toString().trim();
    const name = (req.body?.name || '').toString().trim() || null;

    if (!e) return res.status(400).json({ error: 'Invalid email' });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'OTP must be 6 digits' });

    // Most-recent unconsumed, unexpired OTP for this email
    const sel = await db.query(
      `SELECT id, code_hash, expires_at, attempts
       FROM otp_codes
       WHERE email = $1 AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY id DESC
       LIMIT 1`,
      [e]
    );
    const row = sel.rows[0];
    if (!row) return res.status(400).json({ error: 'OTP expired or not found. Request a new one.' });

    if (row.attempts >= otp.MAX_ATTEMPTS) {
      await db.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
      return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
    }

    const match = await otp.verify(code, row.code_hash);
    if (!match) {
      await db.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      return res.status(400).json({ error: 'Invalid code' });
    }

    // Consume the OTP, find-or-create user, issue tokens
    await db.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);

    const { user, isNewUser } = await findOrCreateUser({ email: e, name, authProvider: 'email' });
    const tokens = await issueTokens(user, req);

    return res.json({
      ...tokens,
      user: publicUser(user),
      isNewUser,
    });
  } catch (err) {
    console.error('[auth/verify-otp]', err.message);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /auth/google — accepts idToken from @react-native-google-signin
router.post('/google', async (req, res) => {
  try {
    const idToken = (req.body?.idToken || '').toString();
    const name    = (req.body?.name    || '').toString().trim() || null;
    if (!idToken) return res.status(400).json({ error: 'idToken required' });

    // Verify against the same Web Client ID the app uses to sign in.
    // If not configured on the server, verify against any of the project's
    // OAuth clients (Google's library handles that when audience is omitted).
    const audience = process.env.GOOGLE_WEB_CLIENT_ID || undefined;
    const client = new OAuth2Client();
    const ticket = await client.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload?.sub) {
      return res.status(400).json({ error: 'Invalid Google token' });
    }
    if (payload.email_verified === false) {
      return res.status(400).json({ error: 'Google email not verified' });
    }

    const e = normalizeEmail(payload.email);
    if (!e) return res.status(400).json({ error: 'Invalid email in Google token' });

    const { user, isNewUser } = await findOrCreateUser({
      email: e,
      name: name || payload.name || null,
      googleSub: payload.sub,
      authProvider: 'google',
    });
    const tokens = await issueTokens(user, req);

    return res.json({
      ...tokens,
      user: publicUser(user),
      isNewUser,
    });
  } catch (err) {
    console.error('[auth/google]', err.message);
    return res.status(500).json({ error: 'Google sign-in failed' });
  }
});

// POST /auth/refresh — rotate refresh token (revoke old, issue new)
router.post('/refresh', async (req, res) => {
  try {
    const presented = (req.body?.refreshToken || '').toString();
    if (!presented) return res.status(400).json({ error: 'refreshToken required' });

    // We don't know the user id from the token; we have to scan candidates.
    // To bound the scan, we only look at non-revoked, non-expired tokens.
    // For typical traffic this set is tiny per user, but here we don't know
    // the user. Mitigation: keep refresh tokens short (90 days max) and add
    // a candidate prefix lookup later if scale demands.
    const rows = await db.query(
      `SELECT id, user_id, token_hash FROM refresh_tokens
       WHERE revoked_at IS NULL AND expires_at > NOW()
       ORDER BY id DESC
       LIMIT 500`
    );
    let match = null;
    for (const row of rows.rows) {
      if (await jwtUtil.compareRefresh(presented, row.token_hash)) {
        match = row;
        break;
      }
    }
    if (!match) return res.status(401).json({ error: 'Invalid refresh token' });

    // Look up user
    const userRow = await db.query(
      `SELECT * FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1`,
      [match.user_id]
    );
    if (!userRow.rows[0]) {
      await db.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`, [match.id]);
      return res.status(401).json({ error: 'User no longer exists' });
    }
    const user = userRow.rows[0];

    // Rotate: revoke old, issue new
    await db.query(`UPDATE refresh_tokens SET revoked_at = NOW(), last_used_at = NOW() WHERE id = $1`, [match.id]);
    const tokens = await issueTokens(user, req);

    return res.json(tokens);
  } catch (err) {
    console.error('[auth/refresh]', err.message);
    return res.status(500).json({ error: 'Refresh failed' });
  }
});

// POST /auth/logout — invalidate refresh token (Bearer optional but recommended)
router.post('/logout', async (req, res) => {
  try {
    const presented = (req.body?.refreshToken || '').toString();
    if (presented) {
      const rows = await db.query(
        `SELECT id, token_hash FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > NOW() LIMIT 500`
      );
      for (const row of rows.rows) {
        if (await jwtUtil.compareRefresh(presented, row.token_hash)) {
          await db.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`, [row.id]);
          break;
        }
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth/logout]', err.message);
    return res.status(500).json({ error: 'Logout failed' });
  }
});

// ─── Phone OTP (Day 17) ──────────────────────────────────────────
// Same flow as email OTP, but the OTP row carries phone_hash instead of
// email. On verify, either issues tokens (new signup-by-phone) OR — if
// the caller is already authenticated with a Bearer token — stamps the
// verified phone onto the existing account.
//
// Normalisation: digits only, 10-digit numbers assumed Indian (prepend 91).
// E.164 leading + is stripped; clients may pass either format.
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) d = '91' + d;
  return d;
}
function hashPhone(norm) {
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

router.post('/send-otp-phone', async (req, res) => {
  try {
    const norm = normalizePhone(req.body?.phone);
    if (!norm || norm.length < 8) return res.status(400).json({ error: 'Invalid phone' });
    const ph = hashPhone(norm);

    const perPhone = await rateLimit.consume(`otp:phone:${ph}`, 3, 3600);
    if (!perPhone.allowed) return res.status(429).json({ error: 'Too many requests. Try again later.', retryAfter: perPhone.resetInSec });
    const perIP = await rateLimit.consume(`otp:phone-ip:${req.ip}`, 10, 3600);
    if (!perIP.allowed) return res.status(429).json({ error: 'Too many requests. Try again later.', retryAfter: perIP.resetInSec });

    const code     = otp.generate();
    const codeHash = await otp.hash(code);

    await db.transaction(async (client) => {
      await client.query(
        `UPDATE otp_codes SET consumed_at = NOW()
         WHERE phone_hash = $1 AND consumed_at IS NULL`,
        [ph]
      );
      await client.query(
        `INSERT INTO otp_codes (phone_hash, code_hash, expires_at)
         VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)`,
        [ph, codeHash, otp.OTP_TTL_SECONDS.toString()]
      );
    });

    // Send via SMS. Prefix with '+' so Twilio sees E.164.
    await sms.sendOTP(`+${norm}`, code);
    return res.json({ ok: true, dev: !sms.isConfigured() });
  } catch (err) {
    console.error('[auth/send-otp-phone]', err.message);
    return res.status(500).json({ error: 'Failed to send code' });
  }
});

router.post('/verify-otp-phone', async (req, res) => {
  try {
    const norm = normalizePhone(req.body?.phone);
    const code = (req.body?.otp || '').toString().trim();
    const name = (req.body?.name || '').toString().trim() || null;
    if (!norm) return res.status(400).json({ error: 'Invalid phone' });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'OTP must be 6 digits' });

    const ph = hashPhone(norm);

    const sel = await db.query(
      `SELECT id, code_hash, expires_at, attempts
         FROM otp_codes
         WHERE phone_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
         ORDER BY id DESC
         LIMIT 1`,
      [ph]
    );
    const row = sel.rows[0];
    if (!row) return res.status(400).json({ error: 'OTP expired or not found. Request a new one.' });

    if (row.attempts >= otp.MAX_ATTEMPTS) {
      await db.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
      return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
    }

    const match = await otp.verify(code, row.code_hash);
    if (!match) {
      await db.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      return res.status(400).json({ error: 'Invalid code' });
    }

    await db.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);

    // Two modes: linking (caller authenticated) vs signup (no auth header).
    const authHeader = (req.headers.authorization || '').trim();
    let actingUserId = null;
    if (authHeader.startsWith('Bearer ')) {
      try {
        const payload = jwtUtil.verifyAccess(authHeader.slice(7));
        actingUserId = payload.sub;
      } catch { /* fall through to signup mode if token bad */ }
    }

    if (actingUserId) {
      // Linking — stamp the phone onto the existing account. Idempotent.
      // Refuse if another account already claims this phone.
      const conflict = await db.query(
        `SELECT id FROM users WHERE phone_hash = $1 AND id <> $2 AND is_deleted = FALSE LIMIT 1`,
        [ph, actingUserId]
      );
      if (conflict.rows[0]) return res.status(409).json({ error: 'Phone already linked to another account' });

      await db.query(
        `UPDATE users SET phone = $1, phone_hash = $2 WHERE id = $3`,
        [`+${norm}`, ph, actingUserId]
      );
      return res.json({ ok: true, linked: true });
    }

    // Signup-by-phone: phone is canonical only when no other account claims it.
    const existing = await db.query(
      `SELECT * FROM users WHERE phone_hash = $1 AND is_deleted = FALSE LIMIT 1`,
      [ph]
    );
    let user, isNewUser;
    if (existing.rows[0]) {
      user = existing.rows[0];
      isNewUser = false;
    } else {
      // No existing account → create a phone-only user (no email). Need to
      // generate a placeholder email since the column is UNIQUE NOT NULL.
      // Use the phone hash as a deterministic-but-opaque local-part so the
      // user can later add a real email via /user/profile.
      const placeholderEmail = `phone+${ph.slice(0, 12)}@vaultchat.local`;
      const ins = await db.query(
        `INSERT INTO users (email, phone, phone_hash, auth_provider)
         VALUES ($1, $2, $3, 'phone') RETURNING *`,
        [placeholderEmail, `+${norm}`, ph]
      );
      user = ins.rows[0];
      isNewUser = true;
      if (name) {
        await db.query(`UPDATE users SET name = $1 WHERE id = $2`, [name, user.id]);
        user.name = name;
      }
    }

    const tokens = await issueTokens(user, req);
    return res.json({ ...tokens, user: publicUser(user), isNewUser });
  } catch (err) {
    console.error('[auth/verify-otp-phone]', err.message);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

module.exports = router;
