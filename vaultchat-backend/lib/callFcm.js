// lib/callFcm.js — high-priority, DATA-ONLY FCM for call wake-ups.
//
// A data-only message (no `notification` block) is what lets a KILLED Android
// app run our native VaultCallMessagingService.onMessageReceived and ring from
// a cold start. A notification message would just sit in the tray. android
// priority 'high' + a short ttl gives a ~30s ring window.
//
// E2EE NOTE: the payload carries ONLY call-setup metadata (caller name/DP that
// are already-known contact data, an opaque signaling bootstrap id, and the SDP
// offer for fast media setup). No message content is included. The SDP is the
// DTLS fingerprint exchange, not user data.
//
// ⚠️ The firebase-admin app MUST be initialised with the service account of the
//    SAME project as the client google-services.json (currently vaultchatprod01).
//    A mismatched key makes every send fail with messaging/mismatched-credential.

const path = require('path');
const fs   = require('fs');

let admin = null;
let ready = false;

function init() {
  if (ready) return true;
  try {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
      } else {
        const keyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
        if (!fs.existsSync(keyPath)) {
          console.warn('[callFcm] no service account — call wake-up push disabled');
          return false;
        }
        admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
      }
    }
    ready = true;
  } catch (err) {
    console.error('[callFcm] init failed:', err.message);
    return false;
  }
  return ready;
}

/**
 * Send a data-only high-priority call message to a set of FCM tokens.
 * @param {string[]} tokens
 * @param {object} data  string→string map (FCM requires string values)
 * @param {number} ttlMs default 30000
 * @returns {Promise<{ok:boolean, sent:number, dead:string[]}>}
 */
async function sendCallMessage(tokens, data, ttlMs = 30000) {
  const dead = [];
  if (!Array.isArray(tokens) || !tokens.length) return { ok: false, sent: 0, dead };
  if (!init()) return { ok: false, sent: 0, dead };

  const payload = {};
  for (const [k, v] of Object.entries(data || {})) payload[k] = v == null ? '' : String(v);

  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      data: payload,
      android: {
        priority: 'high',
        ttl: ttlMs,
        // No `notification` block on purpose — data-only wakes the service.
      },
      apns: {
        headers: {
          'apns-push-type': 'voip',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + Math.floor(ttlMs / 1000)),
          'apns-topic': (process.env.IOS_BUNDLE_ID || 'com.vaultchat.app') + '.voip',
        },
        payload: { aps: { 'content-available': 1 } },
      },
    });
    let sent = 0;
    res.responses.forEach((r, i) => {
      if (r.success) { sent++; return; }
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') dead.push(tokens[i]);
      else console.warn('[callFcm] send error:', code);
    });
    return { ok: sent > 0, sent, dead };
  } catch (err) {
    console.error('[callFcm] send failed:', err.message);
    return { ok: false, sent: 0, dead };
  }
}

module.exports = { sendCallMessage };
