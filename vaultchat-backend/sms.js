// vaultchat-backend/sms.js
//
// Twilio SMS sender for phone OTP (Day 17).
//
// Gated on env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and one of
// TWILIO_MESSAGING_SERVICE_SID (preferred — Twilio routes to the right
// sender per country) OR TWILIO_FROM_NUMBER (a single E.164 number).
//
// If those env vars are unset, sends fall through to console.log so dev
// without a Twilio account still works (the code prints in the server logs;
// devs grab it from there).
//
// We deliberately do NOT pull in the twilio npm SDK to keep the bundle
// thin — it's a 4MB dep for a single REST call.

const SID    = process.env.TWILIO_ACCOUNT_SID;
const AUTH   = process.env.TWILIO_AUTH_TOKEN;
const MSGSID = process.env.TWILIO_MESSAGING_SERVICE_SID;
const FROM   = process.env.TWILIO_FROM_NUMBER;

const CONFIGURED = !!(SID && AUTH && (MSGSID || FROM));

if (!CONFIGURED) {
  console.warn('[sms] Twilio not configured — phone OTPs will be logged to stdout (dev mode)');
}

/**
 * Send an OTP to a phone number.
 * phone: E.164 string, e.g. "+14155551234"
 * code:  6-digit string
 */
async function sendOTP(phone, code) {
  if (!CONFIGURED) {
    console.log(`[sms] OTP for ${phone}: ${code} (Twilio not configured — visible only here)`);
    return { ok: true, dev: true };
  }

  const body = new URLSearchParams();
  body.set('To',   phone);
  body.set('Body', `Your VaultChat code is ${code}. Don't share it. It expires in 10 minutes.`);
  if (MSGSID) body.set('MessagingServiceSid', MSGSID);
  else        body.set('From', FROM);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`;
  const auth = Buffer.from(`${SID}:${AUTH}`).toString('base64');

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Authorization':  `Basic ${auth}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio send failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return { ok: true };
}

module.exports = { sendOTP, isConfigured: () => CONFIGURED };
