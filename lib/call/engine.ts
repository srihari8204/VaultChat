// lib/call/engine.ts — the call, owned outside React.
//
// This is the piece that removes the duplication: app/voicecall.tsx,
// app/videocall.tsx and app/group-call-active.tsx each ran their own copy of
// this pipeline. Here it exists once, and 1:1 is simply a mesh with one peer.
//
// It ORCHESTRATES the proven modules rather than reimplementing any of them:
//   lib/callCrypto   E2EE signalling (per-call key, ratchet-wrapped once)
//   lib/iceConfig    cached TURN credentials
//   lib/call/signal  socket wire + the tuned re-send cadences
//   lib/call/media   capture + InCallManager routing
//   lib/call/peer    RTCPeerConnection + ICE buffering + answer idempotence
//   lib/call/native   the ONE platform seam — Android FGS + FCM today,
//                    CallKit + PushKit when iOS lands
//   lib/callLog      on-device history
//   lib/callState    call-waiting hold/resume registration
//
// DISPOSAL is the other reason this exists. Every acquired resource registers a
// teardown here, and dispose() runs them once, in reverse order, on every exit
// path — hangup, remote end, ICE failure, setup error, or replacement. That is
// the fix for the leak class where a crash or a replaced call left a live
// MediaStream holding native camera buffers.

// Identity comes from lib/api, NOT from app/(constants)/authService — that
// module's getCurrentUserAsync is a one-line passthrough to this same function,
// and importing it here would make lib/ depend on app/ (the only such edge in
// the codebase) while authService itself imports back into lib/. Same value,
// no layering inversion, no latent cycle.
import { getCachedUser } from '../api';
import * as perf from '../perf';
import { CALL_SESSIONS } from '../../constants/flags';
import { leaveCallSession, openCallSession, setCallRole, setHandRaised, type CallRole } from '../callSession';
import { addCallLog } from '../callLog';
import { newCallCipher, openCallOffer } from '../callCrypto';
// Screen share has to lift the app-wide FLAG_SECURE for the duration of the
// share; see startScreenShare/stopScreenShare for why, and for the exit paths
// that put it back.
import { setSecure } from '../screenGuard';
// The ONE platform seam (lib/call/native): Android foreground service + FCM
// today, CallKit + PushKit when iOS lands. The engine never branches on
// Platform.OS itself.
import { nativeCall } from './native';
import { clearActiveCall, setActiveCall, type ActiveCall } from '../callState';
import { getIceServers } from '../iceConfig';
import { getLowDataModeCached } from '../callPrefs';
import * as media from './media';
import * as signal from './signal';
import type { WireMode } from './signal';
import { CallPeer } from './peer';
import { durationSeconds, shouldCancelRing, wasMissed, type CallFlag } from './machine';
import { topologyFor } from './mode';
import { attachAudioFocus } from './audioFocus';
import { INITIAL_CURSOR, INITIAL_QUALITY, TIERS, audioBitrate, ceilingFor, nextQuality, sampleFromTotals } from './quality';
import { netKey, shouldRestartIce } from './netChange';
import { dispatch, getSnapshot, begin, reset } from './store';
import { REKEY_WAIT_MS, RING_TIMEOUT_MS } from './types';
import { callFail, callStage, offerTag } from './diag';
import type { CallChatMessage, CallKind, EndReason } from './types';

interface Session {
  chatId: string;
  /** The other party in a 1:1 call; '' for a group call. */
  peerUid: string;
  peerName: string;
  kind: CallKind;
  meId: string;
  /** Our own display name, so our in-call chat lines are attributed. */
  meName: string;
  /**
   * Every remote participant, keyed by uid. A 1:1 call holds exactly one entry
   * — that is the whole point: "1:1 is a mesh with N=1", so there is one code
   * path, not two.
   */
  peers: Map<string, CallPeer>;
  /** Which SDP wire shape this call speaks — see lib/call/signal.ts. */
  wire: WireMode;
  localStream: any;
  screenStream: any;
  cameraTrack: any;          // held during a screen share, for swap-back
  disposers: (() => void)[];
  logged: boolean;
  disposed: boolean;
  /** calls.id once the server session opens, or '' — see openSession(). */
  serverCallId: string;
  /**
   * The call's SHARED media key, used only on the SFU path.
   *
   * Mesh mints a key per PAIR, which is right when every link is its own
   * connection. An SFU forwards one encrypted stream to everyone, so every
   * participant must hold the same key or nobody can decode anybody. It is
   * distributed over the per-peer ratchet channel (signal.sendMediaKey), so the
   * SFU changes the transport without changing the trust model.
   */
  mediaKey: Uint8Array | null;
  /** Live SFU session once this call has switched topology. */
  sfu: { leave(): Promise<void>; crypto: { setKey(k: Uint8Array): Promise<void> } | null } | null;
}

let session: Session | null = null;

// ── disposal ──────────────────────────────────────────────────────────
function onDispose(fn: () => void): void {
  session?.disposers.push(fn);
}

function dispose(): void {
  const s = session;
  if (!s || s.disposed) return;
  s.disposed = true;
  // Reverse order: listeners detach before the objects they reference die.
  for (const fn of s.disposers.reverse()) { try { fn(); } catch {} }
  s.disposers = [];
  media.stopAudioSession();
  nativeCall.endCallSession();
  // Re-arm the capture guard if the call died mid-share (hangup, network loss,
  // peer left). stopScreenShare() is the tidy path and restores it too, but a
  // call can end without ever reaching it — and leaving FLAG_SECURE off would
  // silently disable the app-wide screenshot block for the rest of the session.
  if (s.screenStream) setSecure(true).catch(() => {});
  media.stopStream(s.screenStream);
  media.stopStream(s.localStream);
  for (const p of s.peers.values()) { try { p.close(); } catch {} }
  s.peers.clear();
  s.localStream = null;
  s.screenStream = null;
  s.cameraTrack = null;
}

/** The single remote peer of a 1:1 call, or null. */
function solePeer(s: Session): CallPeer | null {
  return s.peers.size === 1 ? s.peers.values().next().value ?? null : null;
}

const isDone = () => {
  const st = getSnapshot().status;
  return st === 'connected' || st === 'ended' || !!session?.disposed;
};

// RING_TIMEOUT_MS now lives in ./types alongside the ring budget it must
// exceed, so the relationship between them is unit-testable — this module
// imports React Native and cannot be loaded under Node.

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
      // A mesh call has no single peer — the log keys it by chat and redials it
      // as a group call rather than as a 1:1 with an empty uid.
      group: s.wire === 'mesh',
      // Present only when the server session opened. It is what lets this same
      // call be recognised in the synced history instead of appearing twice.
      callId: s.serverCallId || undefined,
    }).catch(() => {});
    // Outgoing call abandoned before it was answered → stop the callee's ring
    // and let it become a "missed call" on their device.
    if (shouldCancelRing(snap) && s.peerUid) {
      nativeCall.cancelRing(s.peerUid, String(s.chatId || s.peerUid)).catch(() => {});
    }
  }

  // serverCallId names WHICH call is ending, so a peer who has already started
  // the next one ignores it. '' when there is no server session, which sendEnd
  // omits — see its header.
  if (notifyPeer && s.peerUid) {
    signal.sendEnd(s.peerUid, s.meId, s.chatId, s.serverCallId).catch(() => {});
  }
  dispatch({ type: 'end', reason });
  dispose();
  session = null;
}

/** Clear the finished snapshot once the screen has popped. */
export function release(): void {
  reset();
}

interface StartArgs {
  chatId: string;
  peerUid: string;
  peerName: string;
  kind: CallKind;
}

/**
 * Build and wire one remote participant. Used once for a 1:1 call and once per
 * roster entry for a mesh, so both get identical ICE buffering, answer
 * idempotence, cipher handling and failure treatment.
 */
function addPeer(s: Session, uid: string, name: string, iceServers: any[]): CallPeer {
  const existing = s.peers.get(uid);
  if (existing) return existing;

  const peer = new CallPeer(uid, iceServers, {
    onLocalCandidate: (sealed) => { signal.sendIce(uid, s.meId, s.chatId, sealed, s.wire).catch(() => {}); },
    onRemoteStream: (url) => { dispatch({ type: 'remote_stream', uid, url, name }); },
    onFailed: () => onPeerFailed(uid),
    onRenegotiate: () => { const p = session?.peers.get(uid); if (p) void renegotiate(p); },
    // Clears "Reconnecting…". Fires on the FIRST connect too, where the
    // reducer's guard makes it a no-op — that is cheaper and less fragile than
    // teaching the peer which connect is which.
    onConnected: () => dispatch({ type: 'recovered' }),
    // After a reconnect, re-attach whatever we are SENDING. The remote view is
    // rebound by the peer itself; this is the other direction, and it is the
    // one that breaks a screen share: its track is backed by MediaProjection
    // through a foreground service, and a renegotiated transport can leave that
    // pointing at a sender the connection no longer owns.
    onReconnected: () => {
      const s2 = session;
      const p = s2?.peers.get(uid);
      if (!s2 || !p) return;
      // The screen track when sharing, else the camera — whichever is live.
      const stream = s2.screenStream ?? s2.localStream;
      const track = stream?.getVideoTracks?.()?.[0];
      if (!track) return;
      void p.rebindVideoTrack(track, stream).then(needsOffer => {
        // remove+add changes the SDP, so the peer must be told. replaceTrack
        // does not, which is why it is tried first.
        if (needsOffer) void renegotiate(p);
      });
    },
  });
  s.peers.set(uid, peer);
  peer.addLocalTracks(s.localStream);
  // Runs for AUDIO calls too. It used to be video-only, which meant low-data
  // mode did nothing on a voice call — the Opus ceiling is applied by this
  // loop, and a voice call is exactly where a data cap matters most. On an
  // audio call the tier pins to 'audioOnly' (no video track to shrink) and the
  // loop only manages the audio bitrate.
  startQualityLoop(peer);
  return peer;
}

// ── in-call chat + reactions ──────────────────────────────────────────
//
// Both ride the per-peer CallCipher the call already established, so the side
// channel is encrypted by exactly the mechanism the SDP is. A mesh seals once
// per link and sends N envelopes; there is no shared group key to leak and no
// plaintext path. A peer on an older build has `plainCipher`, and its seal/open
// are transparent — such a peer simply can't be reached with anything the server
// couldn't already read, which is the honest degradation, not a silent one.

let chatSeq = 0;
const nextId = (): string => `${Date.now().toString(36)}-${(chatSeq++).toString(36)}`;

const chatMessage = (uid: string, name: string, text: string, mine: boolean): CallChatMessage =>
  ({ id: nextId(), uid, name, text, at: Date.now(), mine });

/** Display name for a peer: the roster name, else the 1:1 peer name. */
function peerNameOf(s: Session, uid: string): string {
  return getSnapshot().participants[uid]?.name || (s.wire === 'direct' ? s.peerName : '') || 'Participant';
}

/** Open an envelope from a known peer. Returns undefined for anything else. */
function openFromPeer(s: Session, from: string, sealed: any): any {
  const peer = s.peers.get(from);
  if (!peer) return undefined;
  try { return peer.getCipher().open(sealed); } catch { return undefined; }
}

/** Seal `body` for every peer and hand each envelope to `send`. */
function fanOutSealed(s: Session, body: string, send: (to: string, sealed: any) => Promise<void>): void {
  for (const [uid, peer] of s.peers) {
    try { send(uid, peer.getCipher().seal(body)).catch(() => {}); } catch {}
  }
}

/**
 * Send a line of in-call chat. Trimmed and length-capped here rather than in the
 * UI so every caller gets the same bound, and echoed locally so our own message
 * appears immediately instead of waiting on a round trip that never comes back
 * (the relay excludes the sender).
 */
export function sendChat(text: string): void {
  const s = session;
  const body = String(text ?? '').trim().slice(0, 500);
  if (!s || s.disposed || !body) return;
  fanOutSealed(s, body, (to, sealed) => signal.sendCallChat(to, s.chatId, sealed));
  dispatch({ type: 'chat', message: chatMessage(s.meId, s.meName, body, true) });
}

/** Send a tapped reaction. Same path, same encryption, same local echo. */
export function sendReaction(emoji: string): void {
  const s = session;
  const body = String(emoji ?? '').slice(0, 8);
  if (!s || s.disposed || !body) return;
  fanOutSealed(s, body, (to, sealed) => signal.sendCallEmoji(to, s.chatId, sealed));
  dispatch({ type: 'reaction', reaction: { id: nextId(), uid: s.meId, emoji: body, at: Date.now() } });
}

/** The chat sheet is open — clear the unread badge. */
export function markChatRead(): void {
  dispatch({ type: 'chat_read' });
}

// ── raise hand + moderation (B4) ──────────────────────────────────────
//
// All three need a server session; without one (flag off, unmigrated server,
// failed request) they are no-ops rather than errors. A role is a server fact —
// the whole reason it lives in the database is that a client asserting its own
// role is not a role — so nothing here writes to the snapshot directly. The
// socket event that follows a successful call is what updates every device,
// including this one, which also means the UI can never show a promotion the
// server refused.

/** Raise or lower our own hand. */
export function raiseHand(raised: boolean): void {
  const s = session;
  if (!s || !s.serverCallId) return;
  void setHandRaised(s.serverCallId, raised);
}

/** Lower someone else's hand. Host/cohost only; the server enforces it. */
export function lowerPeerHand(uid: string): void {
  const s = session;
  if (!s || !s.serverCallId || !uid) return;
  void setHandRaised(s.serverCallId, false, uid);
}

/** Promote or demote a participant. Host/cohost only; the server enforces it. */
export function setRole(uid: string, role: CallRole): void {
  const s = session;
  if (!s || !s.serverCallId || !uid) return;
  void setCallRole(s.serverCallId, uid, role);
}

/** Close and forget a participant. Safe to call for an unknown uid. */
function removePeer(s: Session, uid: string): void {
  const peer = s.peers.get(uid);
  if (!peer) return;
  try { peer.close(); } catch {}
  s.peers.delete(uid);
  dispatch({ type: 'peer_left', uid });
}

/**
 * A peer connection died. The right response differs by topology, which is why
 * this was previously wrong in the mesh:
 *
 *   1:1   the call IS that peer — end it, exactly as before.
 *   mesh  drop that participant only. The legacy mesh screen left this branch
 *         EMPTY with the comment "peer-left handles removal", but
 *         call_peer_left only fires when someone deliberately leaves. A phone
 *         that loses signal or is killed never emits it, so the dead peer stayed
 *         in the roster forever as a frozen tile with no audio and no retry.
 *         Removing it here is what actually closes that defect (A1).
 *
 * No automatic re-offer: the server re-announces a peer that genuinely comes
 * back via call_peer_joined, and retrying into a black hole would burn battery
 * and mint TURN allocations for a device that has gone.
 */
/**
 * Send an ICE-restart offer to a peer — the half that was missing.
 *
 * pc.restartIce() only marks the connection as needing renegotiation; the new
 * candidates never reach the other side unless an offer is created AND SENT.
 * Without this, a Wi-Fi→mobile handover logged retries every 4s while no
 * signalling happened at all, and the call died at the grace window.
 *
 * Uses the mesh offer/answer channel because it is the same transport for both
 * topologies — a 1:1 call is a mesh with one peer.
 */
async function renegotiate(peer: CallPeer): Promise<void> {
  const s = session;
  if (!s || s.disposed) return;
  // Say so on screen. Every caller of this function is a transport that broke
  // and is being rebuilt — the grace-window retry loop, the stall watchdog, a
  // NetInfo handover, or a sender rebind — and until now all of it happened
  // behind a UI that still read "connected". A user watching a frozen call
  // with no explanation hangs up long before the 30 s budget is spent, which
  // turned recoveries that WOULD have succeeded into dropped calls.
  //
  // Dispatched here rather than in each caller so there is exactly one place
  // that can forget. The reducer ignores it unless the call was connected.
  dispatch({ type: 'reconnecting' });
  try {
    const offer = await peer.createIceRestartOffer();
    if (!offer) return;                       // not stable / not supported
    console.warn('[call] sending ICE-restart offer to', peer.uid);
    await signal.sendMeshOffer(peer.uid, s.chatId, peer.getCipher().seal(offer));
  } catch (e: any) {
    console.warn('[call] ICE-restart offer failed —', e?.message ?? e);
  }
}

function onPeerFailed(uid: string): void {
  const s = session;
  if (!s || s.disposed) return;

  // Drop the cached ICE/TURN config so the NEXT call fetches fresh credentials.
  //
  // lib/iceConfig caches relay credentials for up to an hour, and its own
  // comment describes invalidating them "for a deliberate retry after a
  // relay-authentication failure" — but nothing ever called it except sign-out.
  // So once credentials went stale (server-side TURN_SECRET rotation, or a
  // clock/expiry edge), every call kept reusing the same dead credentials until
  // the cache aged out on its own. That is indistinguishable from "calls
  // sometimes don't connect", and it never self-healed within the window.
  try { require('../iceConfig').invalidateIceCache(); } catch {}

  if (s.wire === 'direct') { hangUp('failed', true); return; }
  removePeer(s, uid);
}

async function bootstrap(a: StartArgs, direction: 'outgoing' | 'incoming', wire: WireMode = 'direct') {
  // A previous call must be fully gone before a new one acquires the mic.
  if (session) hangUp('replaced', true);

  begin({ ...a, direction });
  session = {
    ...a, meId: '', meName: '', peers: new Map(), wire, localStream: null, screenStream: null,
    cameraTrack: null, disposers: [], logged: false, disposed: false, serverCallId: '',
    mediaKey: null, sfu: null,
  };
  const s = session;

  media.startAudioSession(a.kind);

  const me = await getCachedUser();
  if (!me?.id) throw new Error('Not signed in');
  s.meId = me.id;
  s.meName = me.name ?? me.email ?? 'You';
  dispatch({ type: 'me', uid: me.id });

  const local = await media.acquireLocalMedia(a.kind);
  if (s.disposed) { media.stopStream(local.stream); throw new Error('cancelled'); }
  s.localStream = local.stream;
  dispatch({ type: 'local_stream', url: local.url });

  // The microphone is now live, so the foreground service that legitimises it in
  // the background must exist from this moment — not from `connected`, which can
  // be 35 s away. See startCallForegroundService for what that window cost.
  startCallForegroundService(s);

  const iceServers = await getIceServers();

  // Route by SENDER, not by a fixed peer, so the same attachment serves 1:1 and
  // mesh. For 1:1 only the known peer is accepted; for mesh, anyone the server
  // has put in our call room.
  const detach = await signal.attachCallListeners({
    accept: (from) => (s.wire === 'direct' ? from === a.peerUid : true),
    // Read lazily: the session opens after these listeners attach, and a
    // captured '' would disable the filter for the whole call.
    currentCallId: () => s.serverCallId,
    onOffer: (from, wireSdp) => { void onMeshOffer(from, wireSdp, iceServers); },
    onAnswer: (from, wireSdp) => {
      const peer = s.peers.get(from);
      if (!peer) { console.warn('[call] answer from unknown peer', from); return; }
      const sdp = peer.openAny(wireSdp);
      // open() returns null for a frame this cipher cannot decrypt — the two
      // sides disagree about the per-call key. Without the answer there is no
      // remote description, so every candidate that follows is buffered
      // forever and the call fails with nothing logged.
      if (!sdp) { console.warn('[call] could NOT open answer from', from, '— call key mismatch'); return; }
      peer.applyAnswer(sdp).then(applied => { if (applied) dispatch({ type: 'answer_applied' }); });
    },
    onIce: (from, wireCand) => {
      const peer = s.peers.get(from);
      if (!peer) { console.warn('[call] ICE from unknown peer', from); return; }
      // Hand over the SEALED frame: the peer owns the cipher, so it can hold
      // anything that arrives before the call key is known and retry it.
      peer.addRemoteIce(wireCand).catch(() => {});
    },
    onEnd: (from) => {
      if (s.wire === 'direct') hangUp('remote_hangup', false);
      else removePeer(s, from);
    },
    onPeerScreenShare: (_from, on) => dispatch({ type: 'flag', key: 'peerSharing', value: on }),
    // The minter handed us the call's shared media key. Opened with that peer's
    // call cipher, so a forged one from anybody else simply does not decrypt.
    onMediaKey: (from, sealed) => {
      void (async () => {
        try {
          // Opened with the pairwise ratchet — a forged key from anyone we do
          // not have a session with simply fails to decrypt, and the server
          // that relayed it could not read it either.
          const e2ee = await import('../../services/crypto/e2eeSession.rn');
          const msg = JSON.parse(await e2ee.e2eeDecrypt('', from, 0, sealed));
          if (msg?.v !== 'mk1' || typeof msg.k !== 'string') return;
          const key = new Uint8Array(Buffer.from(msg.k, 'base64'));
          if (key.length !== 32) return;
          // A ROTATION replaces the key we hold; the frameCrypto key ring keeps
          // in-flight frames under the old key decodable through the changeover.
          s.mediaKey = key;
          await s.sfu?.crypto?.setKey(key);
        } catch { /* not for us, or a stale session — keep the current key */ }
      })();
    },
    onChat: (from, sealed) => {
      const text = openFromPeer(s, from, sealed);
      if (typeof text === 'string' && text) {
        dispatch({ type: 'chat', message: chatMessage(from, peerNameOf(s, from), text, false) });
      }
    },
    onReaction: (from, sealed) => {
      const emoji = openFromPeer(s, from, sealed);
      if (typeof emoji === 'string' && emoji) {
        dispatch({ type: 'reaction', reaction: { id: nextId(), uid: from, emoji, at: Date.now() } });
      }
    },
  });
  onDispose(detach);

  // React to a Wi-Fi <-> mobile handover the moment the OS reports it, instead
  // of waiting for WebRTC to notice the old path is dead. That notice can take
  // several seconds, and every one of them is spent out of the 30s recovery
  // budget with no audio. NetInfo fires as soon as the interface changes, so
  // the fresh candidate gather starts while the new network is coming up.
  //
  // Only a CHANGE of transport/reachability matters — NetInfo also emits on
  // signal-strength wobble, and restarting ICE on those would churn a perfectly
  // healthy call.
  try {
    const NetInfo = require('@react-native-community/netinfo').default;
    let lastKey = '';
    const unsub = NetInfo.addEventListener((st: any) => {
      const key = netKey(st);
      if (key === lastKey) return;
      const prev = lastKey;
      lastKey = key;                           // advance even when we skip, so
                                               // the NEXT event is a change
      if (!prev) return;                       // first callback = current state
      if (!session || session.disposed) return;
      console.warn('[call] network changed', prev, '->', key);

      // Do NOT restart onto a network that is gone.
      //
      // A handover arrives as TWO events: `wifi:true -> none:false`, then
      // `none:false -> cellular:true` a few seconds later. Restarting on the
      // first one gathers candidates with no interface to gather from and
      // sends an offer with no path to deliver it, so the offer goes
      // unanswered and the real restart — the one onto cellular — has to roll
      // it back before it can proceed. Captured on device at 12:28:13:
      //
      //   network changed wifi:true -> none:false
      //   sending ICE-restart offer            <- wasted, nothing to send it on
      //   network changed none:false -> cellular:true
      //   rolled back an unanswered offer      <- cleaning up the wasted one
      //
      // Skipping the dead-network event removes the wasted offer and the
      // rollback it forces. Recovery is NOT delayed: the restart still fires
      // the instant a usable network appears, which is the earliest moment it
      // could have succeeded anyway.
      //
      // Deliberately not a blanket debounce. A timer that swallowed restarts
      // within N seconds of the last one would have swallowed the cellular
      // restart above — the one that actually reconnected the call.
      if (!shouldRestartIce(prev, st)) {
        console.warn('[call] no network yet — deferring ICE restart until one appears');
        return;
      }
      for (const p of session.peers.values()) { p.onNetworkChanged(); void renegotiate(p); }
    });
    onDispose(() => { try { unsub(); } catch {} });
  } catch { /* NetInfo unavailable — the grace-window retries still cover it */ }

  // ── audio focus: a carrier call must not corrupt this one ─────────────
  //
  // The OS mutes us; we mute the MICROPHONE too. Without that the peer keeps
  // hearing the room — and whatever the user says to the other caller — for the
  // whole interruption. `autoMuted` remembers that WE did it, so a user who was
  // already muted before the interruption is not silently unmuted afterwards.
  {
    let autoMuted = false;
    const detach = attachAudioFocus((state) => {
      const cur = session;
      if (!cur || cur.disposed || !cur.localStream) return;
      if (state === 'interrupted' || state === 'lost') {
        if (getSnapshot().muted) return;               // their choice already
        media.setMicEnabled(cur.localStream, false);
        autoMuted = true;
        dispatch({ type: 'flag', key: 'muted', value: true });
        console.warn('[call] audio focus lost — mic muted for the interruption');
      } else if (state === 'resumed' && autoMuted) {
        autoMuted = false;
        media.setMicEnabled(cur.localStream, true);
        dispatch({ type: 'flag', key: 'muted', value: false });
        console.warn('[call] audio focus regained — mic restored');
      }
    });
    onDispose(detach);
  }

  // ── background: keep the audio, drop the video ────────────────────────
  //
  // Nothing stopped the camera when the app left the foreground, so a video
  // call backgrounded in a pocket kept encoding and uploading frames nobody
  // could see — the single largest avoidable drain on a long call, and pure
  // waste of the user's data.
  //
  // Only 'background' is acted on, never 'inactive': iOS reports 'inactive'
  // for transient things like the notification shade, and toggling the camera
  // on those would flicker the peer's view for no reason.
  //
  // The user's OWN camera choice is authoritative. If they turned video off
  // themselves, there is nothing to suspend; and on return we restore only
  // what WE suspended, so backgrounding never silently switches someone's
  // camera back on. Screen share is exempt — sharing while using another app
  // is the entire point of it.
  try {
    const { AppState } = require('react-native');
    let suspended = false;
    const sub = AppState.addEventListener('change', (st: string) => {
      const cur = session;
      if (!cur || cur.disposed || !cur.localStream) return;
      if (st === 'background') {
        const snap = getSnapshot();
        if (suspended || snap.cameraOff || snap.sharing) return;
        media.setCameraEnabled(cur.localStream, false);
        suspended = true;
        console.warn('[call] backgrounded — video off, audio continues');
      } else if (st === 'active' && suspended) {
        suspended = false;
        if (!getSnapshot().cameraOff) {
          media.setCameraEnabled(cur.localStream, true);
          console.warn('[call] foregrounded — video restored');
        }
      }
    });
    onDispose(() => { try { sub?.remove?.(); } catch {} });
  } catch { /* AppState unavailable — the call still works, it just keeps encoding */ }

  if (s.wire === 'direct') addPeer(s, a.peerUid, a.peerName, iceServers);

  registerForCallWaiting(a, me.name ?? me.email ?? '');
  openSession(s);
  const peer = solePeer(s) as CallPeer;
  return { s, peer, me, iceServers };
}

/**
 * Open the server-side call record (B2 / migration 066), off the critical path.
 *
 * NOT awaited, deliberately. Media is peer-to-peer and signalling is a socket;
 * neither needs the REST API's permission to exist, so making call setup wait on
 * a round trip would add latency to every call in exchange for bookkeeping. A
 * failure — unmigrated server, offline, 403 — leaves `serverCallId` null and the
 * call proceeds exactly as it did before any of this existed.
 *
 * The late arrival is safe because the only reader is hangUp(), which runs at
 * minimum a ring cycle later; and if the id somehow has not landed by then, the
 * call is simply logged without one, which is the pre-existing behaviour.
 */
function openSession(s: Session): void {
  if (!CALL_SESSIONS) return;
  void openCallSession(s.chatId, s.kind, 'meeting')
    .then(res => {
      if (!res?.call?.id || s.disposed) return;
      s.serverCallId = res.call.id;
      const me = res.participants?.find(p => p.userId === s.meId);
      dispatch({ type: 'session', sessionId: res.call.id, myRole: me?.role });
      // Seed the roster's roles and hands. Someone already on the call may have
      // a hand up from before we joined, and without this it would only appear
      // if they happened to lower and raise it again.
      for (const p of res.participants ?? []) {
        if (p.userId === s.meId || p.leftAt) continue;
        dispatch({ type: 'role', uid: p.userId, role: p.role });
        dispatch({ type: 'hand', uid: p.userId, at: p.handRaisedAt ? Date.parse(p.handRaisedAt) || 0 : 0 });
      }
    })
    .catch(() => {});

  void signal.attachSessionListeners({
    chatId: s.chatId,
    currentCallId: () => s.serverCallId,
    onRole: (uid, role) => dispatch({ type: 'role', uid, role: role as any }),
    onHand: (uid, raised) => dispatch({ type: 'hand', uid, at: raised ? Date.now() : 0 }),
    // A host ending the session ends the call on every device. Notify no peer:
    // everyone got this same event, so a webrtc_end each would be N redundant
    // messages saying what the server already said.
    onEnded: () => hangUp('remote_hangup', false),
  }).then(off => { if (s.disposed) off(); else onDispose(off); }).catch(() => {});

  // Leaving is registered as a DISPOSER rather than called from hangUp, so it
  // covers every exit path there is — hangup, remote end, ICE failure, setup
  // error, replacement — instead of only the one anybody remembered. It reads
  // serverCallId at teardown time, which is what makes it correct even though
  // the id arrives asynchronously above.
  //
  // The server ends a call when its last participant leaves, so this is also
  // what closes the row when everyone hangs up; nobody has to be the one who
  // "ends" it. Not awaited: teardown must not wait on the network.
  onDispose(() => { if (s.serverCallId) void leaveCallSession(s.serverCallId); });
}

/**
 * A mesh peer offered us a connection. Only reachable in mesh mode — a 1:1
 * callee receives its offer as a route param, not over the socket.
 */
async function onMeshOffer(from: string, wireSdp: any, iceServers: any[]): Promise<void> {
  const s = session;
  if (!s || s.disposed || !from) return;

  // A RE-OFFER for a peer we already have is an ICE restart from the other side
  // (they changed network). Answer it in place — do NOT tear the peer down and
  // rebuild, which would drop the media tracks and the E2EE call cipher.
  //
  // This path also had to stop rejecting non-mesh calls: the guard used to be
  // `s.wire !== 'mesh' -> return`, so a 1:1 call silently ignored every
  // re-offer. That is half of why a handover could never recover — one side
  // was sending nothing, and the other would have discarded it anyway.
  // A re-offer is only possible on a peer that has ALREADY negotiated once.
  //
  // For a 1:1 call bootstrap() calls addPeer() up front, so `s.peers.get(from)`
  // is non-null before the FIRST offer even arrives. Treating that as a
  // renegotiation hijacked normal call setup — observed on device as
  // "answered ICE-restart offer" 12ms after `connecting`, then `failed`.
  // hasNegotiated is the real signal: it flips only once a remote description
  // has been applied.
  const existing = s.peers.get(from);
  if (existing?.hasNegotiated) {
    try {
      // Open with the CALL cipher we already hold — never openCallOffer().
      //
      // renegotiate() seals a re-offer with that cipher, producing a `sig1f`
      // frame. openCallOffer only understands the `sig1` ratchet envelope used
      // to START a call, so a `sig1f` fell through to its legacy-plaintext path
      // and returned `passthrough` — and `setCipher(passthrough)` then DESTROYED
      // the live call cipher. After that nothing sealed could ever be opened
      // again: every remote ICE candidate failed, was queued, and re-queued.
      // On device that was a handover stuck in a loop, "re-opening 12 early
      // candidates" every 4s while the call sat silent until it timed out.
      //
      // The call key does not change across an ICE restart, so there is nothing
      // to re-derive here. A legacy peer's plaintext re-offer still passes
      // through open() untouched.
      const offer = existing.openAny(wireSdp);
      if (!offer?.type) {
        // A `sig1` envelope here is the RING LOOP repeating its original offer
        // at a peer that has already answered — expected, and correctly ignored.
        // It was being logged as "could NOT open re-offer", which reads as a
        // fault during exactly the window where real faults matter; a genuine
        // re-offer is always a `sig1f` frame.
        if ((wireSdp as any)?.v !== 'sig1') {
          console.warn('[call] could NOT open re-offer from', from, '— dropping');
        }
        return;
      }
      // The 1:1 ring loop re-sends the SAME offer every ~3s until answered.
      // Re-applying one of those would tear down a working connection, so only
      // a genuinely different SDP (fresh ice-ufrag = real ICE restart) is
      // treated as a renegotiation.
      if (!existing.isNewOffer(offer)) return;
      const answer = await existing.applyReoffer(offer);
      if (!answer) return;
      console.warn('[call] answered ICE-restart offer from', from);
      await signal.sendMeshAnswer(from, s.chatId, existing.getCipher().seal(answer));
    } catch (e: any) {
      console.warn('[call] could not handle re-offer from', from, '—', e?.message ?? e);
    }
    return;
  }

  // A NEW participant only makes sense in a mesh; a 1:1 call has its one peer.
  if (s.wire !== 'mesh') return;
  const peer = addPeer(s, from, '', iceServers);
  try {
    // Either an encrypted sig1 envelope or a raw SDP from a legacy peer;
    // openCallOffer handles both, so a mesh of mixed builds still connects.
    const { cipher, offer } = await openCallOffer(from, wireSdp);
    peer.setCipher(cipher);
    if (!offer?.type) { removePeer(s, from); return; }
    const answer = await peer.answer(offer);
    await signal.sendMeshAnswer(from, s.chatId, cipher.seal(answer));
  } catch {
    removePeer(s, from);
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
 * Join (or start) a group call on the mesh.
 *
 * Glare is resolved the way the legacy screen did it and the way both sides must
 * agree on: the SMALLER uid sends the offer. Without a deterministic rule both
 * peers offer simultaneously and neither connects.
 */
export async function startGroup(a: StartGroupArgs): Promise<void> {
  try {
    const { s, iceServers } = await bootstrap(
      { chatId: a.chatId, peerUid: '', peerName: a.groupName, kind: a.kind },
      'outgoing', 'mesh',
    );

    const connectTo = (uid: string) => {
      if (!uid || uid === s.meId || s.peers.has(uid)) return;
      const peer = addPeer(s, uid, '', iceServers);
      if (s.meId >= uid) return;                       // the other side offers
      void (async () => {
        try {
          const offer = await peer.createOffer(a.kind === 'video');
          const sealed = await newCallCipher(uid, offer);
          if (sealed) peer.setCipher(sealed.cipher);
          await signal.sendMeshOffer(uid, s.chatId, sealed ? sealed.offerWire : offer);
        } catch { removePeer(s, uid); }
      })();
    };

    // ── mesh vs SFU ───────────────────────────────────────────────────
    //
    // topologyFor() has existed since the SFU spike and NOTHING consulted it:
    // every group call ran on the mesh regardless of size, and MESH_MAX was
    // enforced nowhere in the client. A 6-person call therefore attempted 5
    // peer connections and 5 outbound encodes per phone — the exact load the
    // cap exists to prevent, on the mid-range devices least able to absorb it.
    //
    // The count includes us, which is why it is peers + 1: MESH_MAX is a
    // ceiling on PARTICIPANTS, not on connections.
    const meshFull = (peerCount: number) => topologyFor({ participants: peerCount + 1 }) !== 'mesh';

    let switched = false;
    const switchToSfu = async (peerCount: number) => {
      if (switched || s.disposed) return;
      switched = true;
      try {
        // BEFORE teardown — distribution needs the peer ciphers that die with
        // the mesh connections.
        await establishMediaKey(s);
        // Give a non-minting participant a moment for the key to arrive; the
        // alternative is joining unencrypted, which must never happen silently.
        for (let i = 0; i < 20 && !s.mediaKey && !s.disposed; i++) {
          await new Promise(r => setTimeout(r, 150));
        }
        // Everything mesh-side goes now: N-1 encodes running alongside the SFU
        // publish is worse than either alone, and on a phone it is what turns
        // "the call got big" into "the call died".
        for (const uid of Array.from(s.peers.keys())) removePeer(s, uid);
        await joinViaSfu(s, a.kind === 'video');
      } catch (e: any) {
        // Degrade rather than drop: mode.ts already treats an unavailable SFU
        // as a reason to stay on mesh, and a call that keeps working badly beats
        // one that ends.
        switched = false;
        console.warn('[call] SFU unavailable, staying on mesh —', e?.message ?? e);
        dispatch({ type: 'error', message: 'Large call quality may be reduced.' });
      }
    };

    const leaveRoom = await signal.joinCallRoom({
      chatId: a.chatId,
      onRoster: (peers) => {
        if (meshFull(peers.length)) { void switchToSfu(peers.length); return; }
        peers.forEach(connectTo);
      },
      onJoined: (uid) => {
        if (switched) return;                          // the SFU owns the media now
        if (meshFull(s.peers.size + 1)) { void switchToSfu(s.peers.size + 1); return; }
        connectTo(uid);
      },
      onLeft: (uid) => {
        removePeer(s, uid);
        // Forward secrecy: someone who left must not be able to decrypt what
        // the SFU keeps forwarding. On the mesh this is automatic — their link
        // is gone — but the SFU has no idea who can read the ciphertext it
        // relays, so only a re-key actually removes them.
        void rotateMediaKeyAfterLeave(s);
      },
      onFull:   (max) => {
        // Server refused the join — the mesh is at capacity. Surface it and end
        // cleanly rather than sitting on a screen that never receives a roster.
        dispatch({ type: 'error', message: `This call is full (up to ${max} people).` });
        hangUp('setup_error', false);
      },
    });
    onDispose(leaveRoom);

    if (a.ring?.length) {
      await signal.ringGroup(a.ring, s.meId, a.chatId, a.groupName, a.kind === 'video');
    }
    // A group call has no single ringing peer, so it goes straight to
    // connecting; the first remote track flips it to connected.
  } catch (e: any) {
    failSetup(e);
  }
}

/**
 * Establish the call's shared media key and give it to every mesh peer.
 *
 * MUST run while the mesh is still up: distribution rides each peer's call
 * cipher, and those die with the peer connections. Doing it after teardown
 * would leave no channel to send it over.
 *
 * ONE participant mints, chosen deterministically by lowest uid, so N peers
 * switching at the same moment do not each mint a different key and leave the
 * room unable to decode itself. Everyone else adopts what arrives.
 */
async function distributeMediaKey(s: Session, key: Uint8Array, to: string[]): Promise<void> {
  const e2ee = await import('../../services/crypto/e2eeSession.rn');
  const body = JSON.stringify({ v: 'mk1', k: Buffer.from(key).toString('base64') });
  for (const uid of to) {
    // Sealed with the PAIRWISE RATCHET, not the per-peer call cipher.
    //
    // The call cipher dies with the mesh peer connections, and those are torn
    // down the moment we switch to the SFU — so a key rotation after the switch
    // would have no channel at all. The ratchet session is independent of the
    // call and survives it, which is what makes rotation possible for the whole
    // lifetime of the room. Volume is trivial (once per call, once per leave),
    // so the "don't ratchet per frame" rule in lib/callCrypto does not apply.
    try {
      await signal.sendMediaKey(uid, s.chatId, await e2ee.e2eeEncrypt('', uid, body));
    } catch { /* that participant simply keeps the old key and re-syncs later */ }
  }
}

/** Everyone in the call except us, from the roster (mesh peers may be gone). */
function otherParticipants(s: Session): string[] {
  const roster = Object.keys(getSnapshot().participants ?? {});
  const uids = new Set([...roster, ...Array.from(s.peers.keys())]);
  uids.delete(s.meId);
  return Array.from(uids);
}

async function establishMediaKey(s: Session): Promise<void> {
  if (s.mediaKey) return;

  const others = otherParticipants(s);
  const minter = [s.meId, ...others].sort()[0];
  if (minter !== s.meId) return;      // someone else mints; onMediaKey adopts it

  const { randomBytes } = await import('@noble/hashes/utils.js');
  const key = randomBytes(32);
  s.mediaKey = key;
  await distributeMediaKey(s, key, others);
}

/**
 * Re-key after someone leaves — forward secrecy for the rest of the call.
 *
 * Without this, a participant who left (or was removed by a host) keeps a key
 * that still decrypts every frame the SFU continues to forward. The server
 * cannot help: it forwards ciphertext by design and has no idea who can read
 * it. Only a re-key actually removes them.
 *
 * Same deterministic minter rule as the initial key, so simultaneous departures
 * cannot leave the room split across two keys. The key ring in frameCrypto
 * (keyRingSize 16) covers the changeover, so frames already in flight under the
 * previous key still decode instead of producing a visible freeze.
 */
async function rotateMediaKeyAfterLeave(s: Session): Promise<void> {
  if (!s.sfu || s.disposed) return;                 // mesh re-keys by tearing the link down

  const others = otherParticipants(s);
  if (others.length === 0) return;                  // nobody left to protect from
  if ([s.meId, ...others].sort()[0] !== s.meId) return;

  const { randomBytes } = await import('@noble/hashes/utils.js');
  const key = randomBytes(32);
  s.mediaKey = key;
  await s.sfu.crypto?.setKey(key);
  await distributeMediaKey(s, key, others);
  console.warn('[call] media key rotated after a participant left');
}

/**
 * Move this call onto the SFU, with frame-level E2EE.
 *
 * The encryption is the point. An SFU forwards media it would normally be able
 * to decode, which is the usual reason "scale" and "end-to-end encrypted" are
 * treated as alternatives. RTCFrameCryptor encrypts each frame BEFORE it leaves
 * the device, so the server routes ciphertext — the guarantee survives the
 * topology change, and lib/call/mode.ts's promise that only broadcast drops
 * E2EE stays true.
 *
 * The media key is the per-call key this call already established over the
 * Double Ratchet. No new key agreement is introduced: the SFU changes the
 * TRANSPORT, not the trust model.
 */
/**
 * Start a call directly on the SFU — no peer offer/answer, no mesh.
 *
 * This is the path every call takes now (topologyFor returns 'sfu'). The mesh
 * entry points remain only for sfuAvailable=false.
 *
 * Order matters and is not obvious:
 *   1. the server call session must EXIST before we can ask for a room token,
 *      so unlike the mesh path (which fires openSession and forgets) this one
 *      awaits it;
 *   2. the media key is minted and distributed over the PAIRWISE RATCHET
 *      (distributeMediaKey), which is independent of any peer connection — so
 *      it works with no mesh at all;
 *   3. only then join, with the key already in hand. Joining first and keying
 *      afterwards would publish unencrypted frames for the gap, which must
 *      never happen.
 */
async function startViaSfu(s: Session, kind: CallKind): Promise<void> {
  const res = await openCallSession(s.chatId, s.kind, 'meeting');
  if (!res?.call?.id) throw new Error('could not open a call session');
  s.serverCallId = res.call.id;
  const me = res.participants?.find(p => p.userId === s.meId);
  dispatch({ type: 'session', sessionId: res.call.id, myRole: me?.role });

  await establishMediaKey(s);
  // A non-minting participant adopts the key over the ratchet; give it a moment
  // rather than joining unencrypted.
  for (let i = 0; i < 20 && !s.mediaKey && !s.disposed; i++) {
    await new Promise(r => setTimeout(r, 150));
  }
  if (!s.mediaKey) throw new Error('no media key — refusing to publish unencrypted');

  await joinViaSfu(s, kind === 'video');
}

async function joinViaSfu(s: Session, video: boolean): Promise<void> {
  if (!s.serverCallId) throw new Error('no server call session');

  const { getSfuToken } = await import('./sfuToken');
  const { joinSfuRoom } = await import('./sfuRoom');
  const cred = await getSfuToken(s.serverCallId);

  const key = s.mediaKey;
  if (!key) throw new Error('no media key for this call');

  const sfu = await joinSfuRoom({
    url: cred.url,
    token: cred.token,
    identity: cred.identity,
    publish: cred.role !== 'audience',
    video,
    e2eeKey: key,
    onDisconnected: () => { if (!s.disposed) hangUp('failed', false); },
  });

  s.wire = 'sfu';
  s.sfu = sfu;
  onDispose(() => { void sfu.leave(); });
  console.warn('[call] switched to SFU with frame E2EE');
}

/**
 * Drive the adaptive quality policy (lib/call/quality.ts) from real getStats
 * every 4 s, and push the resulting ceiling onto the encoder.
 *
 * Video only — an audio call has nothing to scale, and polling stats for it
 * would just be a timer waking the CPU for no reason. 4 s is a deliberate
 * compromise: fast enough to react inside a few seconds of congestion, slow
 * enough that the polling itself is not the battery cost it is trying to avoid.
 */
function startQualityLoop(peer: CallPeer): void {
  const isVideoCall = session?.kind === 'video';
  // The ceiling is re-read each tick, not captured: the user can enable
  // low-data mode or turn their camera off mid-call, and both must take effect
  // on the next sample rather than on the next call.
  const ceiling = () => ceilingFor(getLowDataModeCached(), isVideoCall);

  let quality: typeof INITIAL_QUALITY = { tier: ceiling(), goodStreak: 0 };
  let cursor = INITIAL_CURSOR;
  peer.applyVideoQuality(TIERS[quality.tier]);
  peer.setVideoEnabled(TIERS[quality.tier].video);
  peer.applyAudioBitrate(audioBitrate(quality.tier, getLowDataModeCached()));

  const timer = setInterval(async () => {
    const totals = await peer.readOutboundStats();
    if (!totals) return;
    const { sample, cursor: next } = sampleFromTotals(
      { packetsSent: totals.packetsSent, packetsLost: totals.packetsLost }, totals.rttMs, cursor,
    );
    cursor = next;
    const prevTier = quality.tier;
    quality = nextQuality(quality, sample, ceiling());
    if (quality.tier !== prevTier) {
      peer.applyVideoQuality(TIERS[quality.tier]);
      // Audio-priority: below 'low' the video track is suspended outright so
      // the starved uplink carries speech instead of a frozen mosaic.
      peer.setVideoEnabled(TIERS[quality.tier].video);
      peer.applyAudioBitrate(audioBitrate(quality.tier, getLowDataModeCached()));
    }

    // REPORT the sample, don't only act on it (H1). These three numbers are
    // already computed here every 4 s and were being thrown away the moment the
    // tier decision was made — so "why was that call bad?" had no answer beyond
    // the user's word for it.
    //
    // Written to the perf ring buffer rather than sent anywhere: it is already
    // bounded, already surfaced by app/perf-debug.tsx, and costs no network on
    // a connection that is by definition already struggling. A tier CHANGE is
    // marked separately because it is the interesting event — the moment the
    // call visibly degraded or recovered.
    perf.mark('call_quality', {
      lossPct: Math.round(sample.lossRatio * 1000) / 10,
      rttMs: sample.rttMs,
      tier: quality.tier,
      peer: peer.uid,
    });
    if (quality.tier !== prevTier) {
      perf.mark('call_quality_change', { from: prevTier, to: quality.tier, peer: peer.uid });
    }
  }, 4000);
  onDispose(() => clearInterval(timer));
}

/** Place a call. Rejects only on setup failure; the call is torn down first. */
export async function startOutgoing(a: StartArgs): Promise<void> {
  try {
    // ── verify the secure session BEFORE dialling ─────────────────────
    //
    // The SDP offer is sealed with this peer's ratchet session. Dial with a
    // stale one and the callee cannot open the offer, never answers, and never
    // sends candidates — ICE then sits in `connecting` until it gives up. To
    // the user that is "calling…" forever, indistinguishable from bad signal,
    // so they retry and it fails identically. Observed exactly that tonight.
    //
    // Repair is a re-key request, not a forced re-key: text shares this session,
    // and re-keying every call would destroy it and invite a reset storm.
    const { checkSessionHealth, waitForSession } = await import('./sessionHealth');
    if (await checkSessionHealth(a.peerUid) === 'repairing') {
      dispatch({ type: 'error', message: 'Reconnecting secure session…' });
      // Bounded: dialling late beats refusing to dial. If the repair has not
      // landed we continue anyway — the in-call self-heal is still there — but
      // the user has been told why it is slow.
      await waitForSession(a.peerUid);
    }

    const { s, peer, me } = await bootstrap(a, 'outgoing');
    const offer = await peer.createOffer(a.kind === 'video');

    // Seal the signalling under a per-call key. Falls back to plaintext only
    // when the peer has published no key bundle (an older build).
    const sealed = await newCallCipher(a.peerUid, offer);
    if (sealed) peer.setCipher(sealed.cipher);
    const offerWire = sealed ? sealed.offerWire : offer;

    // If the callee cannot open our offer it resets its session and asks us to
    // re-key. That heal is useless to the call in progress unless the ring loop
    // stops re-sending the envelope the callee already rejected — so re-seal
    // whenever the session epoch moves. Unchanged session → identical wire,
    // preserving the one-ratchet-wrap-per-call property.
    const { sessionEpoch } = await import('../sessionEpoch');
    let sealedAt = sessionEpoch(a.peerUid);
    let resealing = false;
    const reseal = (): any | null => {
      if (!sealed || resealing) return null;
      const now = sessionEpoch(a.peerUid);
      if (now === sealedAt) return null;          // nothing changed
      sealedAt = now;
      resealing = true;
      // newCallCipher is async and the ring tick is not; kick it off and let
      // the NEXT tick (3s) carry the fresh wire rather than blocking this one.
      void newCallCipher(a.peerUid, offer)
        .then(fresh => {
          if (!fresh || isDone()) return;
          peer.setCipher(fresh.cipher);
          pendingReseal = fresh.offerWire;
          // Same tag the callee prints when it takes the fresher envelope, so
          // the hand-off is greppable across both devices' logs.
          callStage(offerTag(fresh.offerWire), 'offer_resealed',
            `session re-keyed mid-ring, superseding ${offerTag(offerWire)}`);
        })
        .catch(() => {})
        .finally(() => { resealing = false; });
      return null;
    };
    let pendingReseal: any = null;

    const cancelRing = await signal.ringAndOffer({
      to: a.peerUid, from: s.meId, chatId: a.chatId,
      type: a.kind === 'video' ? 'video' : 'audio',
      // BLANK, never the placeholder. This is OUR name, sent to the CALLEE —
      // and the callee's screens only run their getChat lookup when the name
      // arrives empty. Sending the literal 'VaultChat user' looked like a real
      // name, disabled that lookup, and pinned the placeholder on the receiver
      // for the whole call. That is the "VaultChat user on the receiver end"
      // report: the fallback was travelling over the wire as data.
      callerName: me.name ?? me.email ?? '',
      offer: offerWire,
      reseal: () => { const w = pendingReseal; pendingReseal = null; return w ?? reseal(); },
    }, isDone);
    onDispose(cancelRing);

    // END THE CALL WHEN THE RING BUDGET RUNS OUT.
    //
    // ringAndOffer stops after 9 repeats (~27s) and, until now, NOTHING
    // happened next: the interval cleared and the call sat in `ringing`
    // forever. That is the "calling…" that never resolves — no answer, no
    // failure, no way out but the back gesture, and the mic and foreground
    // service stayed held the whole time.
    //
    // It is also what a dead E2EE session looks like from this side: the
    // callee cannot open the sealed offer, so it never answers and never sends
    // candidates, and we would gather host+srflx+relay perfectly and then wait
    // for good. Captured on device as exactly that — `[call] gathered
    // {"host":4,"srflx":8,"relay":13}` followed by silence.
    //
    // Slightly longer than the ring budget so the LAST offer still has time to
    // be answered; ending at exactly 27s would race the ninth ring.
    const noAnswer = setTimeout(() => {
      if (isDone()) return;
      console.warn('[call] no answer within', RING_TIMEOUT_MS / 1000, 's — ending the call');
      // notifyPeer: true so the callee's ring stops rather than being left
      // showing an incoming call nobody is placing any more.
      hangUp('no_answer', true);
    }, RING_TIMEOUT_MS);
    onDispose(() => clearTimeout(noAnswer));

    // High-priority wake-up so a killed/dozing callee still rings. Doorbell
    // only — the SDP never rides in the push (it carries the DTLS-SRTP
    // fingerprint that anchors media E2EE).
    nativeCall.ringPeer({ calleeId: a.peerUid, callId: String(a.chatId || a.peerUid), isVideo: a.kind === 'video' })
      .catch(() => {});

    callStage(offerTag(offerWire), 'offer_sent',
      `${a.kind}, sealed=${sealed ? 'sig1' : 'plaintext(legacy peer)'}`);
    dispatch({ type: 'offer_sent' });
  } catch (e: any) {
    failSetup(e);
  }
}

/** Answer a call whose offer we already hold (from the ring payload). */
export async function acceptIncoming(a: StartArgs & { offerWire: any }): Promise<void> {
  try {
    const { s, peer } = await bootstrap(a, 'incoming');
    const tag = offerTag(a.offerWire);
    callStage(tag, 'incoming', `${a.kind} call`);

    // The wire is either an encrypted sig1 envelope (current build) or a raw
    // plaintext SDP (legacy peer); openCallOffer handles both.
    let { cipher, offer } = await openCallOffer(a.peerUid, a.offerWire);

    if (!offer?.type) {
      // WE could not open the caller's offer, so the session between us is
      // dead — the usual cause is one side reinstalling, which leaves the other
      // holding a ratchet for an identity that no longer exists.
      callFail(tag, 'OFFER_DECRYPT', 'E2EE_SESSION_STALE', { retry: 0, recoverable: true });

      // Ask for a re-key BEFORE giving up. openCallOffer already does this on
      // the path where the ratchet THROWS, but not on the one where the wrapped
      // key opens and the GCM frame does not — and that path reaches here with
      // offer:null and no repair requested at all. requestPeerRekey is
      // rate-limited per peer, so asking twice costs nothing.
      try {
        const { requestPeerRekey } = await import('../chatService');
        await requestPeerRekey(a.peerUid, true);
      } catch { /* the caller may still re-seal on its own epoch bump */ }

      // WAIT FOR THE REPAIR INSTEAD OF FAILING THROUGH IT.
      //
      // This used to throw immediately, and that is what made a stale session
      // unrecoverable in practice. The re-key we just requested makes the caller
      // re-run X3DH and bump its session epoch; its ring loop notices and
      // re-seals the offer on the next tick (lib/call/signal.ts ringAndOffer).
      // So an openable envelope is already seconds away — and we were throwing
      // it away, telling the user to "try again in a moment", and then failing
      // their retry identically because they retried faster than the repair.
      //
      // Exactly ONE retry, on exactly ONE fresh envelope, bounded by
      // REKEY_WAIT_MS. Not a loop: if the second envelope will not open either,
      // the problem is not staleness and grinding on it would hold the mic and
      // the ring for the caller's entire 35 s budget with no better outcome.
      const fresh = await signal.waitForNewOffer(
        a.peerUid, (w) => offerTag(w) === tag, REKEY_WAIT_MS,
      );
      // The user may have hung up while we waited; bootstrap's session is the
      // authority on whether this call is still wanted.
      if (s.disposed) return;

      if (!fresh) {
        callFail(tag, 'OFFER_REFRESH', 'E2EE_REKEY_TIMEOUT', { retry: 1, recoverable: false });
      } else {
        const freshTag = offerTag(fresh);
        callStage(freshTag, 'offer_received', `re-sealed, superseding ${tag}`);
        const second = await openCallOffer(a.peerUid, fresh);
        cipher = second.cipher;
        offer = second.offer;
        if (offer?.type) callStage(freshTag, 'offer_decrypted', 'session recovered in place');
        else callFail(freshTag, 'OFFER_DECRYPT', 'E2EE_SESSION_STALE', { retry: 1, recoverable: false });
      }
    } else {
      callStage(tag, 'offer_decrypted');
    }

    // Set the FINAL cipher, once. Doing it before the retry would install the
    // passthrough left behind by a failed open, and setCipher is what flushes
    // the sealed candidates buffered during setup — they must be opened with the
    // key the call actually ends up using.
    peer.setCipher(cipher);
    if (!offer?.type) {
      throw new Error('Secure call setup failed — reconnecting the secure session. Try again in a moment.');
    }

    const answer = await peer.answer(offer);
    callStage(offerTag(a.offerWire), 'answer_created');
    const stopResend = await signal.sendAnswerWithRetry(
      a.peerUid, s.meId, cipher.seal(answer), isDone,
    );
    callStage(offerTag(a.offerWire), 'answer_sent');
    onDispose(stopResend);
  } catch (e: any) {
    failSetup(e);
  }
}

function failSetup(e: any): void {
  dispatch({ type: 'error', message: e?.message ?? 'Call failed' });
  hangUp('setup_error', true);
}

// ── connected-state side effects ──────────────────────────────────────

/**
 * Promote to the mic/camera foreground service and clear the OS ring. Called by
 * the screen when status becomes 'connected'; idempotent.
 *
 * Android today; on iOS the adapter is a documented no-op until CallKit lands
 * (lib/call/native/ios.ts). Either way the engine calls the same method.
 */
let foregrounded = false;

/**
 * Promote to the mic/camera foreground service. Idempotent.
 *
 * MUST happen while the app still holds the microphone legitimately, which is
 * why bootstrap() calls it as soon as media is acquired rather than waiting for
 * `connected`.
 *
 * It used to run ONLY on connect, and that left a window of up to 35 s — the
 * whole ring budget — in which the call held a live AudioRecord with no
 * foreground service behind it. Android 11+ denies microphone input to a
 * backgrounded app that has no microphone-type FGS: it does not throw, it feeds
 * SILENCE. So the ordinary act of pressing home while a call rings produced a
 * call that connected normally and carried no audio in one direction, with
 * nothing in any log to say why.
 *
 * The AppState handler in bootstrap() documents itself as "keep the audio, drop
 * the video" on background — a promise that was only true once this service was
 * running, and during ringing it was not.
 *
 * Starting here is also the legal moment on Android 14+, where starting a
 * microphone-type FGS requires the app to be in the foreground: call setup is
 * user-initiated and foreground by construction, whereas `connected` can land
 * after the user has already switched away — the exact case that would throw
 * ForegroundServiceStartNotAllowedException. The native side catches and falls
 * back regardless (CallForegroundService.kt).
 */
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
  // Normally already running from bootstrap; this covers a start that was
  // refused or raced, so a connected call is never left without one.
  startCallForegroundService(s);
  nativeCall.dismissIncomingUi();
}

// ── controls ──────────────────────────────────────────────────────────

function setFlag(key: CallFlag, value: boolean): void {
  dispatch({ type: 'flag', key, value });
}

export function toggleMute(): void {
  const s = session; if (!s) return;
  const next = !getSnapshot().muted;
  media.setMicEnabled(s.localStream, !next);
  setFlag('muted', next);
}

export function toggleSpeaker(): void {
  const next = !getSnapshot().speaker;
  media.setSpeaker(next);
  setFlag('speaker', next);
}

export function toggleCamera(): void {
  const s = session; if (!s) return;
  const next = !getSnapshot().cameraOff;
  media.setCameraEnabled(s.localStream, !next);
  setFlag('cameraOff', next);
}

export function flipCamera(): void {
  media.flipCamera(session?.localStream);
}

/** Swap the outgoing camera track for the screen — no renegotiation. */
export async function startScreenShare(): Promise<void> {
  const s = session;
  // `s` must be checked BEFORE it is dereferenced. solePeer(s!) ran first and
  // would throw on a null session — the non-null assertion hid that from the
  // compiler rather than making it safe.
  if (!s) throw new Error('No active call.');

  if (!media.isScreenShareSupported()) throw new Error('Screen sharing is not supported on this device.');

  // EVERY peer, not solePeer().
  //
  // solePeer() returns null unless there is exactly ONE remote participant, so
  // in a group call this lookup failed and threw "Screen sharing is only
  // available in a video call" — while the user was in a video call, looking at
  // three other people. Sharing was impossible in any group call and the error
  // blamed the wrong thing.
  //
  // A mesh holds one connection per peer, so the screen track has to be swapped
  // onto each of them. "1:1 is a mesh with N=1" is the model this file is built
  // on, and this is the one place that had forgotten it.
  const senders = [...s.peers.values()]
    .map(p => ({ uid: p.uid, sender: p.videoSender() }))
    .filter((x): x is { uid: string; sender: any } => !!x.sender);
  if (senders.length === 0) {
    // A voice call has no outgoing VIDEO track, so there is no sender whose
    // track can be swapped for the screen — screen share is video-only by
    // construction. This used to `return` silently, which is why the button
    // appeared to do nothing at all instead of explaining itself.
    throw new Error(s.kind === 'video'
      ? 'Screen sharing needs the video track to be ready — try again in a moment.'
      : 'Screen sharing is only available in a video call.');
  }

  // LIFT FLAG_SECURE, OR THERE IS NOTHING TO CAPTURE.
  //
  // app/_layout.tsx calls preventScreenCaptureAsync() at boot, which sets
  // FLAG_SECURE on the app's only window app-wide. FLAG_SECURE blocks screen
  // RECORDING as well as screenshots — MediaProjection included — so the share
  // came back as black frames for everything VaultChat drew. Nothing else
  // cleared it: the root layout only clears on unmount (app teardown), and
  // chat.tsx's per-chat policy does not survive navigating to the call.
  //
  // So screen share was not broken in the WebRTC layer at all; the app was
  // refusing to be captured, including by itself.
  //
  // This is a genuine trade-off, not an oversight being undone: while sharing,
  // the app IS screenshot-able. That is inherent — you cannot both block
  // capture and show your screen to someone. The window is therefore made as
  // narrow as the operation, and re-asserted on EVERY exit path below.
  await setSecure(false).catch(() => {});

  let screen: any;
  try {
    screen = await media.acquireScreenStream();
  } catch (e) {
    // Consent dialog dismissed, or capture refused by policy. Put the guard
    // back before rethrowing — a cancelled share must not leave the app
    // capturable for the rest of the session.
    await setSecure(true).catch(() => {});
    throw e;
  }
  const track = screen?.getVideoTracks?.()[0];
  if (!track) {
    media.stopStream(screen);
    await setSecure(true).catch(() => {});
    // NOT the word "cancel": the caller suppresses any message matching
    // /cancel|denied by user|NotAllowed/ so a genuine user-cancel does not
    // interrupt a call with an alert. Phrasing this as "cancelled" made it
    // invisible too — the consent dialog was accepted, no track came back, and
    // the user saw nothing at all. Observed on device.
    throw new Error('Screen capture returned no video track. Your device or work profile may block screen recording.');
  }
  // Every peer sends the SAME local camera track, so one saved reference
  // restores all of them.
  s.cameraTrack = senders[0].sender.track;
  s.screenStream = screen;
  await Promise.all(senders.map(x => x.sender.replaceTrack(track).catch((e: any) => {
    // One peer refusing must not abort the share for everyone else — the
    // others are already carrying the screen by the time this settles.
    console.warn('[screenshare] could not swap track for', x.uid, '—', e?.message ?? e);
  })));
  try { dispatch({ type: 'local_stream', url: screen.toURL() }); } catch {}
  setFlag('sharing', true);
  // Tell each peer separately: this event is addressed per-uid (the server
  // stamps the sender), so a group needs N of them. s.peerUid is '' in a group
  // call, which is why the single send reached nobody.
  for (const x of senders) signal.sendScreenShare(x.uid, s.chatId, true).catch(() => {});
  try { track.addEventListener?.('ended', () => { stopScreenShare().catch(() => {}); }); } catch {}
}

export async function stopScreenShare(): Promise<void> {
  // FIRST, and outside the session check. The guard must go back on even if the
  // session has already gone — this function is also reached from the track's
  // 'ended' event, which fires when the user stops the share from the system
  // UI, and that can race a hangup. Restoring only on the happy path would
  // leave the app-wide screenshot block off with no way for the user to know.
  await setSecure(true).catch(() => {});

  const s = session;
  if (!s) return;
  // Same reason as startScreenShare: solePeer() left every peer in a group call
  // still receiving the screen after the user stopped sharing, with no way back
  // to the camera short of ending the call.
  const peers = [...s.peers.values()];
  if (s.cameraTrack) {
    await Promise.all(peers.map(async p => {
      const sender = p.videoSender();
      if (!sender) return;
      try { await sender.replaceTrack(s.cameraTrack); }
      catch (e: any) { console.warn('[screenshare] could not restore camera for', p.uid, '—', e?.message ?? e); }
    }));
  }
  media.stopStream(s.screenStream);
  s.screenStream = null;
  s.cameraTrack = null;
  try { if (s.localStream) dispatch({ type: 'local_stream', url: s.localStream.toURL() }); } catch {}
  setFlag('sharing', false);
  for (const p of peers) signal.sendScreenShare(p.uid, s.chatId, false).catch(() => {});
}

// ── call waiting ──────────────────────────────────────────────────────
// Registers with lib/callState so an incoming call arriving mid-call can offer
// "Hold & accept" instead of clobbering this one.

function registerForCallWaiting(a: StartArgs, _myName: string): void {
  const me: ActiveCall = {
    chatId: a.chatId, peerUid: a.peerUid, peerName: a.peerName || 'VaultChat user',
    kind: a.kind,
    hold: () => {
      const s = session; if (!s) return;
      media.setMicEnabled(s.localStream, false);
      if (a.kind === 'video') media.setCameraEnabled(s.localStream, false);
      for (const p of s.peers.values()) p.setRemoteAudible(false);
      setFlag('held', true);
    },
    resume: () => {
      const s = session; if (!s) return;
      const snap = getSnapshot();
      media.resumeAudioSession(a.kind, snap.speaker);
      media.setMicEnabled(s.localStream, !snap.muted);
      if (a.kind === 'video') media.setCameraEnabled(s.localStream, !snap.cameraOff);
      for (const p of s.peers.values()) p.setRemoteAudible(true);
      setFlag('held', false);
    },
    hangUp: () => hangUp('local_hangup', true),
  };
  setActiveCall(me);
  onDispose(() => { clearActiveCall(me); foregrounded = false; });
}

export default {};
