// lib/call/signalFailClosed.selftest.ts — a call screen must never hand the
// server a plaintext SDP offer or ICE candidate, and the badge must never claim
// E2EE over a passthrough cipher.
//
//   npx tsx lib/call/signalFailClosed.selftest.ts
//
// SCOPE, STATED PLAINLY — the same split lib/vaultBeam/signalSealed.selftest.ts
// uses. lib/callCrypto.ts is RN-free, so its ciphers are REALLY EXECUTED here.
// app/voicecall.tsx, app/videocall.tsx, app/group-call-active.tsx and
// components/call/CallEncryptionBadge.tsx import react-native-webrtc, the
// socket and the native media modules, and cannot be loaded under Node at all —
// so they are read out of the SOURCE.
//
// WHAT WENT WRONG
//
// `newCallCipher()` returns null whenever the peer's key bundle cannot be
// fetched — a 404 on GET /user/:id/keybundle is enough. All three screens did:
//
//     const offerWire = sealed ? sealed.offerWire : offer;
//
// i.e. a RAW SDP over our own socket, silently, while the UI kept its
// encryption claim. The SDP carries the DTLS-SRTP fingerprint that anchors
// call-media encryption, so a server that can rewrite it MITMs the call; the
// ICE candidates that follow carry both devices' real IPs.
//
// The receiving half was the same hole from the other side: `openCallOffer()`
// hands back a passthrough cipher for any non-`sig1` object, callers only
// checked `offerObj?.type` — which a plaintext SDP has — and nobody checked
// `cipher.enc`. And `protectionFor()` read a compile-time flag, so the badge
// said "End-to-end encrypted" over all of it.
//
// None of it was visible: the call worked perfectly either way.

import { readFileSync } from 'fs';
import { join } from 'path';
import { plainCipher, openCallOffer } from '../callCrypto';

const ROOT = join(__dirname, '..', '..');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join('\n');
const read = (rel: string) => strip(readFileSync(join(ROOT, rel), 'utf8'));

const SCREENS: Array<[string, string]> = [
  ['voicecall', read('app/voicecall.tsx')],
  ['videocall', read('app/videocall.tsx')],
  ['group-call-active', read('app/group-call-active.tsx')],
];
const BADGE = read('components/call/CallEncryptionBadge.tsx');

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nCall signalling — sealed or not sent\n');

async function main(): Promise<void> {

// ── 1. the ciphers themselves, really executed ────────────────────────
{
  A(plainCipher.enc === false,
    '1. plainCipher.enc is false — the ONE bit that separates a real seal from '
    + 'the passthrough, and the bit nothing used to read');
  A(plainCipher.seal({ type: 'offer', sdp: 'v=0' }).sdp === 'v=0',
    '1a. and its seal() is a no-op, so "sealing" with it puts the raw SDP on '
    + 'the wire verbatim — the leak was invisible precisely because this works');

  // A plaintext SDP is exactly what a downgrading server would inject, and it
  // is what openCallOffer hands back untouched.
  const raw = { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA' };
  const { cipher, offer } = await openCallOffer('peer', raw);
  A(cipher.enc === false && offer === raw,
    '1b. openCallOffer() passes a plaintext offer straight through with a '
    + 'passthrough cipher — and `offer.type` is set, which is why the old '
    + '`if (!offerObj?.type)` check waved it past');
}

// ── 2. no cipher → NO plaintext SDP is emitted ────────────────────────
for (const [name, SRC] of SCREENS) {
  // The exact shape of the old bug, in any of its three spellings.
  A(!/sealed\s*\?\s*sealed\.offerWire\s*:/.test(SRC),
    `2. ${name}: the caller no longer falls back to the raw offer when `
    + 'newCallCipher() returns null');
  const setup = SRC.slice(SRC.indexOf('await newCallCipher'));
  const body = setup.slice(0, setup.indexOf("emit('webrtc_offer'"));
  A(/if \(!sealed\)/.test(body) && /throw new Error/.test(body),
    `2a. ${name}: it ABORTS instead — a call that cannot be sealed is not placed`);
  // Error copy has to name the cause and the fix, not just fail.
  A(/encryption keys/.test(body) && /(update|open crazzychat)/.test(body),
    `2b. ${name}: and says what happened and what to do about it`);
}

// ── 3. the answering half fails closed too ────────────────────────────
for (const [name, SRC] of SCREENS) {
  A(/if \(!cipher\.enc\)/.test(SRC),
    `3. ${name}: an UNSEALED offer from the peer is refused — answering it `
    + 'would put our own fingerprint and candidates on the wire in the clear');
  // Ordering matters and is easy to get backwards: openCallOffer signals a
  // STALE SESSION as {passthrough, offer:null} and a LEGACY PEER as
  // {passthrough, offer:<sdp>}. Check the null first or both get the
  // "they're on an old version" copy, which is wrong half the time.
  A(SRC.indexOf('?.type)') < SRC.indexOf('if (!cipher.enc)'),
    `3a. ${name}: the null-offer (stale session) check comes FIRST, so the two `
    + 'failures do not get each other\'s error message');
}

// ── 4. candidates cannot escape unsealed, whatever the path ───────────
//
// Two properties, and the second was added after the first was satisfied in a
// way that broke calls.
//
// The original assertion demanded a bare `.enc) return;` before the emit. That
// is fail-closed, and it was ALSO data loss: ICE gathering starts the moment
// setLocalDescription resolves, while the cipher only exists after a network
// fetch of the peer's key bundle. So every host candidate — the ones that make
// a same-LAN or friendly-NAT call connect — hit the guard and was discarded.
// They are never re-gathered, and the sealed offer carries none (trickle ICE).
//
// So the rule is not "drop it": it is "it must not go out unsealed". Holding
// the candidate and flushing it once the cipher lands satisfies that and keeps
// the call working. Accept either shape, and where the screen holds, REQUIRE
// that the held ones are actually sealed on the way out — otherwise "hold" is
// just a slower drop.
for (const [name, SRC] of SCREENS) {
  const h = SRC.slice(SRC.indexOf('onicecandidate'));
  const guard = h.slice(0, h.indexOf("emit('webrtc_ice'"));

  const returnsEarly = /\.enc\)?\s*\)?\s*return;/.test(guard) || /!c\?\.enc\) return;/.test(guard);
  const holds = /\.enc\)\s*\{[^}]*push\([^)]*\);\s*return;\s*\}/.test(guard);

  A(returnsEarly || holds,
    `4. ${name}: the one function that puts a candidate on the wire refuses to `
    + 'run without a real cipher — candidates carry device IPs');

  if (holds) {
    // The flush must seal. A flush that emitted the raw candidate would pass
    // the guard check above and reintroduce exactly the leak this file exists
    // to prevent.
    // Shape-agnostic on purpose: the 1:1 screens hold one array and reset it to
    // [], the mesh holds one per uid and `delete`s the entry. Both are correct.
    // What must be true in either case is that the buffer is emptied and the
    // flush seals, so assert THAT rather than one spelling of it.
    const cleared = /pending\w*Ice\w*\.current(\s*=\s*\[\];|\[\w+\]\s*=\s*\[\];)/.test(SRC)
      || /delete pending\w*Ice\w*\.current\[/.test(SRC);
    const flushSeals = /\.seal\(\w+\)/.test(SRC.slice(SRC.indexOf('pendingOutIce') >= 0
      ? SRC.indexOf('flushOutIce') : SRC.indexOf('pendingIce')));
    A(cleared && flushSeals,
      `4a. ${name}: held candidates are flushed SEALED and the buffer is cleared `
      + '— holding them and then emitting raw would be the original leak');
  }
}

// ── 5. the badge reads the LIVE cipher, not a build flag ──────────────
{
  A(!/return CALL_FRAME_E2EE \? 'e2ee' : 'transport';/.test(BADGE),
    "5. protectionFor() no longer answers from a compile-time flag alone — its "
    + 'own docstring always said it must not');
  A(/signalling: CallCipher \| CallCipher\[\] \| null/.test(BADGE),
    '5a. it takes the live signalling cipher(s), and `null` is EXPLICIT (the '
    + 'engine path, whose SDP never crosses our server) rather than an implicit '
    + '"caller forgot"');
  A(/links\.every\(c => !!c && c\.enc === true\)/.test(BADGE),
    '5b. one unsealed link downgrades the whole badge, and a MISSING entry '
    + 'counts as unsealed rather than as not-applicable');

  // The rule itself, executed rather than read.
  const rule = (links: any[] | null) =>
    links == null ? 'e2ee' : links.every(c => !!c && c.enc === true) ? 'e2ee' : 'transport';
  A(rule([plainCipher]) === 'transport',
    '5c. a passthrough cipher reads as "Encrypted in transit" — the one '
    + 'outcome that was unacceptable was claiming E2EE over it');
  A(rule([{ enc: true }, plainCipher]) === 'transport',
    '5d. and one plaintext link in a mesh of sealed ones still downgrades it');
  A(rule([{ enc: true }, { enc: true }]) === 'e2ee' && rule([]) === 'e2ee',
    '5e. a fully sealed mesh (and an empty one, where nothing is claimed yet) '
    + 'still reads e2ee — the working path is untouched');
}

// ── 6. no call site has quietly kept the old one-arg form ─────────────
for (const [name, SRC] of SCREENS) {
  const calls: string[] = SRC.match(/protectionFor\([^)]*\)/g) || [];
  A(calls.every(c => c.includes(',')),
    `6. ${name}: every protectionFor() call passes the evidence argument `
    + `(${calls.length} call site${calls.length === 1 ? '' : 's'})`);
}

console.log(failed === 0 ? '\nsignalFailClosed: all checks passed' : `\nsignalFailClosed: ${failed} FAILED`);
if (failed > 0) process.exit(1);

}

main().catch(e => { console.error(e); process.exit(1); });
