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

// consumeBy is consume with a weight: charges `n` units instead of 1.
// Request-counting is the wrong meter for a bulk endpoint — 5 /contacts/match
// calls a minute is also 25,000 phone hashes a minute, enough to walk a
// meaningful slice of the ~10^10 phone keyspace from one account. Charge the
// hashes, not the call. Same fail-open trade-off as consume.
async function consumeBy(key, n, limit, windowSeconds) {
  if (!isConnected() || !(n > 0)) return { allowed: true, remaining: limit, resetInSec: windowSeconds };
  try {
    const k = `rl:${key}`;
    const count = await client.incrBy(k, n);
    if (count === n) {              // first charge in this window
      await client.expire(k, windowSeconds);
    }
    const ttl = await client.ttl(k);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetInSec: ttl >= 0 ? ttl : windowSeconds };
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

module.exports = { consume, consumeBy, reset };
