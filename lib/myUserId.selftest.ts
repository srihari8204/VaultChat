// lib/myUserId.selftest.ts — run: npx tsx lib/myUserId.selftest.ts
//
// Covers the JWT-subject fallback in chatService.myUserId(), which exists
// because an EMPTY own-id makes both ownership guards fail open rather than
// fail safe (see the comment on myUserId). The decode is the part that can
// break quietly: it lives inside a try/catch whose only failure signal is the
// very empty string the fallback was added to prevent.
//
// The function itself needs SecureStore, so the decode is reproduced here
// exactly as written and exercised directly.

import assert from 'assert';
import { Buffer } from 'buffer';

/** Byte-for-byte the decode in chatService.myUserId(). */
function subOf(tok: string | null): string {
  try {
    const body = tok?.split('.')[1];
    if (!body) return '';
    const json = JSON.parse(
      Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return String(json?.sub ?? '');
  } catch { return ''; }
}

const mk = (payload: unknown, b64url = true) => {
  let b = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  if (b64url) b = b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${b}.signature`;
};

const UID = 'cb1caeda-e862-4578-9fab-9acd248ee77d';   // the Honor's real user id

// 1. The case that matters: a normal token yields the user id.
assert.strictEqual(subOf(mk({ sub: UID, exp: 1 })), UID, 'plain sub');

// 2. base64URL alphabet. A padded/─ or _-bearing payload must still decode:
//    '+' and '/' are illegal in a JWT segment, so without the replace() this
//    throws and the fallback silently returns '' — the exact failure mode the
//    fallback exists to remove. Keep generating until both chars appear.
//    Emoji reliably produce both (4-byte UTF-8 sequences hit the 62/63 groups);
//    ASCII payloads almost never do, which is why a naive generator finds
//    nothing and quietly tests less than it claims to.
let hit = '';
for (let i = 0; i < 400 && !hit; i++) {
  const t = mk({ sub: UID, n: '🙂🙃'.repeat(1 + (i % 5)) + i });
  const seg = t.split('.')[1];
  if (seg.includes('-') && seg.includes('_')) hit = t;
}
assert.ok(hit, 'expected a payload exercising both - and _');
assert.strictEqual(subOf(hit), UID, 'base64url payload with - and _');

// 3. Every malformed shape must return '' rather than throw — the caller has
//    no catch of its own beyond the outer one, and a throw here would poison
//    _meId for the rest of the session.
for (const bad of [null, '', 'not-a-jwt', 'a.b', 'a..c', 'a.!!!not-base64!!!.c', 'a.eyJub3RKc29u.c']) {
  assert.strictEqual(subOf(bad as any), '', `malformed: ${JSON.stringify(bad)}`);
}

// 4. A token with no sub is empty, NOT the string "undefined" — which is truthy
//    and would be memoised, permanently mis-identifying every own message.
assert.strictEqual(subOf(mk({ exp: 1 })), '', 'missing sub');
assert.strictEqual(subOf(mk({ sub: null })), '', 'null sub');

// 5. A non-string sub must not become an object; String() it or reject it, but
//    never hand a non-comparable value to `senderId === meId`.
assert.strictEqual(subOf(mk({ sub: 12345 })), '12345', 'numeric sub stringified');

console.log('myUserId JWT fallback: all checks passed');
