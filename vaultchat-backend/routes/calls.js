// routes/calls.js — call wake-up (FCM) + signaling bootstrap.
//
// Mounted at /call. Express-style (matches the rest of this backend).
//   POST /call/token     { fcmToken }                       — register native FCM token
//   POST /call/initiate  { calleeId, callId, isVideo, sdpOffer } — ring the callee
//   POST /call/cancel    { calleeId, callId }                — dismiss the ring
//
// The socket layer still carries the live WebRTC offer/answer/ICE; this push is
// only the WAKE-UP so a killed/doze device rings. We include the SDP offer in
// the push so the callee can pre-warm media before the socket reconnects.

const express = require('express');
const db      = require('../db');
const jwtUtil = require('../jwt');
const { sendCallMessage } = require('../lib/callFcm');

const router = express.Router();
router.use(jwtUtil.requireAuth);

// Caller's display identity for the callee's ring UI (already-known contact data).
async function callerIdentity(uid) {
  try {
    const r = await db.query(`SELECT name, profile_photo_id FROM users WHERE id = $1`, [uid]);
    const row = r.rows[0] || {};
    return { name: row.name || 'VaultChat user', dpUrl: row.profile_photo_id ? `/uploads/${row.profile_photo_id}` : '' };
  } catch { return { name: 'VaultChat user', dpUrl: '' }; }
}

async function fcmTokensFor(userId) {
  const r = await db.query(`SELECT fcm_token FROM devices WHERE user_id = $1 AND fcm_token IS NOT NULL`, [userId]);
  return r.rows.map(x => x.fcm_token).filter(Boolean);
}

// Register / refresh the native FCM token for this device.
router.post('/token', async (req, res) => {
  try {
    const fcmToken = (req.body?.fcmToken || '').toString().trim();
    const platform = (req.body?.platform || 'android').toString().toLowerCase();
    if (!fcmToken) return res.status(400).json({ error: 'fcmToken required' });
    // Upsert keyed on the token so re-registration from the same device is idempotent.
    await db.query(
      `INSERT INTO devices (user_id, push_token, fcm_token, platform, last_seen_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, push_token) DO UPDATE SET fcm_token = EXCLUDED.fcm_token, last_seen_at = NOW()`,
      [req.user.id, `fcm:${fcmToken.slice(0, 40)}`, fcmToken, platform],
    ).catch(async () => {
      // devices may require a unique push_token; fall back to a direct token table update.
      await db.query(`UPDATE devices SET fcm_token = $1 WHERE user_id = $2 AND fcm_token = $1`, [fcmToken, req.user.id]);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[call/token]', err.message);
    res.status(500).json({ error: 'Failed to register token' });
  }
});

// Ring the callee with a high-priority data push.
router.post('/initiate', async (req, res) => {
  try {
    const calleeId = (req.body?.calleeId || '').toString();
    const callId   = (req.body?.callId   || '').toString();
    const isVideo  = req.body?.isVideo === true || req.body?.isVideo === 'true';
    const sdpOffer = req.body?.sdpOffer ? String(req.body.sdpOffer) : '';
    if (!calleeId || !callId) return res.status(400).json({ error: 'calleeId and callId required' });

    const tokens = await fcmTokensFor(calleeId);
    if (!tokens.length) return res.json({ ok: true, delivered: false, reason: 'no_device_token' });

    const caller = await callerIdentity(req.user.id);
    const { ok, dead } = await sendCallMessage(tokens, {
      type: 'incoming_call',
      callId,
      callerId: req.user.id,
      callerName: caller.name,
      callerDpUrl: caller.dpUrl,
      isVideo: isVideo ? 'true' : 'false',
      sdpOffer,                       // call-setup metadata only (DTLS/ICE bootstrap)
      ts: String(Date.now()),
    }, 30000);

    if (dead.length) {
      await db.query(`UPDATE devices SET fcm_token = NULL WHERE fcm_token = ANY($1::text[])`, [dead]).catch(() => {});
    }
    res.json({ ok: true, delivered: ok });
  } catch (err) {
    console.error('[call/initiate]', err.message);
    res.status(500).json({ error: 'Failed to initiate call' });
  }
});

// Stop ringing (caller hung up before answer, or timed out).
router.post('/cancel', async (req, res) => {
  try {
    const calleeId = (req.body?.calleeId || '').toString();
    const callId   = (req.body?.callId   || '').toString();
    if (!calleeId || !callId) return res.status(400).json({ error: 'calleeId and callId required' });
    const tokens = await fcmTokensFor(calleeId);
    if (tokens.length) {
      await sendCallMessage(tokens, { type: 'call_cancelled', callId, ts: String(Date.now()) }, 30000);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[call/cancel]', err.message);
    res.status(500).json({ error: 'Failed to cancel call' });
  }
});

module.exports = router;
