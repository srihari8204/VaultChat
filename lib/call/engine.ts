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
//   KEY         nothing. Calls are encrypted in transit (TLS + DTLS-SRTP) and
//               not end to end — owner decision 2026-08-16, see lib/call/room.ts
//   STATE       the pure machine in ./machine, fed from SDK events
//   OS          the foreground service, the ring notification, the call log
//
// DISPOSAL is the other reason this exists: every acquired resource registers a
// teardown, and dispose() runs them once, in reverse order, on every exit path.

import { getCachedUser } from '../api';
import { CALL_SESSIONS } from '../../constants/flags';
import { leaveCallSession, openCallSession, setCallRole, setHandRaised, type CallRole } from '../callSession';
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

// ── lifecycle ─────────────────────────────────────────────────────────

/** End the call. Idempotent — safe from any path, at any time. */
export function hangUp(reason: EndReason = 'local_hangup', notifyPeer = true): void {
  const s = session;
  if (!s) return;
  const snap = getSnapshot();

  if (!s.logged) {
    s.logged = true;
    const durationSec = durationSeconds(snap, Date.now());
    const direction = snap.direction === 'incoming'
      ? (wasMissed(snap) ? 'missed' : 'incoming')
      : 'outgoing';
    addCallLog({
      chatId: s.chatId, peerUid: s.peerUid, peerName: s.peerName || 'VaultChat user',
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
    ...a, meId: '', meName: '', serverCallId: '', room: null,
    disposers: [], logged: false, disposed: false,
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
  dispatch({
    type: 'session', sessionId: res.call.id,
    myRole: res.participants?.find(p => p.userId === s.meId)?.role,
  });
  for (const p of res.participants ?? []) {
    if (p.userId === s.meId || p.leftAt) continue;
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
    accept: (from) => (s.peerUid ? from === s.peerUid : true),
    currentCallId: () => s.serverCallId,
    // No SDP crosses the wire any more. These three exist on the listener
    // interface for the group-mesh era and are deliberately inert.
    onOffer: () => {},
    onAnswer: () => {},
    onIce: () => {},
    onEnd: () => hangUp('remote_hangup', false),
    onPeerScreenShare: (_from, on) => dispatch({ type: 'flag', key: 'peerSharing', value: on }),
    onMediaKey: () => {},
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

async function join(s: Session): Promise<void> {
  // Per-participant video sources, so a screen share and a camera can coexist.
  const cams = new Map<string, string>();
  const screens = new Map<string, string>();
  let aloneTimer: ReturnType<typeof setTimeout> | null = null;
  onDispose(() => { if (aloneTimer) clearTimeout(aloneTimer); });
  const { getSfuToken } = await import('./sfuToken');
  const cred = await getSfuToken(s.serverCallId);
  if (s.disposed) return;

  const room = await joinCallRoom({
    url: cred.url,
    token: cred.token,
    video: s.kind === 'video',
    publish: cred.role !== 'audience',
    events: {
      onParticipants: (count, joined, left) => {
        if (left) {
          dispatch({ type: 'peer_left', uid: left.identity });
          // 1:1: the other side leaving the room IS the end of the call.
          if (s.peerUid) { hangUp('remote_hangup', false); return; }
        }
        if (joined) dispatch({ type: 'role', uid: joined.identity, role: 'speaker' });

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
        if (kind === 'video' && s.peerUid === uid) {
          dispatch({ type: 'flag', key: 'peerSharing', value: screens.has(uid) });
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
  callStage(s.serverCallId.slice(0, 8) || '--------', 'room_joined',
    `${s.kind} role=${cred.role}`);
}

/** Place a call. Rejects only on setup failure; the call is torn down first. */
export async function startOutgoing(a: StartArgs): Promise<void> {
  if (alreadyRunning(a)) return;
  try {
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
      // lookup when this arrives empty, so sending "VaultChat user" pinned that
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
  try {
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
    if (a.ring?.length) {
      await signal.ringGroup(a.ring, s.meId, a.chatId, a.groupName, a.kind === 'video');
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

export function sendChat(text: string): void {
  const s = session;
  const body = String(text ?? '').trim().slice(0, 500);
  if (!s || s.disposed || !body || !s.peerUid) return;
  void sealForPeer(s.peerUid, body).then(sealed => signal.sendCallChat(s.peerUid, s.chatId, sealed)).catch(() => {});
  dispatch({ type: 'chat', message: chatMessage(s.meId, s.meName, body, true) });
}

export function sendReaction(emoji: string): void {
  const s = session;
  const body = String(emoji ?? '').slice(0, 8);
  if (!s || s.disposed || !body || !s.peerUid) return;
  void sealForPeer(s.peerUid, body).then(sealed => signal.sendCallEmoji(s.peerUid, s.chatId, sealed)).catch(() => {});
  dispatch({ type: 'reaction', reaction: { id: nextId(), uid: s.meId, emoji: body, at: Date.now() } });
}

export function markChatRead(): void { dispatch({ type: 'chat_read' }); }

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
    peerName: s.peerName || 'VaultChat user',
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
 * frames for everything VaultChat drew. It is re-asserted on every exit path,
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
  // FLAG_SECURE STAYS ON. VaultChat is never made capturable.
  //
  // Android excludes a SECURE window from the capture and captures everything
  // else normally, which is exactly the product requirement: VaultChat's own
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
    chatId: a.chatId, peerUid: a.peerUid, peerName: a.peerName || 'VaultChat user',
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
