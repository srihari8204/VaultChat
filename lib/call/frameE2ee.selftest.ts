// lib/call/frameE2ee.selftest.ts — private calls are END TO END, not just in transit.
//
//   npx tsx lib/call/frameE2ee.selftest.ts
//
// SCOPE, STATED PLAINLY: PART BEHAVIOURAL, PART STRUCTURAL — the same split
// lib/call/callChat.selftest.ts uses, for the same reason. mintsMediaKey is a
// pure function and is really executed. Everything about the cryptor is read out
// of the SOURCE, because RTCFrameCryptor is a NATIVE module: it does not exist
// in Node, there are no senders or receivers without a real peer connection, and
// lib/call/engine.ts cannot even be imported here (it pulls in react-native).
//
// So this proves the WIRING is right. It CANNOT prove a device encrypts a frame
// — that remains device verification, and nothing here should be read as a
// substitute for it.
//
// WHY IT EXISTS
//
// Every call joins a LiveKit SFU room, and an SFU terminates SRTP in order to
// forward: without frame encryption the server can decode every frame of every
// private call. The fix existed and worked (lib/call/frameCrypto.ts, in
// production on the Go Live path) and was wired into exactly one place that was
// not calling. The failure mode this file guards is the quiet one: an attach
// that never happens looks identical to a call with no encryption at all, and
// the call works perfectly either way.

import { readFileSync } from 'fs';
import { join } from 'path';
// The minting rule lives in ./mode precisely so it can be executed without a
// device. Imported, never re-implemented — a copy of a rule is a copy that can
// drift, and if two participants ever mint at once the room splits in half and
// nobody can decode anybody.
import { mintsMediaKey } from './mode';
// Pure constants, executed rather than grepped — ./types.ts has no react-native
// in it precisely so this is possible.
import { MEDIA_KEY_WAIT_MS, REKEY_WAIT_MS, RING_TIMEOUT_MS } from './types';

const ROOT = join(__dirname, '..', '..');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const read = (p: string) => strip(readFileSync(join(ROOT, p), 'utf8'));
const ENGINE = read('lib/call/engine.ts');
const ROOM = read('lib/call/room.ts');
const TYPES = read('lib/call/types.ts');
const CRYPTO = read('lib/call/frameCrypto.ts');
// Comments matter in exactly one place: a header that tells the next reader
// calls are NOT end to end is worse than no header at all.
const ENGINE_RAW = readFileSync(join(ROOT, 'lib/call/engine.ts'), 'utf8');
const ROOM_RAW = readFileSync(join(ROOT, 'lib/call/room.ts'), 'utf8');

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nCall frame E2EE — the SFU must forward ciphertext\n');

// ── 1. exactly one participant mints the key (really executed) ────────
{
  const room = ['alice', 'bob', 'carol', 'dave'];
  const mints = (me: string) => mintsMediaKey({
    oneToOne: false, direction: 'outgoing', meId: me, others: room.filter(u => u !== me),
  });
  A(room.filter(mints).length === 1,
    '1. a group has exactly ONE minter — two would split the room and nobody '
    + 'could decode anybody');

  // 1:1 mints on the ANSWERING side, which is the participant that joins
  // SECOND. That is why the key is pushed on join and not only on a `joined`
  // event: nobody is ever announced to themselves.
  const oneToOne = (direction: 'outgoing' | 'incoming') =>
    mintsMediaKey({ oneToOne: true, direction, meId: 'me', others: ['peer'] });
  A(oneToOne('incoming') && !oneToOne('outgoing'),
    '1a. in 1:1 the answering side mints, and only it');
}

// ── 2. the room actually attaches cryptors, at the right moments ──────
{
  A(/import \{ enableFrameCrypto/.test(ROOM),
    '2. lib/call/room.ts uses frameCrypto at all — this is the whole defect: '
    + 'the module existed and the calling path never called it');
  A(/RTCFrameCryptorFactory/.test(read('lib/call/frameCrypto.ts')),
    '2a. and frameCrypto is the native insertable-streams cryptor, not a stub');

  // THE ATTACH-TIMING RULE, which is what broke last time. A sender does not
  // exist until a track is published and a receiver does not exist until one is
  // subscribed, so a single attach at join finds nothing whatsoever.
  const sub = ROOM.slice(ROOM.indexOf('RoomEvent.TrackSubscribed'));
  A(/attachCryptors/.test(sub.slice(0, 400)),
    '2b. attach runs on every SUBSCRIBE — without it every incoming frame stays '
    + 'ciphertext');
  const localPub = ROOM.slice(ROOM.indexOf('RoomEvent.LocalTrackPublished'));
  A(/attachCryptors/.test(localPub.slice(0, 400)),
    '2c. attach runs on every PUBLISH — a cryptor cannot exist before its sender');
  const recon = ROOM.slice(ROOM.indexOf('RoomEvent.Reconnected'));
  A(/attachCryptors/.test(recon.slice(0, 400)),
    '2d. and again after a RECONNECT, which rebuilds both transports and brings '
    + 'the new senders up bare');
  A(/crypto\?\.dispose\(\)/.test(ROOM), '2e. the cryptors are freed on leave');
}

// ── 3. FAIL CLOSED — the decision, pinned ─────────────────────────────
//
// A call that proceeds without a cryptor is a call the server can listen to,
// and it looks and sounds exactly like one that cannot. Every branch below has
// to end in "no call" rather than "a readable call".
{
  A(/export const CALL_FRAME_E2EE = true/.test(TYPES),
    '3. frame E2EE is ON for calls (lib/call/types.ts CALL_FRAME_E2EE)');

  const install = ROOM.slice(ROOM.indexOf('const installKey'));
  const body = install.slice(0, install.indexOf('if (a.e2eeKey)'));
  A(/!h\.active/.test(body) && /room\.disconnect/.test(body) && /throw new Error/.test(body),
    '3a. a cryptor that cannot be created FAILS THE CALL — it never degrades to '
    + 'a call the SFU can read');

  // The second half of fail-closed, and the one that is easy to get wrong:
  // publishing first and encrypting afterwards sends readable frames in the gap.
  const pubFn = ROOM.slice(ROOM.indexOf('const publishOwn'));
  const pubBody = pubFn.slice(0, pubFn.indexOf('const installKey'));
  A(/setMicrophoneEnabled/.test(pubBody) && /setCameraEnabled/.test(pubBody),
    '3b. publishing happens in ONE place');
  // EVERY OTHER WAY TO START SENDING is gated too. Unmute, camera-on and screen
  // share all publish, and all three are reachable during the window before the
  // key lands — that is a live hole, not a theoretical one.
  const gated = (name: string, end: string) => {
    const fn = ROOM.slice(ROOM.indexOf(name));
    return /if \(on && !mayPublish\(\)\)/.test(fn.slice(0, fn.indexOf(end)));
  };
  A(/const mayPublish = \(\) => !CALL_FRAME_E2EE \|\| !!crypto/.test(ROOM),
    '3c. there is ONE rule for "may a track start sending"');
  A(gated('async setMic(on)', 'async setCamera'), '3c.1 unmuting is gated on it');
  A(gated('async setCamera(on)', 'async flipCamera'), '3c.2 turning the camera on is gated on it');
  A(gated('async setScreenShare(on)', 'if (!on) return'), '3c.3 starting a screen share is gated on it');
  A(/else if \(!CALL_FRAME_E2EE\) await publishOwn\(\)/.test(ROOM),
    '3d. with no key and E2EE on, NOTHING is published — media waits for the '
    + 'key rather than travelling in the clear');
}

// ── 4. the engine supplies and rotates the key ────────────────────────
{
  A(/e2eeKey: s\.mediaKey/.test(ENGINE),
    '4. the engine hands the room a media key — the room is required to be told '
    + 'explicitly, as lib/golive/room.ts requires');
  A(/mintsMediaKey\(\{/.test(ENGINE),
    '4a. who mints comes from ./mode, the rule mediaKey.selftest already covers');
  A(/randomBytes\(32\)/.test(ENGINE),
    '4b. the key is 32 random bytes — frameCrypto rejects any other length');

  // THE REGRESSION THIS FILE EXISTS FOR: onMediaKey was `() => {}`. Inert, and
  // silently so — the callee would simply never publish.
  A(!/onMediaKey: \(\) => \{\}/.test(ENGINE),
    '4c. onMediaKey is NOT inert — an ignored key means a participant that never '
    + 'publishes and a call with one-way media');
  A(/onMediaKey: \(from, sealed\) => openFromPeer\(/.test(ENGINE),
    '4d. an incoming key is unwrapped through the pairwise ratchet');

  A(/rotateMediaKey\(s\)/.test(ENGINE),
    '4e. a departure RE-KEYS: the SFU keeps forwarding and has no idea who holds '
    + 'a key, so only a rotation makes the leaver go dark');
  const left = ENGINE.slice(ENGINE.indexOf('if (left) {'));
  A(left.indexOf('rotateMediaKey') < left.indexOf('if (joined)'),
    '4f. ...on the LEFT branch, after the roster has dropped them');

  // ── REKEY ON JOIN AS WELL AS LEAVE ──────────────────────────────────
  //
  // There was a rotation on leave and none on join: the minter simply re-sent
  // the EXISTING key to the newcomer. A key that predates them decrypts what
  // the SFU forwarded before they arrived, and an SFU is exactly where that
  // traffic can have been recorded.
  const joined = ENGINE.slice(ENGINE.indexOf('if (joined) {'));
  const joinBody = joined.slice(0, joined.indexOf('if (s.peerUid) return;'));
  A(/rotateMediaKey\(s\)/.test(joinBody),
    '4g. a JOIN re-keys too — a newcomer must not hold a key that predates them');
  A(!/shareMediaKey\(s\)/.test(joinBody),
    '4h. ...and the plain re-send of the old key is gone from that branch');
  // The fan-out reads the LIVE roster, so rotating before the joiner is in it
  // would seal the new key for everyone except the one person who needs it.
  A(joinBody.indexOf("dispatch({ type: 'role'") < joinBody.indexOf('rotateMediaKey'),
    '4i. ...after the roster gains them, or the new key never reaches the joiner');

  const recon = ENGINE.slice(ENGINE.indexOf('onReconnected:'));
  A(/rotateMediaKey\(s\)/.test(recon.slice(0, 500)),
    '4j. a RECONNECT re-keys — it rebuilds both transports, and it is the only '
    + 'healing point left now that the dead ratchet() is gone');
}

// ── 7. the key wait is BOUNDED ────────────────────────────────────────
//
// "No key yet → publish nothing" is the right rule and had no deadline, so its
// failure mode was unbounded: a dead ratchet on the minter's side meant the
// device stayed joined, subscribed and silently mute forever. That is the worst
// shape a failure can take — it is indistinguishable from a working call.
{
  A(Number.isFinite(MEDIA_KEY_WAIT_MS) && MEDIA_KEY_WAIT_MS > 0,
    '7. there IS a deadline on the wait for a media key');
  A(MEDIA_KEY_WAIT_MS > REKEY_WAIT_MS,
    '7a. longer than REKEY_WAIT_MS — a re-seal already in flight is never cut off');
  A(MEDIA_KEY_WAIT_MS < RING_TIMEOUT_MS,
    '7b. shorter than RING_TIMEOUT_MS — the callee never outlives a caller that '
    + 'has already given up');

  const waitBranch = ROOM.slice(ROOM.indexOf('holding media until the key arrives'));
  A(/setTimeout\(/.test(waitBranch.slice(0, 800)) && /MEDIA_KEY_WAIT_MS/.test(waitBranch.slice(0, 800)),
    '7c. and the room actually arms it');
  A(/onMediaKeyTimeout/.test(waitBranch.slice(0, 800)) && /room\.disconnect/.test(waitBranch.slice(0, 800)),
    '7d. which fails the call with a REASON, then disconnects — never a silent hang');
  A(/dispatch\(\{ type: 'error'/.test(ENGINE.slice(ENGINE.indexOf('onMediaKeyTimeout:'), ENGINE.indexOf('onMediaKeyTimeout:') + 400)),
    '7e. and the engine turns it into a user-facing, retryable message');
  A(/stopKeyWait\(\)/.test(ROOM.slice(ROOM.indexOf('const installKey'), ROOM.indexOf('const installKey') + 200)),
    '7f. a key that arrives disarms the deadline');
}

// ── 8. no security control that looks implemented and never runs ──────
{
  A(!/ratchetSharedKey/.test(CRYPTO),
    '8. frameCrypto.ratchet() is GONE — it had zero callers anywhere, and a '
    + 'unilateral ratchet would have broken decrypt for the whole room anyway');
  A(/keyRingSize: 2,/.test(CRYPTO),
    '8a. the key ring is 2 (current + immediately previous), not 16 — the ring '
    + 'is the window in which a rotated-out key still decrypts');
  A(/failureTolerance: -1/.test(CRYPTO),
    '8b. failureTolerance stays -1 on purpose: a finite one permanently mutes a '
    + 'participant on the normal burst of a rotation, and that is unrecoverable');
}

// ── 9. IP privacy is reachable, and does not degrade silently ─────────
{
  const ICE = read('lib/iceConfig.ts');
  A(/iceTransportPolicy: 'relay'/.test(ICE),
    '9. relay-only ICE exists at all — it appeared NOWHERE in this app, so a '
    + 'user who wanted their IP withheld from the peer had no way to ask');
  A(/getIceConfig/.test(ROOM) && /rtcConfig: iceConfig/.test(ROOM),
    '9a. and the call path passes the whole config, policy included, to connect');
  const fn = ICE.slice(ICE.indexOf('export async function getIceConfig'));
  A(/!hasTurn\(iceServers\)/.test(fn) && /throw new Error/.test(fn),
    '9b. relay-only with no TURN THROWS — the STUN-only degradation must not '
    + 'quietly override the privacy choice, and a relay policy with no relay '
    + 'gathers nothing at all');
}

// ── 5. the key never reaches the server in the clear ──────────────────
{
  const share = ENGINE.slice(ENGINE.indexOf('async function shareMediaKey'));
  const body = share.slice(0, share.indexOf('function applyMediaKey'));
  A(/sealAndFanOut\(/.test(body),
    '5. the key is sealed PER RECIPIENT over the Double Ratchet — the same '
    + 'fan-out in-call text uses, so no new key agreement is introduced');
  A(/signal\.sendMediaKey\(to, s\.chatId, sealed\)/.test(body),
    '5a. and what goes on the wire is the SEALED envelope, never the key');
  A(!/sendMediaKey\([^)]*mediaKey/.test(ENGINE),
    '5b. no path hands a raw key to the relay');
}

// ── 6. nothing in the code still claims calls are transit-only ────────
{
  A(!/not end to end/i.test(ENGINE_RAW),
    '6. lib/call/engine.ts no longer tells the next reader calls are not end to '
    + 'end — a stale comment here is how this got shipped twice');
  A(!/NO FRAME ENCRYPTION/.test(ROOM_RAW),
    '6a. nor does lib/call/room.ts');
}

console.log(failed === 0 ? '\nframeE2ee: all checks passed' : `\nframeE2ee: ${failed} FAILED`);
if (failed > 0) process.exit(1);
