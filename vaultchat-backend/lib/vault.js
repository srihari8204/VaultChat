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

module.exports = {
  encrypt, decrypt,
  lookupHash, emailLookup, phoneLookup,
  hashSecret, verifySecret,
  normalizeEmail, normalizePhone, normalizeAnswer,
};
