// lib/call/engine.ts — the call, owned outside React.
//
// REWRITTEN 2026-08-16. The previous engine ran its own WebRTC pipeline: peer
// connections, ICE and TURN, SDP offer/answer, per-pair signalling ciphers, a
// bitrate loop, and a hand-attached frame cryptor — with a LiveKit room bolted
// on beside it. Two media stacks, and every hard call bug on device lived where
// they met: audio that took 19 seconds to arrive because ICE had to fail and
// restart first, tracks the SDK refused to publish, a subscribe event that never
// reached the app while media flowed through the SFU underneath.
//
// The media is now entirely the SDK's (lib/call/room.ts): it captures,
// publishes, encrypts, subscribes and reconnects. What is left here is what is
// genuinely this app's:
//
//   RING        who is being called, over our own socket, with the ring budget
//   IDENTITY    the server call session (calls.id) and the role it grants
//   KEY         the call's 32-byte MEDIA KEY: minted by exactly one participant
//               (./mode mintsMediaKey), sealed per peer through the pairwise
//               Double Ratchet, and rotated when somebody leaves. lib/call/room
//               hands it to RTCFrameCryptor, so the SFU forwards ciphertext it
//               cannot read — calls are end to end again, not merely encrypted
//               in transit. Fail-closed rules: ./types.ts CALL_FRAME_E2EE.
//   STATE       the pure machine in ./machine, fed from SDK events
//   OS          the foreground service, the ring notification, the call log
//
// DISPOSAL is the other reason this exists: every acquired resource registers a
// teardown, and dispose() runs them once, in reverse order, on every exit path.

import { getCachedUser } from '../api';
import { CALL_SESSIONS } from '../../constants/flags';
import { leaveCallSession, openCallSession, ringCallGroup, setCallRole, setHandRaised, type CallRole } from '../callSession';
import { addCallLog } from '../callLog';
import { setSecure } from '../screenGuard';
import { nativeCall } from './native';
import { clearActiveCall, setActiveCall, type ActiveCall } from '../callState';
import * as media from './media';
import * as signal from './signal';
import { joinCallRoom, type CallRoom } from './room';
import { durationSeconds, shouldCancelRing, wasMissed, type CallFlag } from './machine';
import { dispatch, getSnapshot, begin, reset } from './store';
import { RING_TIMEOUT_MS } from './types';
import { callFail, callStage, offerTag } from './diag';
import { chatRecipients, mintsMediaKey } from './mode';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import type { CallChatMessage, CallKind, EndReason } from './types';

interface Session {
  chatId: string;
  /** The other party in a 1:1 call; '' for a group call. */
  peerUid: string;
  peerName: string;
  kind: CallKind;
  meId: string;
  meName: string;
  /** calls.id — the room's identity, and what the SFU token is minted against. */
  serverCallId: string;
  /** The live SDK room, once joined. */
  room: CallRoom | null;
  /**
   * True when THIS device opened the call, false when it joined one already
   * running. It is what decides whether anyone gets rung — see startGroup.
   */
  createdCall: boolean;
  /**
   * SFU credential handed back by POST /calls, when the server is new enough.
   * Present means join() skips its own round trip to /sfu-token.
   */
  sfu: import('../callSession').SfuCredential | null;
  /**
   * The call's 32-byte frame-encryption key, or null until it arrives.
   *
   * Held here rather than inside the room because it OUTLIVES the room object:
   * the key can land before join() has finished (the minter may already have
   * sent it), and join() picks up whatever is here.
   */
  mediaKey: Uint8Array | null;
  /** base64 of the key the ROOM is running, so a re-send is not reinstalled. */
  mediaKeyInstalled: string;
  disposers: (() => void)[];
  logged: boolean;
  disposed: boolean;
}

let session: Session | null = null;

// ── disposal ──────────────────────────────────────────────────────────
function onDispose(fn: () => void): void { session?.disposers.push(fn); }

function dispose(): void {
  const s = session;
  if (!s || s.disposed) return;
  s.disposed = true;
  for (const fn of s.disposers.reverse()) { try { fn(); } catch {} }
  s.disposers = [];
  nativeCall.endCallSession();
  // Re-arm the capture guard if the call died mid-share. stopScreenShare() is
  // the tidy path and restores it too, but a call can end without reaching it,
  // and leaving FLAG_SECURE off would silently disable the app-wide screenshot
  // block for the rest of the session.
  setSecure(true).catch(() => {});
}

const isDone = () => {
  const st = getSnapshot().status;
  return st === 'connected' || st === 'ended' || !!session?.disposed;
};

/**
 * Is this exact call already running?
 *
 * The screens start the engine from an effect keyed on route params, and those
 * params can change identity after mount. Each re-run started the call again,
 * and the replacement tore down the one that was setting itself up — measured
 * on device as three accept cycles for one call inside six seconds.
 */
function alreadyRunning(a: { chatId: string; peerUid: string }): boolean {
  const cur = session;
  return !!cur && !cur.disposed
    && cur.chatId === a.chatId && cur.peerUid === a.peerUid
    && getSnapshot().status !== 'ended';
}

/**
 * A SYNCHRONOUS claim on "a call is being set up for this chat+peer".
 *
 * `alreadyRunning` reads `session`, and `session` is not assigned until
 * bootstrap runs — which is THREE awaits deep in startOutgoing (a dynamic
 * import, checkSessionHealth, and waitForSession, the last of which can take
 * seconds while a ratchet repairs). Two invocations arriving inside that window
 * BOTH saw no session, both proceeded, and the second one's bootstrap called
 * hangUp('replaced') on the first — tearing down a live call and opening a
 * second calls row.
 *
 * That is the "it makes too many calls" report: measured on device as two call
 * ids seconds apart on one chat, each ringing the callee separately. The push
 * paths make it easy to hit — routeToCall is reachable from the native answer
 * intent AND three notifee handlers, with no de-duplication of its own.
 *
 * A promise claimed before the first await closes the window: the second caller
 * awaits the first's setup instead of racing it. Cleared on completion and on
 * failure, so a call that dies never blocks the next attempt.
 */
let setupClaim: { key: string; done: Promise<void> } | null = null;
const claimKey = (a: { chatId: string; peerUid: string }) => `${a.chatId}|${a.peerUid}`;

async function claimSetup(a: { chatId: string; peerUid: string }): Promise<boolean> {
  const key = claimKey(a);
  if (setupClaim && setupClaim.key === key) {
    // Someone is already setting this exact call up. Wait for them and do
    // nothing — returning false tells the caller to stand down.
    try { await setupClaim.done; } catch {}
    return false;
  }
  return true;
}

// ── lifecycle ─────────────────────────────────────────────────────────

/**
 * End the call. Idempotent — safe from any path, at any time.
 *
 * `only` scopes the hang-up to ONE call, and a screen unmounting must always
 * pass it. There is a single module-wide session, so a second call replaces the
 * first (bootstrap hangs the first up as 'replaced'); the first screen then
 * unmounts and, without this guard, its cleanup hung up whatever was active —
 * which by then is the NEW call. Answering a second call therefore killed it a
 * moment after it connected, and the cause looked like the second call failing
 * rather than the first call's teardown reaching across into it.
 *
 * Unscoped calls (the End button, a socket 'end', an error path) still mean
 * "end the current call, whatever it is", which is right for those.
 */
export function hangUp(
  reason: EndReason = 'local_hangup',
  notifyPeer = true,
  only?: { chatId: string; peerUid: string },
): void {
  const s = session;
  if (!s) return;
  if (only && !(s.chatId === only.chatId && s.peerUid === only.peerUid)) {
    // Not ours any more — a newer call owns the engine. Saying so is worth a
    // line: silence here reads identically to "there was nothing to hang up".
    console.warn('[call] stale unmount for', only.peerUid?.slice(0, 8), '— live call is', s.peerUid?.slice(0, 8), '— not hanging up');
    return;
  }
  const snap = getSnapshot();

  if (!s.logged) {
    s.logged = true;
    const durationSec = durationSeconds(snap, Date.now());
    const direction = snap.direction === 'incoming'
      ? (wasMissed(snap) ? 'missed' : 'incoming')
      : 'outgoing';
    addCallLog({
      chatId: s.chatId, peerUid: s.peerUid, peerName: s.peerName || 'crazzychat user',
      kind: s.kind, direction, at: Date.now() - durationSec * 1000, durationSec,
      group: !s.peerUid,
      callId: s.serverCallId || undefined,
    }).catch(() => {});
    // Abandoned before it was answered → stop the callee's ring so it becomes a
    // missed call rather than a phone that rings at nobody.
    if (shouldCancelRing(snap) && s.peerUid) {
      nativeCall.cancelRing(s.peerUid, String(s.chatId || s.peerUid)).catch(() => {});
    }
  }

  if (notifyPeer && s.peerUid) {
    signal.sendEnd(s.peerUid, s.meId, s.chatId, s.serverCallId).catch(() => {});
  }
  dispatch({ type: 'end', reason });
  dispose();
  session = null;
}

/** Clear the finished snapshot once the screen has popped. */
export function release(): void { reset(); }

/**
 * MINIMISE: leave the call screen without ending the call.
 *
 * The engine has always owned the call outside React — media is the SDK's, the
 * session and state machine live here — but the call screen's unmount effect
 * said "hang up", so navigating anywhere killed the call. That is why a call
 * took the whole app hostage: the only way off the screen was Android's system
 * picture-in-picture, which shrinks the entire activity and still does not let
 * you open a chat.
 *
 * Setting this flag makes the NEXT leaveScreen() a no-op, so the screen can
 * unmount while the call keeps running and <CallBar/> offers the way back.
 *
 * One-shot on purpose. A stuck flag would mean a call that can never be ended
 * by closing its screen, so leaveScreen consumes it and the default — unmount
 * ends the call — is restored immediately.
 */
let detachRequested = false;

export function minimizeScreen(): void {
  if (!session) return;
  detachRequested = true;
}

/** Is a call live and running behind the UI? Drives the CallBar's visibility. */
export function hasLiveSession(): boolean {
  return !!session;
}

/** The live call's identity, so the bar can route back into the right screen. */
export function liveSessionRef(): { chatId: string; peerUid: string; peerName: string; kind: CallKind } | null {
  const s = session;
  return s ? { chatId: s.chatId, peerUid: s.peerUid, peerName: s.peerName, kind: s.kind } : null;
}

/**
 * The screen-unmount path: end and clear, but ONLY if this screen still owns
 * the engine.
 *
 * Both halves have to be scoped together. hangUp(only) protects the newer
 * call's SESSION, but a bare release() would still reset() the shared snapshot
 * out from under it — the call would stay connected while its UI reverted to
 * an ended state, which is a worse bug than the one being fixed because the
 * audio keeps running with no way to end it.
 */
export function leaveScreen(only: { chatId: string; peerUid: string }): void {
  const s = session;
  if (s && !(s.chatId === only.chatId && s.peerUid === only.peerUid)) {
    console.warn('[call] stale unmount for', only.peerUid?.slice(0, 8), '— live call is', s.peerUid?.slice(0, 8), '— leaving it alone');
    return;
  }
  // Minimised: the screen is going away, the call is not. Consume the flag so
  // the next unmount behaves normally.
  if (detachRequested) {
    detachRequested = false;
    console.log('[call] screen minimised — call stays live');
    return;
  }
  hangUp('local_hangup', true, only);
  release();
}

interface StartArgs {
  chatId: string;
  peerUid: string;
  peerName: string;
  kind: CallKind;
}

/**
 * Everything both directions need: identity, the server call session, the
 * socket listeners, the foreground service and the call-waiting registration.
 *
 * Note what is NOT here any more — no getUserMedia, no TURN fetch, no peer
 * connection. Media does not exist until the room is joined, and the room owns
 * it from then on.
 */
async function bootstrap(a: StartArgs, direction: 'outgoing' | 'incoming') {
  if (session) hangUp('replaced', true);

  begin({ ...a, direction });
  session = {
    ...a, meId: '', meName: '', serverCallId: '', room: null, createdCall: false, sfu: null,
    mediaKey: null, mediaKeyInstalled: '', disposers: [], logged: false, disposed: false,
  };
  const s = session;

  const me = await getCachedUser();
  if (!me?.id) throw new Error('Not signed in');
  s.meId = me.id;
  s.meName = me.name ?? me.email ?? 'You';
  dispatch({ type: 'me', uid: me.id });

  // The server call session IS the room. Awaited, unlike the old engine which
  // fired it off and forgot: no id, no SFU token, no call.
  const res = await openCallSession(a.chatId, a.kind, 'meeting');
  if (!res?.call?.id) throw new Error('Could not start the call session');
  s.serverCallId = res.call.id;
  // The server answers "did you open this call, or join one already running?"
  // — the same question the unique partial index on calls(chat_id) settles when
  // two people start at once. Nothing else can know it: the loser of that race
  // asked to start and was given a join.
  s.createdCall = !!res.created;
  // One round trip instead of two — see SfuCredential in lib/callSession.ts.
  s.sfu = res.sfu ?? null;
  dispatch({
    type: 'session', sessionId: res.call.id,
    myRole: res.participants?.find(p => p.userId === s.meId)?.role,
  });
  for (const p of res.participants ?? []) {
    if (p.userId === s.meId || p.leftAt) continue;
    // The name too, not just role/hand. Without this participants[uid].name
    // stays '' and every in-call chat line in a GROUP reads 'Participant'.
    const pname = (p as { name?: string }).name;
    if (pname) dispatch({ type: 'peer_name', uid: p.userId, name: pname });
    dispatch({ type: 'role', uid: p.userId, role: p.role });
    dispatch({ type: 'hand', uid: p.userId, at: p.handRaisedAt ? Date.parse(p.handRaisedAt) || 0 : 0 });
  }
  // Leaving is a DISPOSER so it covers every exit path there is, not only the
  // one somebody remembered. The server ends a call when its last participant
  // leaves, so this is also what closes the row.
  onDispose(() => { if (s.serverCallId) void leaveCallSession(s.serverCallId); });

  // MUST start while the app still legitimately holds the microphone, and
  // Android 14+ only allows starting a mic-type foreground service from the
  // foreground — call setup is foreground by construction, `connected` may not
  // be. Android 11+ feeds SILENCE to a backgrounded app with no such service,
  // which is what made "press home while it rings" produce a one-way call.
  startCallForegroundService(s);

  const detach = await signal.attachCallListeners({
    // WHO IS ALLOWED TO SPEAK INTO THIS CALL.
    //
    // 1:1 has always been strict — only the peer. Group used to accept ANY
    // sender, which was harmless while nothing group-shaped was ever received;
    // now that in-call chat and reactions fan out to a group, it is the
    // difference between a side channel among the people in the room and one
    // any account that knows your uid can type into. The relay addresses by
    // `to` and stamps `from`, so the sender cannot be forged — but nothing made
    // them a PARTICIPANT.
    //
    // The live roster is the test. A message from someone who joins in the same
    // instant can lose the race and be dropped; that is the right way to be
    // wrong here.
    accept: (from) => (s.peerUid ? from === s.peerUid : !!getSnapshot().participants[from]),
    currentCallId: () => s.serverCallId,
    // No SDP crosses the wire any more. These three exist on the listener
    // interface for the group-mesh era and are deliberately inert.
    onOffer: () => {},
    onAnswer: () => {},
    onIce: () => {},
    onEnd: () => hangUp('remote_hangup', false),
    onPeerScreenShare: (_from, on) => dispatch({ type: 'flag', key: 'peerSharing', value: on }),
    // THE CALL'S MEDIA KEY, sealed for us by whoever minted it. `accept` above
    // already restricts this to the peer (1:1) or a live participant (group),
    // and openFromPeer unwraps it through the pairwise ratchet — so a key that
    // is not from someone in the room cannot reach applyMediaKey.
    onMediaKey: (from, sealed) => openFromPeer(from, sealed, b64 => applyMediaKey(s, b64)),
    onChat: (from, sealed) => openFromPeer(from, sealed, text =>
      dispatch({ type: 'chat', message: chatMessage(from, peerNameOf(s, from), text, false) })),
    onReaction: (from, sealed) => openFromPeer(from, sealed, emoji =>
      dispatch({ type: 'reaction', reaction: { id: nextId(), uid: from, emoji, at: Date.now() } })),
  });
  onDispose(detach);

  void signal.attachSessionListeners({
    chatId: s.chatId,
    currentCallId: () => s.serverCallId,
    onRole: (uid, role) => dispatch({ type: 'role', uid, role: role as any }),
    onHand: (uid, raised) => dispatch({ type: 'hand', uid, at: raised ? Date.now() : 0 }),
    onEnded: () => hangUp('remote_hangup', false),
  }).then(off => { if (s.disposed) off(); else onDispose(off); }).catch(() => {});

  registerForCallWaiting(a);
  return { s, me };
}

/**
 * Join the room and wire the SDK's events to the call state.
 *
 * The token is minted per call and per role by the server, which is what makes
 * an audience member unable to publish however the client behaves.
 */
/** How long a group call may sit empty before it ends itself. */
const ALONE_GRACE_MS = 20_000;

// ── the call's media key ──────────────────────────────────────────────
//
// WHY THERE IS A KEY AT ALL: an SFU terminates SRTP in order to forward, so
// without frame encryption the server decodes every frame. lib/call/frameCrypto
// encrypts each frame before it reaches the transport; this is where its key
// comes from.
//
// NOTHING NEW IS AGREED HERE. One participant mints 32 random bytes and seals
// them ONCE PER PEER through the Double Ratchet the chat already runs — exactly
// what lib/callCrypto does for signalling and what services/crypto/groupSession
// does to distribute a sender key. The server relays an opaque envelope.
//
// WHO MINTS is ./mode's mintsMediaKey, which is already covered by
// mediaKey.selftest and mode.selftest: the ANSWERING side in 1:1, the lowest uid
// in a group. Exactly one, so the room cannot split across two keys.

const keyB64 = (k: Uint8Array) => Buffer.from(k).toString('base64');

function iMintTheKey(s: Session): boolean {
  return mintsMediaKey({
    oneToOne: !!s.peerUid,
    direction: getSnapshot().direction === 'incoming' ? 'incoming' : 'outgoing',
    meId: s.meId,
    others: Object.keys(getSnapshot().participants).filter(u => u !== s.meId),
  });
}

/**
 * Seal the current key for everyone on the call and send it.
 *
 * Re-sent on every join rather than only to the joiner: the participant who
 * mints may itself be the one arriving, and a joiner is never announced to
 * itself — so "send it to whoever is there" is the only version that converges
 * from both sides. N ratchet wraps per join, the same price in-call chat pays
 * per message.
 */
async function shareMediaKey(s: Session, key: Uint8Array | null = s.mediaKey): Promise<void> {
  if (!key || s.disposed) return;
  await sealAndFanOut(s, keyB64(key),
    (to, sealed) => signal.sendMediaKey(to, s.chatId, sealed));
}

/** A key arrived from the minter — install it, or hold it for join(). */
function applyMediaKey(s: Session, b64: string): void {
  let key: Uint8Array;
  try { key = new Uint8Array(Buffer.from(b64, 'base64')); } catch { return; }
  if (key.length !== 32) return;
  s.mediaKey = key;
  // Before the room exists this is all there is to do: join() reads s.mediaKey.
  if (!s.room) return;
  // The minter re-sends the key on every join, so most arrivals are a key we are
  // already running. Installing it again is harmless but pointless churn.
  if (s.mediaKeyInstalled === b64) return;
  s.mediaKeyInstalled = b64;
  s.room.setMediaKey(key).catch(err => {
    // The room refuses a key it cannot install, which means this device cannot
    // encrypt frames. Fail closed: end the call rather than keep a session the
    // server can read — see CALL_FRAME_E2EE.
    console.warn('[call] could not install the media key —', err?.message ?? err);
    dispatch({ type: 'error', message: 'Secure calling is unavailable on this device' });
    hangUp('setup_error', true);
  });
}

/**
 * Somebody left: mint a NEW key so they go dark.
 *
 * On a mesh this was free — their connection was gone. Through an SFU it is
 * not: the server keeps forwarding, and a departed member who kept listening
 * would still hold a working key. Only a rotation removes them.
 *
 * The new key is sent BEFORE we switch to it, so the people still here are not
 * briefly unable to decode us. frameCrypto's key ring (2 entries) covers the
 * remaining overlap in the other direction.
 *
 * Called on LEAVE, on JOIN, and on RECONNECT — see the room events in join().
 */
function rotateMediaKey(s: Session): void {
  if (s.disposed || !s.room || !iMintTheKey(s)) return;
  const next = randomBytes(32);
  void (async () => {
    await shareMediaKey(s, next).catch(() => {});
    applyMediaKey(s, keyB64(next));
  })();
}

async function join(s: Session): Promise<void> {
  // Per-participant video sources, so a screen share and a camera can coexist.
  const cams = new Map<string, string>();
  const screens = new Map<string, string>();
  let aloneTimer: ReturnType<typeof setTimeout> | null = null;
  onDispose(() => { if (aloneTimer) clearTimeout(aloneTimer); });
  // PREFER THE CREDENTIAL THE JOIN ALREADY RETURNED.
  //
  // Falling back is not a rare path to be tidied away later: it is what makes
  // this shippable independently of the server. An older binary sends no `sfu`,
  // and this simply costs the round trip it always did.
  const cred = s.sfu ?? await (await import('./sfuToken')).getSfuToken(s.serverCallId);
  if (s.sfu) callStage(s.serverCallId.slice(0, 8) || '--------', 'token_inline', 'saved a round trip');
  if (s.disposed) return;

  // MINT BEFORE JOINING, if it is our job. The room publishes nothing until it
  // has a key (CALL_FRAME_E2EE), so the minter is the one participant whose
  // media starts immediately; everyone else starts one relay hop later, when
  // the sealed key reaches them.
  if (!s.mediaKey && iMintTheKey(s)) s.mediaKey = randomBytes(32);
  const joinedWith = s.mediaKey;
  if (joinedWith) s.mediaKeyInstalled = keyB64(joinedWith);

  const room = await joinCallRoom({
    url: cred.url,
    token: cred.token,
    video: s.kind === 'video',
    publish: cred.role !== 'audience',
    e2eeKey: s.mediaKey,
    events: {
      // The reducer already owns both of these: 'reconnecting' is ignored
      // unless the call is connected, and 'recovered' is ignored unless it is
      // reconnecting (machine.ts:168-181). So they are dispatched unguarded —
      // a second Reconnecting, or one arriving while the call is still
      // dialling, costs nothing and changes nothing.
      onReconnecting: () => dispatch({ type: 'reconnecting' }),
      onReconnected: () => {
        dispatch({ type: 'recovered' });
        // A reconnect rebuilds both peer connections and brings fresh senders
        // and receivers up, which makes it the natural point to heal the key
        // as well — and now the ONLY one, since frameCrypto's never-called
        // ratchet() is gone. No-op unless we mint.
        rotateMediaKey(s);
      },
      // The room waited MEDIA_KEY_WAIT_MS for a key and never got one, so it
      // has published nothing and disconnected. Say why: the silent version of
      // this is a call that looks connected and carries no audio at all.
      onMediaKeyTimeout: () => {
        dispatch({ type: 'error', message: 'Could not set up encryption for this call — please try again' });
        hangUp('setup_error', true);
      },
      // Stamped into the store, not acted on here. The grid reads the stamps
      // and decides which tiles to show; a 1:1 screen ignores them entirely.
      onActiveSpeakers: (uids) => { if (uids.length) dispatch({ type: 'speaking', uids }); },
      onParticipants: (count, joined, left) => {
        if (left) {
          dispatch({ type: 'peer_left', uid: left.identity });
          // 1:1: the other side leaving the room IS the end of the call.
          if (s.peerUid) { hangUp('remote_hangup', false); return; }
          // Group: re-key so the person who left cannot keep decoding what the
          // SFU is still forwarding. Dispatched first, so the roster this reads
          // no longer contains them.
          rotateMediaKey(s);
        }
        if (joined) {
          // Someone who joins AFTER us is not in the join response, so their
          // name has to come from the SFU participant — the token carries it
          // (mintSfuCredential sets Name). Without this they chat as
          // 'Participant' while everyone present at join has a real name.
          const jname = (joined as { name?: string }).name;
          if (jname) dispatch({ type: 'peer_name', uid: joined.identity, name: jname });
          dispatch({ type: 'role', uid: joined.identity, role: 'speaker' });
          // RE-KEY ON JOIN, exactly as on leave.
          //
          // This used to re-send the EXISTING key to the newcomer. A key that
          // predates them is a key that decrypts what the SFU forwarded before
          // they arrived — and an SFU is precisely a place where that traffic
          // can have been recorded. Minting a fresh one costs the same N
          // ratchet wraps the re-send already cost.
          //
          // AFTER the dispatches, deliberately: the fan-out targets are read
          // from the live roster, so rotating first would seal the new key for
          // everyone EXCEPT the person who just joined.
          rotateMediaKey(s);
        }

        // A GROUP CALL WITH NOBODY ELSE IN IT IS OVER.
        //
        // Members left one at a time and the last person was still sitting in
        // a live call, alone, holding the microphone and the foreground
        // service — with nothing to do and no indication anything had ended.
        //
        // Not ended on the instant: someone whose network dropped reappears
        // within seconds, and killing the call under them would be worse than
        // the empty room. The grace window is cancelled the moment anyone
        // arrives, so a rejoin is seamless.
        if (s.peerUid) return;              // 1:1 is handled above
        if (count > 1) {
          if (aloneTimer) { clearTimeout(aloneTimer); aloneTimer = null; }
          return;
        }
        if (aloneTimer) return;
        aloneTimer = setTimeout(() => {
          aloneTimer = null;
          if (s.disposed) return;
          console.warn('[call] last participant in the group call — ending it');
          hangUp('remote_hangup', false);
        }, ALONE_GRACE_MS);
      },
      // The authoritative "this call is up" signal. Everything else — the ring
      // loop, the ring timeout, the duration timer — keys off the status this
      // sets, which is why it goes through the same reducer event the old
      // ontrack path used.
      onRemote: (uid, url, kind, screen) => {
        // ONE participant, TWO possible videos: their camera and their screen.
        //
        // Keeping a single URL per person meant whichever arrived last won, so
        // starting a screen share showed the camera (or the reverse) at random
        // — measured on device as "it says sharing but nothing is shared".
        // Both are tracked; the SCREEN wins while it exists, because that is
        // what the person chose to show.
        if (kind === 'video') {
          if (screen) { if (url) screens.set(uid, url); else screens.delete(uid); }
          else cams.set(uid, url ?? '');
        }
        const best = screens.get(uid) || cams.get(uid) || (kind === 'audio' ? url : null);
        dispatch({
          type: 'remote_stream', uid,
          url: best ?? null,
          name: s.peerUid === uid ? s.peerName : undefined,
        });
        if (kind === 'video') {
          // Per-participant, for EVERY uid — this is what a group grid reads.
          dispatch({ type: 'peer_sharing', uid, sharing: screens.has(uid) });
          // The 1:1 flag is left exactly as it was, so the video screen's
          // existing share banner keeps its behaviour unchanged.
          if (s.peerUid === uid) {
            dispatch({ type: 'flag', key: 'peerSharing', value: screens.has(uid) });
          }
        }
      },
      onLocal: (url) => dispatch({ type: 'local_stream', url }),
      // ONE teardown, whichever way the share ended.
      //
      // Android puts its own "Stop sharing" control in the notification
      // shade, and the OS honours it without telling our UI. Without this the
      // flag stayed on, the peer was never told, and — the part that matters —
      // FLAG_SECURE was never put back, leaving the app screenshot-able for
      // the rest of the session because a share had once been started.
      onScreenShareStopped: () => { void stopScreenShare(); },
      onClosed: () => { if (!s.disposed) hangUp('failed', false); },
    },
  });

  if (s.disposed) { void room.leave(); return; }
  s.room = room;
  onDispose(() => { void room.leave(); });
  // PUSH THE KEY THE MOMENT WE ARE IN. The minter is usually the one who joined
  // SECOND (1:1 mints on the answering side), and nobody is announced to
  // themselves — so waiting for a `joined` event would leave the first joiner
  // holding no key and publishing nothing, forever.
  if (s.mediaKey) void shareMediaKey(s).catch(() => {});
  // A key that landed WHILE joinCallRoom was connecting was stored on the
  // session and could not be installed — there was no room yet, and the room was
  // handed `joinedWith` (usually null). This is that window's only cure.
  if (s.mediaKey && s.mediaKey !== joinedWith) applyMediaKey(s, keyB64(s.mediaKey));
  callStage(s.serverCallId.slice(0, 8) || '--------', 'room_joined',
    `${s.kind} role=${cred.role}`);
}

/** Place a call. Rejects only on setup failure; the call is torn down first. */
export async function startOutgoing(a: StartArgs): Promise<void> {
  if (alreadyRunning(a)) return;
  if (!(await claimSetup(a))) return;
  let release!: () => void;
  setupClaim = { key: claimKey(a), done: new Promise<void>(r => { release = r; }) };
  try {
    // Re-check AFTER taking the claim: a call may have completed setup while we
    // were awaiting a previous claim above.
    if (alreadyRunning(a)) return;
    // Verify the secure session BEFORE dialling. The ring envelope is sealed
    // with this peer's ratchet; dial with a stale one and the callee cannot
    // open it, so it never learns the key and never joins — which to the user
    // is "calling…" forever.
    const { checkSessionHealth, waitForSession } = await import('./sessionHealth');
    if (await checkSessionHealth(a.peerUid) === 'repairing') {
      dispatch({ type: 'error', message: 'Reconnecting secure session…' });
      await waitForSession(a.peerUid);
    }

    const { s, me } = await bootstrap(a, 'outgoing');

    // ── the ring ──────────────────────────────────────────────────────
    //
    // Just "this call, this kind". Nothing secret travels here any more, so it
    // is sent in the clear: the callee cannot join on the strength of this
    // anyway — the server mints a room token only for a member of the chat, and
    // only while the call row is live.
    //
    // Removing the sealed envelope removed a whole class of failures with it.
    // The ring used to be wrapped in the Double Ratchet, so a stale session —
    // one side reinstalling, a missed re-key — meant the callee could not open
    // the ring at all and the call died with "reconnecting the secure session",
    // which is not something a user can act on.
    const wire = { v: 'vk2', callId: s.serverCallId, kind: a.kind };

    const cancelRing = await signal.ringAndOffer({
      to: a.peerUid, from: s.meId, chatId: a.chatId,
      type: a.kind === 'video' ? 'video' : 'audio',
      // BLANK, never a placeholder. The callee's screens only run their name
      // lookup when this arrives empty, so sending "crazzychat user" pinned that
      // placeholder on the receiver for the whole call.
      callerName: me.name ?? me.email ?? '',
      offer: wire,
    }, isDone);
    onDispose(cancelRing);

    // High-priority wake-up so a killed or dozing callee still rings.
    nativeCall.ringPeer({ calleeId: a.peerUid, callId: String(a.chatId || a.peerUid), isVideo: a.kind === 'video' })
      .catch(() => {});

    callStage(offerTag(wire), 'ring_sent', `${a.kind}, call=${s.serverCallId.slice(0, 8)}`);
    dispatch({ type: 'offer_sent' });

    // Join WHILE it rings. Being in the room first is what makes the callee's
    // first frame arrive the moment they accept, instead of after a second
    // round of setup — and it is why the ring budget is no longer spent on
    // anything but the callee's attention.
    await join(s);

    // END THE CALL WHEN THE RING BUDGET RUNS OUT. Without this the call sat in
    // `ringing` forever, holding the mic and the foreground service, with no
    // answer, no failure, and no way out but the back gesture.
    const noAnswer = setTimeout(() => {
      if (isDone()) return;
      console.warn('[call] no answer within', RING_TIMEOUT_MS / 1000, 's — ending the call');
      hangUp('no_answer', true);
    }, RING_TIMEOUT_MS);
    onDispose(() => clearTimeout(noAnswer));
  } catch (e: any) {
    failSetup(e);
  } finally {
    // ALWAYS release, on success and on failure alike. A claim left standing
    // after a failed setup would silently swallow every retry for that peer.
    release();
    if (setupClaim && setupClaim.key === claimKey(a)) setupClaim = null;
  }
}

/**
 * Answer an incoming call.
 *
 * `offerWire` is OPTIONAL and only a cross-check now. It used to be mandatory
 * because it carried the SDP and later the media key, so answering before it
 * arrived was impossible — which is why the ring screen had a "waiting for the
 * offer" state and a notification answer had to bounce through it. The call is
 * identified by the CHAT: one live call per chat is a database constraint, so
 * bootstrap's openCallSession lands us in the caller's call with nothing else
 * to go on.
 */
export async function acceptIncoming(a: StartArgs & { offerWire?: any }): Promise<void> {
  if (alreadyRunning(a)) return;
  if (!(await claimSetup(a))) return;
  let release!: () => void;
  setupClaim = { key: claimKey(a), done: new Promise<void>(r => { release = r; }) };
  try {
    if (alreadyRunning(a)) return;
    const tag = offerTag(a.offerWire);
    const { s } = await bootstrap(a, 'incoming');
    callStage(tag, 'incoming', `${a.kind} call`);

    // The ring names a call, but the SERVER decides which one we join: one live
    // call per chat is a database constraint (a unique partial index), so
    // opening the session in bootstrap already put us in the caller's call.
    // The id in the ring is therefore a cross-check, not an instruction — and
    // if it disagrees, the server is right.
    const named = String((a.offerWire as any)?.callId ?? '');
    if (named && named !== s.serverCallId) {
      console.warn('[call] ring named', named.slice(0, 8), 'but the server put us in', s.serverCallId.slice(0, 8));
    }
    callStage(tag, 'ring_opened', `call=${s.serverCallId.slice(0, 8)}`);

    await join(s);
  } catch (e: any) {
    failSetup(e);
  } finally {
    // ALWAYS release, on success and on failure alike. A claim left standing
    // after a failed setup would silently swallow every retry for that peer.
    release();
    if (setupClaim && setupClaim.key === claimKey(a)) setupClaim = null;
  }
}

export interface StartGroupArgs {
  chatId: string;
  groupName: string;
  kind: CallKind;
  /** Members to ring. Empty when joining a call already in progress. */
  ring?: string[];
}

/**
 * Start or join a group call.
 *
 * The room is the same mechanism as 1:1 — there is no separate group path any
 * more. What differs is only who gets rung and that nobody is "the" peer.
 */
export async function startGroup(a: StartGroupArgs): Promise<void> {
  // Same duplicate-start guard as the 1:1 entry points: the group screen's
  // effect is keyed on route params too, and a re-run used to tear down the
  // call it had just started.
  if (alreadyRunning({ chatId: a.chatId, peerUid: '' })) return;
  try {
    const { s } = await bootstrap(
      { chatId: a.chatId, peerUid: '', peerName: a.groupName, kind: a.kind }, 'outgoing',
    );
    await join(s);
    // RING ONLY IF WE OPENED THE CALL.
    //
    // The hub hands over the roster whenever it starts a call, and it cannot
    // tell whether one is already running — the server settles that. Ringing
    // unconditionally meant the 40th person to join a live call re-rang all 63
    // members, waking every phone already in the room and every one that had
    // already declined. At small sizes that was a nuisance; at 64 it is a
    // notification storm on every join.
    if (a.ring?.length && s.createdCall) {
      await ringTheGroup(s, undefined, a.ring);
    }
  } catch (e: any) {
    failSetup(e);
  }
}

function failSetup(e: any): void {
  dispatch({ type: 'error', message: e?.message ?? 'Call failed' });
  hangUp('setup_error', true);
}

// ── in-call chat + reactions ──────────────────────────────────────────
//
// Both ride the per-call cipher from the ring envelope, so the side channel is
// encrypted by exactly the mechanism the key was.

let chatSeq = 0;
const nextId = (): string => `${Date.now().toString(36)}-${(chatSeq++).toString(36)}`;

const chatMessage = (uid: string, name: string, text: string, mine: boolean): CallChatMessage =>
  ({ id: nextId(), uid, name, text, at: Date.now(), mine });

function peerNameOf(s: Session, uid: string): string {
  return getSnapshot().participants[uid]?.name || (uid === s.peerUid ? s.peerName : '') || 'Participant';
}

/**
 * In-call chat and reactions ride the PAIRWISE RATCHET — the same channel the
 * chat itself uses, one wrap per message.
 *
 * They used to ride a per-call cipher derived from the ring envelope. That
 * envelope is gone (the ring carries nothing secret now), and text is exactly
 * the kind of content that should not lose its end-to-end guarantee because the
 * MEDIA gave one up. Volume is a handful of messages per call, so the "never
 * ratchet per frame" rule that governs media does not apply here.
 */
async function sealForPeer(uid: string, body: string): Promise<any> {
  const e2ee = await import('../../services/crypto/e2eeSession.rn');
  return e2ee.e2eeEncrypt('', uid, body);
}

function openFromPeer(from: string, sealed: any, use: (text: string) => void): void {
  void (async () => {
    try {
      const e2ee = await import('../../services/crypto/e2eeSession.rn');
      const text = await e2ee.e2eeDecrypt('', from, 0, sealed);
      if (typeof text === 'string' && text) use(text);
    } catch { /* not for us, or a stale session — drop it rather than show noise */ }
  })();
}

/**
 * Seal once PER RECIPIENT and send. N envelopes, not one broadcast.
 *
 * THIS IS THE E2EE DECISION, MADE EXPLICIT. In-call text rides the pairwise
 * ratchet — the same channel the chat thread uses — so the server relays
 * ciphertext it cannot read. A group of 64 therefore costs 63 ratchet wraps per
 * message, and that is the price of the guarantee, deliberately paid: volume is
 * a handful of messages per call, so the "never ratchet per frame" rule that
 * governs MEDIA does not apply. The cheap alternative — one plaintext emit the
 * server fans out — was rejected: media gave up end-to-end encryption for
 * reasons that do not apply to text, and text is exactly the content that
 * should not lose the guarantee because the video did.
 *
 * allSettled, not all: one peer with no E2EE session yet must not silence the
 * message for the other 62. Each recipient succeeds or fails alone.
 */
async function sealAndFanOut(
  s: Session, body: string, send: (to: string, sealed: any) => Promise<void>,
): Promise<void> {
  const targets = chatRecipients(s.peerUid, s.meId, Object.keys(getSnapshot().participants));
  if (!targets.length) return;
  await Promise.allSettled(targets.map(async to => {
    const sealed = await sealForPeer(to, body);
    await send(to, sealed);
  }));
}

export function sendChat(text: string): void {
  const s = session;
  const body = String(text ?? '').trim().slice(0, 500);
  // NO `!s.peerUid` GUARD. It used to be here, and because a group session's
  // peerUid is empty by construction, it made in-call chat and reactions
  // silently INERT in every group call — the UI accepted a message, echoed it
  // locally, and sent it nowhere.
  if (!s || s.disposed || !body) return;
  void sealAndFanOut(s, body, (to, sealed) => signal.sendCallChat(to, s.chatId, sealed)).catch(() => {});
  dispatch({ type: 'chat', message: chatMessage(s.meId, s.meName, body, true) });
}

export function sendReaction(emoji: string): void {
  const s = session;
  const body = String(emoji ?? '').slice(0, 8);
  if (!s || s.disposed || !body) return;
  void sealAndFanOut(s, body, (to, sealed) => signal.sendCallEmoji(to, s.chatId, sealed)).catch(() => {});
  dispatch({ type: 'reaction', reaction: { id: nextId(), uid: s.meId, emoji: body, at: Date.now() } });
}

export function markChatRead(): void { dispatch({ type: 'chat_read' }); }

/**
 * Ring more people into the call that is already running — the invite.
 *
 * A group call rings once, when it opens. Everyone who was asleep, on another
 * call, or not yet in the chat is then unreachable for the rest of it, and the
 * only way back in was for someone to hang up and start again — which rings all
 * 63 a second time. At 64 seats that gap is the difference between a call that
 * can fill up and one that cannot.
 *
 * Rings ONLY the uids given, and only while a group call is live: an invite is
 * a deliberate act aimed at named people, not a re-broadcast. Returns how many
 * were rung so the caller can say so.
 */
export async function inviteToCall(uids: string[]): Promise<number> {
  const s = session;
  // 1:1 IS ALLOWED NOW. This used to return early on s.peerUid, which meant a
  // two-person call had no way to become a three-person one — the "add person"
  // every other messenger has simply did not exist here. The server grants an
  // invite scoped to this one call (migration 123 call_invites), so the person
  // added never joins the chat, only the call.
  if (!s || s.disposed) return 0;
  const live = getSnapshot().participants;
  // Never ring someone already here. Their phone would ring while they are
  // looking at the call it is ringing about.
  const targets = uids.filter(u => u && u !== s.meId && !live[u]);
  if (!targets.length) return 0;
  await ringTheGroup(s, targets, targets);
  return targets.length;
}

/**
 * Ring, preferring the server fan-out and falling back to the socket loop.
 *
 * The server path is not an optimisation — it is the only one that sends a
 * WAKE-UP PUSH, and without a push a group call reaches only the phones that
 * are already awake. The loop is kept solely because deploys here are file copy:
 * a build can reach a device before the binary reaches prod, and ringing badly
 * beats not ringing at all.
 *
 * `fallback` is the uid list the loop needs; the server needs only the call id
 * (and, for an invite, who to narrow to).
 */
async function ringTheGroup(s: Session, only: string[] | undefined, fallback: string[]): Promise<void> {
  const rang = await ringCallGroup(s.serverCallId, only);
  if (rang !== null) return;
  await signal.ringPeers(fallback, s.meId, s.chatId, s.peerName || '', s.kind === 'video');
}

/**
 * Declare whose video the screen is actually showing.
 *
 * `null` means everyone, which is the state a call starts in and the state
 * every screen that never calls this leaves it in — so this is additive and no
 * existing call path changes behaviour by its presence.
 *
 * Safe before the room exists: the grid mounts and pages before the SFU
 * connection is up, and a dropped declaration would otherwise leave the call
 * subscribed to everything until the next page turn. The room re-reads nothing
 * on join, so the screen re-declares on connect (see group-call-active).
 */
export function setVisibleParticipants(ids: string[] | null): void {
  try { session?.room?.setVisible(ids); } catch {}
}

// ── roles and hands ───────────────────────────────────────────────────

export async function raiseHand(up: boolean): Promise<void> {
  const s = session;
  if (!s?.serverCallId) return;
  dispatch({ type: 'hand', uid: s.meId, at: up ? Date.now() : 0 });
  await setHandRaised(s.serverCallId, up).catch(() => {});
}

export async function lowerPeerHand(uid: string): Promise<void> {
  const s = session;
  if (!s?.serverCallId) return;
  dispatch({ type: 'hand', uid, at: 0 });
  await setHandRaised(s.serverCallId, false, uid).catch(() => {});
}

export async function setRole(uid: string, role: CallRole): Promise<boolean> {
  const s = session;
  if (!s?.serverCallId) return false;
  const ok = await setCallRole(s.serverCallId, uid, role);
  if (ok) dispatch({ type: 'role', uid, role });
  return ok;
}

// ── connected-state side effects ──────────────────────────────────────

let foregrounded = false;

function startCallForegroundService(s: Session): void {
  if (foregrounded) return;
  foregrounded = true;
  nativeCall.startCallSession({
    callId: String(s.chatId || s.peerUid || 'call'),
    peerName: s.peerName || 'crazzychat user',
    isVideo: s.kind === 'video',
  });
}

export function onConnected(): void {
  const s = session;
  if (!s) return;
  startCallForegroundService(s);
  nativeCall.dismissIncomingUi();
}

// ── controls ──────────────────────────────────────────────────────────
//
// Every one of these goes through the SDK, which is the only thing that knows
// what is actually being published. The old engine toggled `enabled` on tracks
// it had captured itself, which is how a muted call could still be heard after
// a reconnect replaced the sender underneath it.

function setFlag(key: CallFlag, value: boolean): void { dispatch({ type: 'flag', key, value }); }

export function toggleMute(): void {
  const s = session; if (!s?.room) return;
  const next = !getSnapshot().muted;
  void s.room.setMic(!next).catch(() => {});
  setFlag('muted', next);
}

export function toggleSpeaker(): void {
  const next = !getSnapshot().speaker;
  media.setSpeaker(next);
  setFlag('speaker', next);
}

export function toggleCamera(): void {
  const s = session; if (!s?.room) return;
  const next = !getSnapshot().cameraOff;
  void s.room.setCamera(!next).catch(() => {});
  setFlag('cameraOff', next);
}

export function flipCamera(): void {
  void session?.room?.flipCamera().catch(() => {});
}

/**
 * Share the screen. The SDK publishes it as its own track, so the camera keeps
 * running underneath and comes back untouched when the share stops.
 *
 * FLAG_SECURE has to come off for the duration: app/_layout.tsx sets it at boot,
 * and it blocks MediaProjection as well as screenshots — so the share was black
 * frames for everything crazzychat drew. It is re-asserted on every exit path,
 * including a call that dies mid-share (see dispose).
 */
/**
 * The window's own FLAG_SECURE, bypassing the keyed screen-capture API.
 * Returns quietly on a build without the native module — the call still works,
 * the share simply will not capture, which the stats line makes obvious.
 */
/** Add the mediaProjection foreground-service type to the live call. */
async function allowScreenCapture(): Promise<void> {
  try {
    const { NativeModules } = require('react-native');
    await NativeModules?.VaultCalls?.allowScreenCapture?.();
  } catch { /* older build — the share will simply not capture */ }
}

async function windowSecure(secure: boolean): Promise<void> {
  try {
    const { NativeModules } = require('react-native');
    await NativeModules?.VaultCalls?.setWindowSecure?.(secure);
  } catch { /* older build: nothing to toggle */ }
}

export async function startScreenShare(): Promise<void> {
  const s = session;
  if (!s?.room) throw new Error('No active call.');
  // FLAG_SECURE STAYS ON. crazzychat is never made capturable.
  //
  // Android excludes a SECURE window from the capture and captures everything
  // else normally, which is exactly the product requirement: crazzychat's own
  // content stays protected while Chrome, Maps, a gallery or a game share
  // fine. The user starts the share and switches away; what they switch to is
  // what the other side sees.
  //
  // This previously cleared the flag — first through expo-screen-capture, then
  // natively — on the theory that a secure window produced no frames at all.
  // That is the wrong trade even if it worked: it would make the app's own
  // messages capturable for the duration of every share. The flag is left
  // alone, and the capture is measured instead (see the stats loop in
  // room.ts): frames appear as soon as something capturable is on screen.
  // The call's foreground service must carry the mediaProjection type before
  // Android will let anything capture. Asked for twice on purpose: now (which
  // is what Android 10-13 require) and again once consent has been granted
  // (which is the only moment 14+ permits it). Both are no-ops if already set.
  await allowScreenCapture();
  console.warn('[call] screen share: starting');
  try {
    await s.room.setScreenShare(true);
  } catch (e) {
    await setSecure(true).catch(() => {});
    throw e;
  }
  await allowScreenCapture();
  console.warn('[call] screen share: published');
  setFlag('sharing', true);
  if (s.peerUid) signal.sendScreenShare(s.peerUid, s.chatId, true).catch(() => {});
}

export async function stopScreenShare(): Promise<void> {
  // Nothing to restore: the flag was never lowered. Kept as a belt-and-braces
  // re-assert in case an older build left it cleared.
  await setSecure(true).catch(() => {});
  await windowSecure(true);
  const s = session;
  if (!s?.room) return;
  await s.room.setScreenShare(false).catch(() => {});
  setFlag('sharing', false);
  if (s.peerUid) signal.sendScreenShare(s.peerUid, s.chatId, false).catch(() => {});
}

// ── call waiting ──────────────────────────────────────────────────────
// Registers with lib/callState so an incoming call arriving mid-call can offer
// "Hold & accept" instead of clobbering this one.

function registerForCallWaiting(a: StartArgs): void {
  const me: ActiveCall = {
    chatId: a.chatId, peerUid: a.peerUid, peerName: a.peerName || 'crazzychat user',
    kind: a.kind,
    hold: () => {
      const s = session; if (!s?.room) return;
      void s.room.setMic(false);
      if (a.kind === 'video') void s.room.setCamera(false);
      // Muting what we SEND is not enough: the person on hold must also stop
      // being audible in the room we are stepping away from.
      s.room.setRemoteAudible(false);
      setFlag('held', true);
    },
    resume: () => {
      const s = session; if (!s?.room) return;
      const snap = getSnapshot();
      void s.room.setMic(!snap.muted);
      if (a.kind === 'video') void s.room.setCamera(!snap.cameraOff);
      s.room.setRemoteAudible(true);
      setFlag('held', false);
    },
    hangUp: () => hangUp('local_hangup', true),
  };
  setActiveCall(me);
  onDispose(() => { clearActiveCall(me); foregrounded = false; });
}

export default {};
