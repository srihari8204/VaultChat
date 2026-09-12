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
const vault     = require('../lib/vault');

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
  const id = vault.identityFromRow(row);
  return {
    id:        row.id,
    email:     id.email,
    name:      id.name,
    phone:     id.phone,
    photoURL:  row.photo_url,
    dob:       id.dob,
    status:    id.status,
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

/**
 * A refresh token's SEARCHABLE identity (migration 127, audit F05/F06).
 *
 * HMAC-SHA256(VAULTCHAT_LOOKUP_PEPPER, 'refresh:'||token), hex — the same
 * primitive and the same pepper the Go backend uses, so a row written by
 * either side is found by the other. That matters precisely because this
 * backend is the ROLLBACK target: tokens issued here must keep working if
 * traffic moves back to Go, and vice versa.
 *
 * Deterministic, so one indexed equality finds the row; keyed, so a stolen
 * database cannot be scanned against a dictionary of guessed tokens. bcrypt in
 * token_hash is still the verifier — this finds the row, it does not authorise
 * it.
 *
 * Returns null when the pepper is unset, and every caller treats that as "use
 * the legacy scan" rather than failing: a misconfigured environment must not
 * lock every user out of refreshing.
 */
function refreshLookup(token) {
  if (!token) return null;
  try { return vault.lookupHash('refresh:' + token); }
  catch { return null; }
}

async function issueTokens(user, req) {
  const accessToken  = jwtUtil.signAccess({ sub: user.id, email: user.email });
  const refreshToken = jwtUtil.generateRefreshToken();
  const refreshHash  = await jwtUtil.hashRefresh(refreshToken);
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip, token_lookup)
     VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL, $4, $5, $6)`,
    [
      user.id,
      refreshHash,
      jwtUtil.REFRESH_TTL_SEC.toString(),
      (req.headers['user-agent'] || '').slice(0, 500),
      req.ip || null,
      refreshLookup(refreshToken),
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

    // Dev-only fixed OTP bypass: when DEV_OTP is set in the environment the
    // matching code is accepted without SMS/email. NEVER set DEV_OTP in a real
    // production deployment — it makes every account loginable with that code.
    const match = (process.env.DEV_OTP && code === process.env.DEV_OTP) || await otp.verify(code, row.code_hash);
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

    // Grace window: also accept a token revoked in the last 30s. Refresh tokens
    // rotate (single-use), so a burst of concurrent requests on app-resume can
    // race — the client dedupes, but this is belt-and-suspenders so a slightly-
    // late retry still succeeds instead of logging the user out.
    //
    // AUDIT F07: the grace is for ROTATION ONLY. It used to key off revoked_at
    // alone, and an explicit revocation sets the same column — so a device
    // kicked from the sessions screen kept minting fresh credentials for 30
    // seconds after being signed out. revoked_reason separates the two.
    const GRACE_SEC = 30;
    const GRACE = `(revoked_at IS NULL
                    OR (revoked_reason = 'rotated'
                        AND revoked_at > NOW() - ($1 || ' seconds')::INTERVAL))`;

    // AUDIT F05: this used to select the newest 500 eligible rows ACROSS ALL
    // USERS and bcrypt-compare each. Past 500 live rows a perfectly valid older
    // token stopped being found and the user was signed out — a ROW limit, not
    // a user limit, and rotation across several devices reaches it quickly. An
    // invalid token also burned up to 500 bcrypt comparisons, which is a free
    // CPU-exhaustion lever.
    //
    // Now: one indexed equality on token_lookup. The scan survives only for
    // rows written before migration 127, which cannot be backfilled (the
    // plaintext was never stored) and which expire on their own within
    // JWT_REFRESH_TTL. Restricting it to token_lookup IS NULL means it shrinks
    // to nothing instead of growing.
    let match = null;
    const lookup = refreshLookup(presented);
    if (lookup) {
      const hit = await db.query(
        `SELECT id, user_id, token_hash, revoked_at FROM refresh_tokens
          WHERE token_lookup = $2 AND expires_at > NOW() AND ${GRACE}
          LIMIT 1`,
        [GRACE_SEC.toString(), lookup],
      );
      if (hit.rows[0] && await jwtUtil.compareRefresh(presented, hit.rows[0].token_hash)) {
        match = hit.rows[0];
      }
    }
    if (!match) {
      const rows = await db.query(
        `SELECT id, user_id, token_hash, revoked_at FROM refresh_tokens
          WHERE token_lookup IS NULL AND expires_at > NOW() AND ${GRACE}
          ORDER BY id DESC
          LIMIT 500`,
        [GRACE_SEC.toString()],
      );
      for (const row of rows.rows) {
        if (await jwtUtil.compareRefresh(presented, row.token_hash)) {
          match = row;
          break;
        }
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

    // Rotate: revoke old (unless it's a grace re-use of an already-revoked token,
    // in which case don't double-revoke), issue new.
    if (!match.revoked_at) {
      // revoked_reason = 'rotated' is what earns the 30s grace above. Anything
      // that revokes for another reason must NOT write this value.
      await db.query(
        `UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = 'rotated', last_used_at = NOW()
          WHERE id = $1`, [match.id]);
    } else {
      await db.query(`UPDATE refresh_tokens SET last_used_at = NOW() WHERE id = $1`, [match.id]);
    }
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
  // Peppered (F1): HMAC(pepper, sha256(digits)) — same construction as
  // /contacts/match applies to the client-supplied sha256, so writes and
  // lookups agree while a DB dump alone stays brute-force-proof.
  const sha = crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
  return vault.discoveryHash(sha);
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

    // Dev-only fixed OTP bypass: when DEV_OTP is set in the environment the
    // matching code is accepted without SMS/email. NEVER set DEV_OTP in a real
    // production deployment — it makes every account loginable with that code.
    const match = (process.env.DEV_OTP && code === process.env.DEV_OTP) || await otp.verify(code, row.code_hash);
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

// ════════════════════════════════════════════════════════════════════════════
// Onboarding re-architecture (encrypted PII). lib/vault: AES-GCM PII, HMAC
// lookup, argon2id secrets. Error envelope: { error: { code, message } }.
// ════════════════════════════════════════════════════════════════════════════

const SECURITY_QUESTION_CODES = new Set([
  'first_pet', 'mother_maiden', 'birth_city', 'primary_school', 'childhood_friend',
  'first_car', 'favourite_teacher', 'street_grew_up', 'first_job_city',
  'favourite_book', 'oldest_cousin', 'maternal_grandfather',
]);

// 6-digit MPIN weakness check (defence in depth — client checks too).
const WEAK_MPINS = new Set([
  '123456', '654321', '000000', '111111', '222222', '333333', '444444',
  '555555', '666666', '777777', '888888', '999999', '123123', '121212',
  '112233', '098765', '012345',
]);
function isWeakMpin(m) {
  if (!/^\d{6}$/.test(m)) return true;             // exactly 6 digits
  if (/^(\d)\1{5}$/.test(m)) return true;          // all same
  if ('0123456789'.includes(m) || '9876543210'.includes(m)) return true; // sequential
  if (WEAK_MPINS.has(m)) return true;
  return false;
}

function ageFromDob(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return NaN;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const mo = now.getMonth() - d.getMonth();
  if (mo < 0 || (mo === 0 && now.getDate() < d.getDate())) a--;
  return a;
}

function envErr(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}
function safeDecrypt(c) { try { return c ? vault.decrypt(c) : null; } catch { return null; } }

// Contact-discovery hash — MUST match the user.js/chats.js scheme so new users
// are findable: HMAC(pepper, sha256(digits)), 10-digit input prefixed with
// India's '91'. The client still sends bare sha256(digits); the pepper is
// applied server-side everywhere (write here, match in /contacts/match) so a
// DB dump alone can't be brute-forced. (phone_lookup remains the auth index.)
function discoveryPhoneHash(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  const sha = crypto.createHash('sha256').update(digits, 'utf8').digest('hex');
  return vault.discoveryHash(sha);
}
async function auditAttempt(userId, ip, type, success) {
  try {
    await db.query(
      `INSERT INTO auth_attempts (user_id, ip_address, attempt_type, success) VALUES ($1, $2, $3, $4)`,
      [userId || null, ip || null, type, success],
    );
  } catch { /* audit is best-effort; never block auth */ }
}

// POST /auth/onboard/send-otp — email OTP to PROVE email ownership (email, not SMS).
router.post('/onboard/send-otp', async (req, res) => {
  try {
    const e = vault.normalizeEmail(req.body?.email);
    if (!e) return envErr(res, 400, 'bad_request', 'Invalid email');
    const perEmail = await rateLimit.consume(`otp:email:${e}`, 3, 3600);
    if (!perEmail.allowed) return envErr(res, 429, 'rate_limited', 'Too many requests. Try again later.');
    const perIP = await rateLimit.consume(`otp:ip:${req.ip}`, 10, 3600);
    if (!perIP.allowed) return envErr(res, 429, 'rate_limited', 'Too many requests. Try again later.');

    const code = otp.generate();
    const codeHash = await otp.hash(code);
    await db.transaction(async (client) => {
      await client.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE email = $1 AND consumed_at IS NULL`, [e]);
      await client.query(
        `INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)`,
        [e, codeHash, otp.OTP_TTL_SECONDS.toString()],
      );
    });
    await email.sendOTP(e, code);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth/onboard/send-otp]', err.message);
    return envErr(res, 500, 'server_error', 'Failed to send code');
  }
});

// The ticket binding shared by /security-questions/save and /mpin/set. Kept in
// one function so the two verifiers cannot drift from the minter in
// /profile/init — a mismatch fails open on neither side, but it does brick
// onboarding, and the string is easy to mistype in three places. Must stay
// byte-identical to authSetupTicketData in the Go backend.
function setupTicketData(userId) { return `setup:${userId}`; }

// POST /auth/onboard/verify-otp — verify email OTP → short-lived ownership ticket.
router.post('/onboard/verify-otp', async (req, res) => {
  try {
    const e = vault.normalizeEmail(req.body?.email);
    const code = (req.body?.code || '').toString().trim();
    if (!e || !code) return envErr(res, 400, 'bad_request', 'email and code required');
    // A 6-digit code is a million guesses; unlimited attempts inside the OTP's
    // validity window make it a formality, and this ticket is what /profile/init
    // accepts as proof of email ownership. Same 5-per-15-minutes shape as
    // /mpin/verify. Per-email AND per-IP: the email key alone lets one host walk
    // a list of addresses, the IP key alone is defeated by rotating them.
    let gate = await rateLimit.consume(`onboard-otp:${e}`, 5, 900);
    if (gate.allowed) gate = await rateLimit.consume(`onboard-otp-ip:${req.ip}`, 50, 900);
    if (!gate.allowed) {
      return envErr(res, 423, 'locked', `Too many attempts. Try again in ${gate.resetInSec || 900}s`);
    }
    const r = await db.query(
      `SELECT id, code_hash FROM otp_codes
       WHERE email = $1 AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [e],
    );
    const row = r.rows[0];
    const ok = !!row && await otp.verify(code, row.code_hash);
    if (!ok) return envErr(res, 401, 'invalid_code', 'Incorrect or expired code');
    await db.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    // Ticket binds to the email lookup hash; profile/init requires it.
    return res.json({ ok: true, emailTicket: vault.signTicket(vault.emailLookup(e)) });
  } catch (err) {
    console.error('[auth/onboard/verify-otp]', err.message);
    return envErr(res, 500, 'server_error', 'Verification failed');
  }
});

// POST /auth/lookup — exists only if BOTH email and phone match the same row.
router.post('/lookup', async (req, res) => {
  try {
    const ipLimit = await rateLimit.consume(`auth-ip:${req.ip}`, 20, 60);
    if (!ipLimit.allowed) return envErr(res, 429, 'rate_limited', 'Too many requests');
    const email = vault.normalizeEmail(req.body?.email);
    const phone = vault.normalizePhone(req.body?.phone);
    if (!email || !phone) return envErr(res, 400, 'bad_request', 'email and phone are required');

    const el = vault.emailLookup(email);
    const pl = vault.phoneLookup(phone);
    const r = await db.query(
      `SELECT id, email_lookup, phone_lookup FROM users
       WHERE (email_lookup = $1 OR phone_lookup = $2) AND is_deleted = FALSE LIMIT 2`,
      [el, pl],
    );
    const both = r.rows.find(row => row.email_lookup === el && row.phone_lookup === pl);
    if (both) {
      await auditAttempt(both.id, req.ip, 'lookup', true);
      return res.json({ exists: true, userId: both.id });
    }
    // One identifier is taken by a DIFFERENT account → block (1 mobile ↔ 1 email).
    const phoneTaken = r.rows.some(row => row.phone_lookup === pl);
    const emailTaken = r.rows.some(row => row.email_lookup === el);
    await auditAttempt(null, req.ip, 'lookup', false);
    if (phoneTaken) return res.json({ exists: false, conflict: 'phone' });
    if (emailTaken) return res.json({ exists: false, conflict: 'email' });
    return res.json({ exists: false });
  } catch (err) {
    console.error('[auth/lookup]', err.message);
    return envErr(res, 500, 'server_error', 'Lookup failed');
  }
});

// POST /auth/profile/init — create the encrypted user row (onboarding_complete=false).
router.post('/profile/init', async (req, res) => {
  try {
    const email = vault.normalizeEmail(req.body?.email);
    const phone = vault.normalizePhone(req.body?.phone);
    const firstName = (req.body?.firstName || '').toString().trim();
    const lastName  = (req.body?.lastName  || '').toString().trim();
    const dob       = (req.body?.dob       || '').toString().trim();
    const status    = (req.body?.status    || '').toString();
    const profilePicUrl = req.body?.profilePicUrl ? req.body.profilePicUrl.toString() : null;

    if (!email || !phone || !firstName || !dob) {
      return envErr(res, 400, 'bad_request', 'email, phone, firstName and dob are required');
    }
    const age = ageFromDob(dob);
    if (isNaN(age) || age < 13) return envErr(res, 400, 'min_age', 'You must be at least 13');
    if (status.length > 139) return envErr(res, 400, 'status_too_long', 'Status max 139 characters');

    const el = vault.emailLookup(email);
    const pl = vault.phoneLookup(phone);

    // Email ownership: require a valid ticket from /auth/onboard/verify-otp for
    // THIS email. Closes the impersonation gap (no account creation for an email
    // the caller hasn't proven they control).
    if (!vault.verifyTicket((req.body?.emailTicket || '').toString(), el)) {
      return envErr(res, 401, 'email_unverified', 'Verify your email with the code first');
    }

    const dup = await db.query(
      `SELECT 1 FROM users WHERE (email_lookup = $1 OR phone_lookup = $2) AND is_deleted = FALSE LIMIT 1`,
      [el, pl],
    );
    if (dup.rows[0]) return envErr(res, 409, 'already_exists', 'An account already exists for this email or mobile');

    const ins = await db.query(
      `INSERT INTO users
         (email_lookup, phone_lookup, email_cipher, phone_cipher,
          first_name_cipher, last_name_cipher, dob_cipher, status_cipher,
          photo_url, phone_hash, auth_provider, email_verified_at, onboarding_complete)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'google',NOW(),FALSE)
       RETURNING id`,
      [
        el, pl, vault.encrypt(email), vault.encrypt(phone),
        vault.encrypt(firstName), lastName ? vault.encrypt(lastName) : null,
        vault.encrypt(dob), status.trim() ? vault.encrypt(status) : null,
        profilePicUrl, discoveryPhoneHash(phone),
      ],
    );
    // Onboarding continues with /security-questions/save and /mpin/set, both of
    // which write credentials keyed on a body userId. Neither can require a JWT
    // (there is no session until the MPIN exists), so they take THIS ticket
    // instead — minted only here, only after the email OTP proved ownership,
    // and bound to the id we just created. Without it those two endpoints hand
    // any caller another user's account.
    return res.json({
      userId: ins.rows[0].id,
      setupTicket: vault.signTicket(setupTicketData(ins.rows[0].id)),
    });
  } catch (err) {
    console.error('[auth/profile/init]', err.message);
    return envErr(res, 500, 'server_error', 'Could not create profile');
  }
});

// POST /auth/security-questions/save — exactly 5 unique answers from the pool.
router.post('/security-questions/save', async (req, res) => {
  try {
    const userId  = (req.body?.userId || '').toString();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!userId || !answers || answers.length !== 5) {
      return envErr(res, 400, 'bad_request', 'Exactly 5 answers required');
    }
    // Ownership: these answers ARE a credential — /security-questions/verify
    // trades them for a recovery ticket, which /mpin/recover trades for a
    // session. Overwriting them on an established account is account takeover,
    // so the caller must hold the setup ticket from /auth/profile/init.
    if (!vault.verifyTicket((req.body?.setupTicket || '').toString(), setupTicketData(userId))) {
      return envErr(res, 401, 'not_verified', 'Start onboarding again to set your security questions');
    }
    const codes = answers.map(a => (a?.questionCode || '').toString());
    if (new Set(codes).size !== 5) return envErr(res, 400, 'duplicate_question', 'Questions must be unique');
    if (!codes.every(c => SECURITY_QUESTION_CODES.has(c))) return envErr(res, 400, 'invalid_question', 'Unknown question code');
    if (!answers.every(a => vault.normalizeAnswer(a?.answer).length >= 2)) {
      return envErr(res, 400, 'answer_too_short', 'Each answer needs at least 2 characters');
    }
    const u = await db.query(`SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE`, [userId]);
    if (!u.rows[0]) return envErr(res, 404, 'not_found', 'User not found');

    for (const a of answers) {
      const hash = await vault.hashSecret(vault.normalizeAnswer(a.answer));
      await db.query(
        `INSERT INTO user_security_questions (user_id, question_code, answer_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, question_code) DO UPDATE SET answer_hash = EXCLUDED.answer_hash`,
        [userId, a.questionCode, hash],
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth/security-questions/save]', err.message);
    return envErr(res, 500, 'server_error', 'Could not save security questions');
  }
});

// POST /auth/mpin/set — argon2id-hash; marks onboarding_complete.
router.post('/mpin/set', async (req, res) => {
  try {
    const userId = (req.body?.userId || '').toString();
    const mpin   = (req.body?.mpin   || '').toString();
    if (!userId) return envErr(res, 400, 'bad_request', 'userId required');
    // Ownership, gate 1 of 2. This endpoint writes the credential that
    // /mpin/verify trades for a session, so without proof of ownership it is a
    // one-call account takeover of any userId the caller can name. It cannot
    // require a JWT — no session exists yet — so it takes the setup ticket
    // /auth/profile/init minted after the email OTP. Resets do NOT come here;
    // they go to /mpin/recover, which has always required its own ticket.
    if (!vault.verifyTicket((req.body?.setupTicket || '').toString(), setupTicketData(userId))) {
      return envErr(res, 401, 'not_verified', 'Start onboarding again to set your MPIN');
    }
    if (isWeakMpin(mpin)) return envErr(res, 400, 'weak_mpin', 'Choose a less predictable MPIN');
    const u = await db.query(`SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE`, [userId]);
    if (!u.rows[0]) return envErr(res, 404, 'not_found', 'User not found');

    const hash = await vault.hashSecret(mpin);
    // Ownership, gate 2 of 2: FIRST-SET ONLY. The ticket above is the real
    // gate; this is what contains the damage if one ever leaks (a crash report,
    // a proxy log) inside its 15-minute life — a replay cannot overwrite a PIN
    // that already exists.
    const upd = await db.query(
      `UPDATE users SET mpin_hash = $1, onboarding_complete = TRUE, updated_at = NOW()
         WHERE id = $2 AND mpin_hash IS NULL`,
      [hash, userId],
    );
    // Zero rows means the PIN was already set. Answer 200, not an error: the
    // only caller that reaches here holds a valid ticket for THIS id, so this is
    // the onboarding client retrying after a reply was lost in flight, and
    // failing it would strand a real user on the last step of signup. An
    // attacker holding the same ticket learns nothing and changes nothing.
    if (upd.rowCount === 0) return res.json({ ok: true, already: true });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth/mpin/set]', err.message);
    return envErr(res, 500, 'server_error', 'Could not set MPIN');
  }
});

// POST /auth/mpin/verify — Redis-backed 5-attempt / 15-min lockout; issues JWTs.
router.post('/mpin/verify', async (req, res) => {
  try {
    const userId = (req.body?.userId || '').toString();
    const mpin   = (req.body?.mpin   || '').toString();
    if (!userId || !mpin) return envErr(res, 400, 'bad_request', 'userId and mpin required');

    const gate = await rateLimit.consume(`mpin:${userId}`, 5, 900);
    if (!gate.allowed) {
      return envErr(res, 423, 'locked', `Too many attempts. Try again in ${gate.resetInSec || 900}s`);
    }

    const u = await db.query(`SELECT * FROM users WHERE id = $1 AND is_deleted = FALSE`, [userId]);
    const row = u.rows[0];
    const ok  = !!(row && row.mpin_hash) && await vault.verifySecret(mpin, row.mpin_hash);
    await auditAttempt(userId, req.ip, 'mpin', ok);
    if (!ok) return envErr(res, 401, 'invalid_mpin', 'Incorrect MPIN');

    await rateLimit.reset(`mpin:${userId}`);
    const tokens = await issueTokens(row, req);
    return res.json(tokens);
  } catch (err) {
    console.error('[auth/mpin/verify]', err.message);
    return envErr(res, 500, 'server_error', 'Verification failed');
  }
});

// GET /auth/security-questions/:userId — the user's chosen question codes (no
// answers) so the recovery screen can show them. (userId is known from /lookup.)
router.get('/security-questions/:userId', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT question_code FROM user_security_questions WHERE user_id = $1 ORDER BY created_at`,
      [req.params.userId],
    );
    return res.json({ questions: r.rows.map(x => x.question_code) });
  } catch (err) {
    console.error('[auth/security-questions GET]', err.message);
    return envErr(res, 500, 'server_error', 'Could not load questions');
  }
});

// POST /auth/security-questions/verify — recovery: ≥3 correct answers → ticket.
router.post('/security-questions/verify', async (req, res) => {
  try {
    const userId  = (req.body?.userId || '').toString();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!userId || !answers || !answers.length) return envErr(res, 400, 'bad_request', 'answers required');

    const gate = await rateLimit.consume(`recover:${userId}`, 5, 900);
    if (!gate.allowed) return envErr(res, 423, 'locked', `Too many attempts. Try again in ${gate.resetInSec || 900}s`);

    const rows = (await db.query(
      `SELECT question_code, answer_hash FROM user_security_questions WHERE user_id = $1`, [userId],
    )).rows;
    const byCode = new Map(rows.map(x => [x.question_code, x.answer_hash]));
    let correct = 0;
    for (const a of answers) {
      const h = byCode.get((a?.questionCode || '').toString());
      if (h && await vault.verifySecret(vault.normalizeAnswer(a?.answer), h)) correct++;
    }
    const ok = correct >= 3;
    await auditAttempt(userId, req.ip, 'recover', ok);
    if (!ok) return envErr(res, 401, 'insufficient_answers', `Need at least 3 correct answers (got ${correct})`);
    await rateLimit.reset(`recover:${userId}`);
    return res.json({ ok: true, recoveryTicket: vault.signTicket(`recover:${userId}`) });
  } catch (err) {
    console.error('[auth/security-questions/verify]', err.message);
    return envErr(res, 500, 'server_error', 'Verification failed');
  }
});

// POST /auth/mpin/recover — set a new MPIN using a valid recovery ticket → JWTs.
router.post('/mpin/recover', async (req, res) => {
  try {
    const userId = (req.body?.userId || '').toString();
    const ticket = (req.body?.recoveryTicket || '').toString();
    const mpin   = (req.body?.mpin || '').toString();
    if (!userId) return envErr(res, 400, 'bad_request', 'userId required');
    if (!vault.verifyTicket(ticket, `recover:${userId}`)) return envErr(res, 401, 'not_verified', 'Answer your security questions first');
    if (isWeakMpin(mpin)) return envErr(res, 400, 'weak_mpin', 'Choose a less predictable MPIN');

    const u = await db.query(`SELECT * FROM users WHERE id = $1 AND is_deleted = FALSE`, [userId]);
    if (!u.rows[0]) return envErr(res, 404, 'not_found', 'User not found');

    await db.query(`UPDATE users SET mpin_hash = $1, updated_at = NOW() WHERE id = $2`, [await vault.hashSecret(mpin), userId]);
    await rateLimit.reset(`mpin:${userId}`);          // clear any verify-lockout
    const tokens = await issueTokens(u.rows[0], req);
    return res.json(tokens);
  } catch (err) {
    console.error('[auth/mpin/recover]', err.message);
    return envErr(res, 500, 'server_error', 'Could not reset MPIN');
  }
});

// POST /auth/profile/photo — (JWT) set the profile photo. photoKey (hex) is the
// per-photo AES key the client encrypted the avatar with; we wrap it under the
// master key so the serve path can stream-decrypt it. Omit photoKey for a legacy
// plaintext photo.
router.post('/profile/photo', jwtUtil.requireAuth, async (req, res) => {
  try {
    const photoId  = req.body?.photoId ? req.body.photoId.toString() : null;
    const photoKey = req.body?.photoKey ? req.body.photoKey.toString() : null;
    const keyCipher = (photoId && photoKey) ? vault.encrypt(photoKey) : null;
    await db.query(
      `UPDATE users SET photo_url = $1, photo_key_cipher = $2, updated_at = NOW() WHERE id = $3`,
      [photoId, keyCipher, req.user.id],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth/profile/photo]', err.message);
    return envErr(res, 500, 'server_error', 'Could not save photo');
  }
});

// POST /auth/mfa/configure — (JWT) toggle device-MFA flag.
router.post('/mfa/configure', jwtUtil.requireAuth, async (req, res) => {
  try {
    const enabled = !!req.body?.mfaEnabled;
    await db.query(`UPDATE users SET mfa_enabled = $1, updated_at = NOW() WHERE id = $2`, [enabled, req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth/mfa/configure]', err.message);
    return envErr(res, 500, 'server_error', 'Could not update MFA');
  }
});

// GET /auth/profile — (JWT) decrypted profile. Plaintext leaves only over TLS.
router.get('/profile', jwtUtil.requireAuth, async (req, res) => {
  try {
    const u = await db.query(`SELECT * FROM users WHERE id = $1 AND is_deleted = FALSE`, [req.user.id]);
    const r = u.rows[0];
    if (!r) return envErr(res, 404, 'not_found', 'User not found');
    return res.json({
      userId:             r.id,
      email:              safeDecrypt(r.email_cipher),
      phone:              safeDecrypt(r.phone_cipher),
      firstName:          safeDecrypt(r.first_name_cipher),
      lastName:           safeDecrypt(r.last_name_cipher),
      dob:                safeDecrypt(r.dob_cipher),
      status:             safeDecrypt(r.status_cipher),
      profilePicUrl:      r.photo_url || null,
      mfaEnabled:         r.mfa_enabled,
      onboardingComplete: r.onboarding_complete,
    });
  } catch (err) {
    console.error('[auth/profile GET]', err.message);
    return envErr(res, 500, 'server_error', 'Could not load profile');
  }
});

module.exports = router;
