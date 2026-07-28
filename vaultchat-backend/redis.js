// Redis connection — single shared client.
// Used for OTP rate limiting and (later) ephemeral session state.
// Env: REDIS_HOST, REDIS_PORT, REDIS_PASS, REDIS_DISABLED
//
// If Redis is unreachable we fail-soft: rate limiter no-ops (returns
// allowed=true). We give up after the first failed connect rather than
// retry-stormimg the log forever — set REDIS_DISABLED=1 to skip
// entirely in environments that don't have Redis at all.

const Redis = require('ioredis');

const DISABLED = process.env.REDIS_DISABLED === '1';
let connected = false;
let gaveUp    = false;
let client    = null;

if (!DISABLED) {
  client = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASS || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // After initial connect fails once, stop reconnecting forever —
    // we don't want a Redis-less dev box to spam ECONNREFUSED on a loop.
    retryStrategy: () => (gaveUp ? null : 200),
  });

  client.on('connect', () => { connected = true; gaveUp = false; console.log('[redis] connected'); });
  client.on('end',     () => { connected = false; });
  client.on('error',   (err) => {
    // Only log the FIRST connect failure, then silence the loop.
    if (!gaveUp && !connected) {
      console.warn(`[redis] unreachable (${err.message}). Rate limiting disabled.`);
      gaveUp = true;
      try { client.disconnect(); } catch {}
    }
  });
}

async function connect() {
  if (DISABLED || connected || gaveUp || !client) return;
  try {
    await client.connect();
  } catch (err) {
    if (!gaveUp) {
      console.warn(`[redis] initial connect failed (${err.message}). Rate limiting disabled.`);
      gaveUp = true;
    }
  }
}

function isConnected() { return connected; }

async function shutdown() {
  if (!client) return;
  try { await client.quit(); } catch {}
}

module.exports = { client, connect, isConnected, shutdown };
