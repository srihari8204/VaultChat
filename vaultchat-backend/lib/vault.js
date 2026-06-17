// lib/vault.js — VaultChat PII vault crypto.
//
// Three primitives, three purposes (see docs/auth-flow.md):
//   • encrypt/decrypt — AES-256-GCM, TWO-WAY, for PII the app must render back
//     (email, phone, names, DOB, status). Per-record key via HKDF-SHA256 from the
//     master key + a per-record random salt. Envelope (base64):
//        version(1=0x01) ‖ salt(16) ‖ iv(12) ‖ ciphertext(N) ‖ tag(16)
//   • lookupHash — HMAC-SHA256(pepper, normalized(value)), DETERMINISTIC, so we
//     can index/match email & phone without decrypting every row.
//   • hashSecret/verifySecret — Argon2id, ONE-WAY, for verification secrets
//     (MPIN, security answers). Never decryptable.
//
// Secrets come from env, loaded once at boot, NEVER logged:
//   VAULTCHAT_MASTER_KEY    — 32 bytes, hex (64 chars) or base64.
//   VAULTCHAT_LOOKUP_PEPPER — non-empty string.

const crypto = require('crypto');
const argon2 = require('@node-rs/argon2');

const VERSION  = 0x01;
const SALT_LEN = 16;
const IV_LEN   = 12;
const TAG_LEN  = 16;
const KEY_LEN  = 32;
const HKDF_INFO = Buffer.from('vaultchat-pii-v1');

// Argon2id: 64 MB memory, 3 iterations, parallelism 4 (per spec).
const ARGON_OPTS = {
  algorithm:   argon2.Algorithm.Argon2id,
  memoryCost:  65536, // KiB = 64 MB
  timeCost:    3,
  parallelism: 4,
};

let _masterKey = null;
function masterKey() {
  if (_masterKey) return _masterKey;
  const raw = process.env.VAULTCHAT_MASTER_KEY;
  if (!raw) throw new Error('VAULTCHAT_MASTER_KEY not set');
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== KEY_LEN) throw new Error('VAULTCHAT_MASTER_KEY must decode to 32 bytes (hex or base64)');
  _masterKey = key;
  return key;
}

function pepper() {
  const p = process.env.VAULTCHAT_LOOKUP_PEPPER;
  if (!p) throw new Error('VAULTCHAT_LOOKUP_PEPPER not set');
  return p;
}

function deriveKey(salt) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey(), salt, HKDF_INFO, KEY_LEN));
}

// ── Normalizers ─────────────────────────────────────────────────────────────
function normalizeEmail(v) {
  return String(v ?? '').trim().toLowerCase();
}
// E.164-ish: keep a single leading '+' and digits only.
function normalizePhone(v) {
  let s = String(v ?? '').trim().replace(/[^\d+]/g, '');
  if (s.indexOf('+') > 0) s = s.replace(/\+/g, '');          // '+' only valid leading
  if (s.startsWith('+')) s = '+' + s.slice(1).replace(/\+/g, '');
  return s;
}
function normalizeAnswer(v) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── Two-way encryption (PII) ────────────────────────────────────────────────
function encrypt(plaintext) {
  if (plaintext == null) throw new Error('encrypt: plaintext required');
  const salt = crypto.randomBytes(SALT_LEN);
  const iv   = crypto.randomBytes(IV_LEN);
  const key  = deriveKey(salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), salt, iv, ct, tag]).toString('base64');
}

function decrypt(envelope) {
  const buf = Buffer.from(String(envelope), 'base64');
  if (buf.length < 1 + SALT_LEN + IV_LEN + TAG_LEN) throw new Error('decrypt: envelope too short');
  if (buf[0] !== VERSION) throw new Error('decrypt: unsupported envelope version');
  let o = 1;
  const salt = buf.subarray(o, o += SALT_LEN);
  const iv   = buf.subarray(o, o += IV_LEN);
  const tag  = buf.subarray(buf.length - TAG_LEN);
  const ct   = buf.subarray(o, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'); // throws on tag mismatch
}

// ── Deterministic lookup hashes ─────────────────────────────────────────────
function lookupHash(normalizedValue) {
  return crypto.createHmac('sha256', pepper()).update(String(normalizedValue)).digest('hex');
}
function emailLookup(email) { return lookupHash(normalizeEmail(email)); }
function phoneLookup(phone) { return lookupHash(normalizePhone(phone)); }

// ── One-way secret hashing (MPIN, answers) ──────────────────────────────────
async function hashSecret(plaintext) {
  if (plaintext == null || String(plaintext).length === 0) throw new Error('hashSecret: empty');
  return argon2.hash(String(plaintext), ARGON_OPTS); // PHC string '$argon2id$...'
}
async function verifySecret(plaintext, encoded) {
  if (!encoded) return false;
  try { return await argon2.verify(String(encoded), String(plaintext)); }
  catch { return false; }
}

// ── Stateless signed tickets ────────────────────────────────────────────────
// Short-lived proof that some step happened (e.g. "this email was OTP-verified"),
// carried by the client between requests without server-side session/Redis.
// HMAC-SHA256(pepper) over "<data>.<exp>"; base64url. verifyTicket is constant-time
// and binds the ticket to the expected data (e.g. the email lookup hash).
function signTicket(data, ttlSec = 900) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${data}.${exp}`;
  const sig = crypto.createHmac('sha256', pepper()).update(`ticket|${body}`).digest('hex');
  return Buffer.from(`${body}.${sig}`).toString('base64url');
}
function verifyTicket(token, expectedData) {
  try {
    const parts = Buffer.from(String(token), 'base64url').toString('utf8').split('.');
    if (parts.length !== 3) return false;
    const [data, exp, sig] = parts;
    if (data !== expectedData) return false;
    if (parseInt(exp, 10) < Math.floor(Date.now() / 1000)) return false;
    const expect = crypto.createHmac('sha256', pepper()).update(`ticket|${data}.${exp}`).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Decrypt the identity PII from a users row, falling back to the legacy plaintext
// columns for any pre-encryption rows. Used by the publicUser serializers so the
// rest of the app sees real values regardless of which storage a row uses.
function safeDec(c) { try { return c ? decrypt(c) : null; } catch { return null; } }
function identityFromRow(row) {
  if (!row) return {};
  const first = safeDec(row.first_name_cipher);
  const last  = safeDec(row.last_name_cipher);
  const name  = (first || last) ? [first, last].filter(Boolean).join(' ') : (row.name ?? null);
  return {
    email:     safeDec(row.email_cipher)  ?? row.email ?? null,
    phone:     safeDec(row.phone_cipher)  ?? row.phone ?? null,
    name,
    firstName: first ?? null,
    lastName:  last ?? null,
    dob:       safeDec(row.dob_cipher)    ?? (row.dob ? String(row.dob) : null),
    status:    safeDec(row.status_cipher) ?? row.status ?? null,
  };
}

module.exports = {
  encrypt, decrypt,
  lookupHash, emailLookup, phoneLookup,
  hashSecret, verifySecret,
  signTicket, verifyTicket,
  normalizeEmail, normalizePhone, normalizeAnswer,
  identityFromRow,
};
