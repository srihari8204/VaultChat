// JWT issuance + verification + Express middleware.
//
// Two tokens:
//   - access  — short-lived (15m), sent as Authorization: Bearer
//   - refresh — long-lived (30d), stored hashed in DB, rotated on use
//
// Env: JWT_SECRET (required), JWT_ACCESS_TTL, JWT_REFRESH_TTL

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const SECRET           = process.env.JWT_SECRET || '';
const ACCESS_TTL_SEC   = parseInt(process.env.JWT_ACCESS_TTL  || (15 * 60).toString(), 10);
const REFRESH_TTL_SEC  = parseInt(process.env.JWT_REFRESH_TTL || (30 * 24 * 60 * 60).toString(), 10);
const REFRESH_BYTES    = 48;
const REFRESH_HASH_ROUNDS = 10;

if (!SECRET || SECRET.length < 32) {
  console.warn('[jwt] WARNING: JWT_SECRET is missing or weak. Set a strong secret in .env');
}

function signAccess(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: ACCESS_TTL_SEC, algorithm: 'HS256' });
}

function verifyAccess(token) {
  return jwt.verify(token, SECRET, { algorithms: ['HS256'] });
}

// Refresh tokens are opaque random strings. We hash them before DB storage.
function generateRefreshToken() {
  return crypto.randomBytes(REFRESH_BYTES).toString('base64url');
}

async function hashRefresh(token) {
  return bcrypt.hash(token, REFRESH_HASH_ROUNDS);
}

async function compareRefresh(token, hash) {
  if (!token || !hash) return false;
  try { return await bcrypt.compare(token, hash); } catch { return false; }
}

// Express middleware — attach req.user from Bearer token.
// Rejects with 401 if missing/invalid/expired.
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'Missing Bearer token' });
  try {
    const payload = verifyAccess(m[1]);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
    return res.status(401).json({ error: code });
  }
}

module.exports = {
  signAccess,
  verifyAccess,
  generateRefreshToken,
  hashRefresh,
  compareRefresh,
  requireAuth,
  ACCESS_TTL_SEC,
  REFRESH_TTL_SEC,
};
