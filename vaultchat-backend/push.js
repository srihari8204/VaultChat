// Push delivery via the Expo Push API.
//
//   sendPushToTokens(tokens, payload) -> { dead: string[] }
//     tokens  — array of ExponentPushToken[...] strings
//     payload — { title, body, data?, sound? }
//     returns the tokens Expo reported as DeviceNotRegistered, so the caller
//     can prune them from the devices table (stops wasting sends + fixes the
//     "notifications silently stop" problem after a reinstall/uninstall).
//
// Reliability: each batch is retried on transient (network / 5xx) failures with
// a short backoff. Per-message tickets in the response are inspected immediately
// so invalid tokens are surfaced without a separate receipts round-trip.
//
// Android push is delivered by Expo through FCM; this avoids us managing FCM
// service-account credentials directly.

const db = require('./db');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH = 100;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postBatch(chunk) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
        },
        body: JSON.stringify(chunk),
      });
      if (res.status >= 500) { // transient server error → retry
        lastErr = new Error(`Expo ${res.status}`);
      } else if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('[push] Expo Push returned', res.status, text.slice(0, 200));
        return null; // 4xx → not retryable
      } else {
        return res.json().catch(() => null);
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(300 * attempt);
  }
  console.error('[push] batch failed after retries:', lastErr?.message);
  return null;
}

async function sendPushToTokens(tokens, payload) {
  const dead = [];
  if (!Array.isArray(tokens) || tokens.length === 0) return { dead };
  const valid = tokens.filter((t) => typeof t === 'string' && t.startsWith('Expo'));
  if (valid.length === 0) return { dead };

  const base = {
    sound: payload.sound ?? 'default',
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    priority: 'high',
    channelId: payload.channelId || 'default', // Android channel = per-chat sound
    _displayInForeground: true,
  };
  // Action buttons (Accept/Decline for calls) via an iOS/Android category.
  if (payload.categoryId) base.categoryId = payload.categoryId;

  for (let i = 0; i < valid.length; i += BATCH) {
    const slice = valid.slice(i, i + BATCH);
    const chunk = slice.map((token) => ({ to: token, ...base }));
    const json = await postBatch(chunk);
    const tickets = json?.data;
    if (!Array.isArray(tickets)) continue;
    // Tickets are aligned with the chunk order. Collect tokens whose device is
    // no longer registered so the caller can prune them.
    tickets.forEach((t, idx) => {
      if (t && t.status === 'error' && t.details && t.details.error === 'DeviceNotRegistered') {
        dead.push(slice[idx]);
      }
    });
  }

  // Prune tokens for devices that no longer exist (uninstall / reinstall), so we
  // stop sending to them. Best-effort; all callers benefit automatically.
  if (dead.length) {
    try {
      await db.query(`DELETE FROM devices WHERE push_token = ANY($1::text[])`, [dead]);
    } catch (e) {
      console.error('[push] prune dead tokens:', e.message);
    }
  }
  return { dead };
}

module.exports = { sendPushToTokens };
