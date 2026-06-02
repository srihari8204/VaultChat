// Expo Push API client (Day 2).
//
// One function: sendPushToTokens(tokens, payload)
//   tokens  — array of ExponentPushToken[...] strings
//   payload — { title, body, data?, sound? }
//
// The Expo Push endpoint takes batches up to 100 messages per request.
// We chunk + fire-and-forget; receipts (read via Expo's receipts API)
// are a Day 3 polish item for tracking deliverability.
//
// Free service, no FCM/APNs setup required.
// https://docs.expo.dev/push-notifications/sending-notifications/

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH = 100;

async function sendPushToTokens(tokens, payload) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  const valid = tokens.filter(t => typeof t === 'string' && t.startsWith('Expo'));
  if (valid.length === 0) return;

  const base = {
    sound: payload.sound ?? 'default',
    title: payload.title,
    body:  payload.body,
    data:  payload.data ?? {},
    priority: 'high',
    channelId: 'default',                   // Android notification channel
    _displayInForeground: true,
  };

  for (let i = 0; i < valid.length; i += BATCH) {
    const chunk = valid.slice(i, i + BATCH).map(token => ({ to: token, ...base }));
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Accept':         'application/json',
          'Accept-encoding':'gzip, deflate',
        },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('[push] Expo Push returned', res.status, text.slice(0, 200));
        continue;
      }
      // Receipts (id per message) come back in the response. We ignore for
      // MVP — once we have a fan-out worker (pg-boss) we'll persist them
      // and chase failures.
    } catch (err) {
      console.error('[push] send failed:', err.message);
    }
  }
}

module.exports = { sendPushToTokens };
