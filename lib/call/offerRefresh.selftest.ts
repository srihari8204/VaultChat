// lib/call/offerRefresh.selftest.ts — the callee must answer the FRESHEST offer.
//
// WHY THIS EXISTS
// ---------------
// Encrypted calls between the two test devices could not connect, and the reason
// was not the cryptography — the re-key worked perfectly every time. It was that
// the callee had pinned the FIRST sealed envelope and could never see the one the
// caller re-sealed afterwards:
//
//   • app/incoming-call.tsx bailed out of its live `webrtc_offer` listener with
//     `if (offer) return`, on the reasoning that a route param already carried
//     the offer.
//   • app/_layout.tsx de-dupes repeat `call_incoming` events by peer, so the
//     re-sealed envelope arriving on THAT channel reached nothing either.
//
// So the caller's entire re-seal mechanism (lib/call/signal.ts `reseal`,
// lib/sessionEpoch.ts, engine.ts's epoch watcher) was architecturally dead on the
// normal foreground path, and Accept answered the same dead envelope forever.
//
// The fix is "always take the newer envelope", and the thing that decides
// newer-vs-repeat is offerTag(). That predicate is what this file pins down,
// because getting it wrong in either direction is silently catastrophic:
//
//   too eager  — a plain ring repeat looks like a re-seal, so the callee
//                restarts setup every 3s and never completes one.
//   too lax    — a genuine re-seal looks like a repeat, which is exactly the
//                bug above, back again.
//
// engine.ts and signal.ts cannot be imported here (they pull in React Native).
// diag.ts and types.ts are dependency-free on purpose, and they hold the two
// things that can actually be got wrong: the fingerprint, and the timing budget
// the recovery wait has to sit inside.

import { callFail, callStage, offerTag } from './diag';
import {
  REKEY_WAIT_MS, RING_INTERVAL_MS, RING_REPEATS, RING_TIMEOUT_MS,
} from './types';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// Realistic sealed wires. `h` is the ratchet-wrapped call key and `p` the sealed
// SDP — the shape lib/callCrypto.ts newCallCipher produces.
const WIRE_A = { v: 'sig1', h: 'ZmFrZS1yYXRjaGV0LWVudmVsb3BlLUE=', p: { v: 'sig1f', p: 'aXZB.Y3RB' } };
// Same call, re-sealed after a re-key: new wrapped key, new frame.
const WIRE_B = { v: 'sig1', h: 'ZmFrZS1yYXRjaGV0LWVudmVsb3BlLUI=', p: { v: 'sig1f', p: 'aXZC.Y3RC' } };
// A legacy peer's plaintext offer — no envelope at all.
const WIRE_PLAIN = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };

console.log('offerTag — the join key between two devices\' logs:');
check('is deterministic for the same wire', offerTag(WIRE_A) === offerTag(WIRE_A));
// The offer crosses app/incoming-call.tsx as a JSON string route param and
// reaches the engine as an object. If those disagreed, every accept would look
// like a re-seal and setup would restart forever.
check('object and its JSON string agree',
  offerTag(WIRE_A) === offerTag(JSON.stringify(WIRE_A)),
  `${offerTag(WIRE_A)} vs ${offerTag(JSON.stringify(WIRE_A))}`);
check('a re-sealed envelope tags DIFFERENTLY',
  offerTag(WIRE_A) !== offerTag(WIRE_B),
  'a re-seal that tagged the same would be discarded as a repeat — the original bug');
check('a plaintext legacy offer still tags', /^[0-9a-f]{8}$/.test(offerTag(WIRE_PLAIN)));

console.log('\n…and never leaks what it fingerprints:');
// The wire contains the ratchet-wrapped CALL KEY. The tag is printed to logcat,
// so it must be a hash and provably not a substring of the envelope.
const tagA = offerTag(WIRE_A);
check('the tag is exactly 8 hex characters', /^[0-9a-f]{8}$/.test(tagA), tagA);
check('…and appears nowhere in the sealed wire', !JSON.stringify(WIRE_A).includes(tagA));
check('empty / missing input degrades instead of throwing',
  offerTag(null) === '--------' && offerTag(undefined) === '--------' && offerTag('') === '--------');
{
  // An unserialisable wire must not take the call down on a diagnostic.
  const circular: any = { v: 'sig1' };
  circular.self = circular;
  let threw = false;
  let tag = '';
  try { tag = offerTag(circular); } catch { threw = true; }
  check('a circular wire returns a placeholder rather than throwing', !threw && tag === '--------');
}

console.log('\nthe staleness predicate the callee actually uses:');
// engine.acceptIncoming passes exactly this to signal.waitForNewOffer:
//   (w) => offerTag(w) === tag
// It is what decides whether an arriving offer is the repair or just the ring
// loop repeating itself.
const failedTag = offerTag(WIRE_A);
const isStale = (w: any) => offerTag(w) === failedTag;
check('a byte-identical ring repeat is STALE — keep waiting', isStale(WIRE_A));
check('…including one that arrived as a string', isStale(JSON.stringify(WIRE_A)));
check('a re-sealed envelope is NOT stale — take it', !isStale(WIRE_B));

// The ring loop re-sends the same wire every 3s until the session epoch moves,
// then switches to the fresh one. Walk that real sequence.
{
  const arrivals = [WIRE_A, WIRE_A, WIRE_A, WIRE_B, WIRE_B];
  const takenAt = arrivals.findIndex(w => !isStale(w));
  check('across a full repeat-then-reseal sequence, the FIRST fresh one is taken',
    takenAt === 3, `took index ${takenAt}, expected 3`);
  check('…and it is the re-sealed envelope, not a repeat',
    offerTag(arrivals[takenAt]) === offerTag(WIRE_B));
}

console.log('\nthe recovery wait has to fit inside the ring budget:');
// The re-seal is KICKED OFF by one ring tick (reseal() is async and returns null
// on the tick that starts it) and CARRIED by the next. A wait shorter than two
// intervals can therefore expire before the fresh envelope was ever sent.
check(`REKEY_WAIT_MS (${REKEY_WAIT_MS / 1000}s) covers at least two ring intervals`,
  REKEY_WAIT_MS >= 2 * RING_INTERVAL_MS,
  `${REKEY_WAIT_MS} < ${2 * RING_INTERVAL_MS} — could expire before the re-seal is sent`);
// Past RING_TIMEOUT_MS the caller has already hung up, so a callee still waiting
// is holding the mic for a call that no longer exists.
check(`…and expires before the caller gives up at ${RING_TIMEOUT_MS / 1000}s`,
  REKEY_WAIT_MS < RING_TIMEOUT_MS,
  `${REKEY_WAIT_MS} >= ${RING_TIMEOUT_MS} — the callee would outlive the caller's ring`);
// The wait starts when Accept is tapped, which can be late in the ring. It must
// still leave the last repeat a chance to land.
check('…and is shorter than the ring loop itself',
  REKEY_WAIT_MS < RING_REPEATS * RING_INTERVAL_MS,
  `${REKEY_WAIT_MS} >= ${RING_REPEATS * RING_INTERVAL_MS}`);

console.log('\nthe structured log lines:');
{
  const lines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: any[]) => { lines.push(a.join(' ')); };
  try {
    callStage(tagA, 'offer_decrypted');
    callStage(tagA, 'offer_resealed', 'superseding deadbeef');
    callFail(tagA, 'OFFER_DECRYPT', 'E2EE_SESSION_STALE', { retry: 1, recoverable: false });
  } finally {
    console.warn = realWarn;
  }
  check('a stage line is [call][tag][stage]', lines[0] === `[call][${tagA}][offer_decrypted]`, lines[0]);
  check('…and carries its detail when given',
    lines[1] === `[call][${tagA}][offer_resealed] superseding deadbeef`, lines[1]);
  check('a failure line is greppable and fully populated',
    lines[2] === `[call][${tagA}][FAIL] stage=OFFER_DECRYPT code=E2EE_SESSION_STALE retry=1 recoverable=false`,
    lines[2]);
  // Diagnostics run on the path that handles the wrapped call key. None of them
  // may ever carry it.
  check('no log line contains the sealed envelope',
    !lines.some(l => l.includes(WIRE_A.h) || l.includes(WIRE_A.p.p)));
}

console.log(failures === 0
  ? '\nALL OFFER-REFRESH CHECKS PASSED ✓'
  : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
