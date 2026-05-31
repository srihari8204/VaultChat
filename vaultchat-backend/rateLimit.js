// Redis-backed sliding-ish rate limiter using fixed-window counters.
// Fail-open: if Redis is unreachable, the limiter allows the request
// rather than locking out real users. Trade-off accepted because OTP
// send is also bounded by SMTP quota.

const { client, isConnected } = require('./redis');

// One bucket = one (key, windowSeconds) pair. Returns:
//   { allowed: boolean, remaining: number, resetInSec: number }
async function consume(key, limit, windowSeconds) {
  if (!isConnected()) return { allowed: true, remaining: limit, resetInSec: windowSeconds };
  try {
    const k = `rl:${key}`;
    const count = await client.incr(k);
    if (count === 1) {
      await client.expire(k, windowSeconds);
    }
    const ttl = await client.ttl(k);
    const allowed = count <= limit;
    return { allowed, remaining: Math.max(0, limit - count), resetInSec: ttl >= 0 ? ttl : windowSeconds };
  } catch (err) {
    console.error('[rateLimit] redis failure, failing open:', err.message);
    return { allowed: true, remaining: limit, resetInSec: windowSeconds };
  }
}

// Reset (consume after success, or admin clear)
async function reset(key) {
  if (!isConnected()) return;
  try { await client.del(`rl:${key}`); } catch {}
}

module.exports = { consume, reset };
