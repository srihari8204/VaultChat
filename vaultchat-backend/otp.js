// OTP generation, hashing, and verification.
// 6-digit numeric codes. Hashed with bcrypt before storage (never store raw).

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const OTP_TTL_SECONDS = 10 * 60;       // 10 minutes
const MAX_ATTEMPTS    = 5;
const BCRYPT_ROUNDS   = 10;

function generate() {
  // crypto.randomInt is unbiased for the [0, 1e6) range
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

async function hash(code) {
  return bcrypt.hash(code, BCRYPT_ROUNDS);
}

async function verify(code, hashed) {
  if (!code || !hashed) return false;
  try {
    return await bcrypt.compare(code, hashed);
  } catch {
    return false;
  }
}

module.exports = {
  generate,
  hash,
  verify,
  OTP_TTL_SECONDS,
  MAX_ATTEMPTS,
};
