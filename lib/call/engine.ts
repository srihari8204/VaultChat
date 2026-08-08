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
import { INITIAL_CURSOR, INITIAL_QUALITY, TIERS, audioBitrate, ceilingFor, nextQuality, sampleFromTotals } from './quality';
import { dispatch, getSnapshot, begin, reset } from './store';
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

  if (notifyPeer && s.peerUid) signal.sendEnd(s.peerUid, s.meId, s.chatId).catch(() => {});
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
function onPeerFailed(uid: string): void {
  const s = session;
  if (!s || s.disposed) return;
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

  const iceServers = await getIceServers();

  // Route by SENDER, not by a fixed peer, so the same attachment serves 1:1 and
  // mesh. For 1:1 only the known peer is accepted; for mesh, anyone the server
  // has put in our call room.
  const detach = await signal.attachCallListeners({
    accept: (from) => (s.wire === 'direct' ? from === a.peerUid : true),
    onOffer: (from, wireSdp) => { void onMeshOffer(from, wireSdp, iceServers); },
    onAnswer: (from, wireSdp) => {
      const peer = s.peers.get(from);
      if (!peer) return;
      const sdp = peer.getCipher().open(wireSdp);
      peer.applyAnswer(sdp).then(applied => { if (applied) dispatch({ type: 'answer_applied' }); });
    },
    onIce: (from, wireCand) => {
      const peer = s.peers.get(from);
      if (!peer) return;
      peer.addRemoteCandidate(peer.getCipher().open(wireCand)).catch(() => {});
    },
    onEnd: (from) => {
      if (s.wire === 'direct') hangUp('remote_hangup', false);
      else removePeer(s, from);
    },
    onPeerScreenShare: (_from, on) => dispatch({ type: 'flag', key: 'peerSharing', value: on }),
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

  if (s.wire === 'direct') addPeer(s, a.peerUid, a.peerName, iceServers);

  registerForCallWaiting(a, me.name ?? me.email ?? 'VaultChat user');
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
  if (!s || s.disposed || s.wire !== 'mesh' || !from) return;
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

    const leaveRoom = await signal.joinCallRoom({
      chatId: a.chatId,
      onRoster: (peers) => peers.forEach(connectTo),
      onJoined: connectTo,
      onLeft:   (uid) => removePeer(s, uid),
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
    const { s, peer, me } = await bootstrap(a, 'outgoing');
    const offer = await peer.createOffer(a.kind === 'video');

    // Seal the signalling under a per-call key. Falls back to plaintext only
    // when the peer has published no key bundle (an older build).
    const sealed = await newCallCipher(a.peerUid, offer);
    if (sealed) peer.setCipher(sealed.cipher);
    const offerWire = sealed ? sealed.offerWire : offer;

    const cancelRing = await signal.ringAndOffer({
      to: a.peerUid, from: s.meId, chatId: a.chatId,
      type: a.kind === 'video' ? 'video' : 'audio',
      callerName: me.name ?? me.email ?? 'VaultChat user',
      offer: offerWire,
    }, isDone);
    onDispose(cancelRing);

    // High-priority wake-up so a killed/dozing callee still rings. Doorbell
    // only — the SDP never rides in the push (it carries the DTLS-SRTP
    // fingerprint that anchors media E2EE).
    nativeCall.ringPeer({ calleeId: a.peerUid, callId: String(a.chatId || a.peerUid), isVideo: a.kind === 'video' })
      .catch(() => {});

    dispatch({ type: 'offer_sent' });
  } catch (e: any) {
    failSetup(e);
  }
}

/** Answer a call whose offer we already hold (from the ring payload). */
export async function acceptIncoming(a: StartArgs & { offerWire: any }): Promise<void> {
  try {
    const { s, peer } = await bootstrap(a, 'incoming');

    // The wire is either an encrypted sig1 envelope (current build) or a raw
    // plaintext SDP (legacy peer); openCallOffer handles both.
    const { cipher, offer } = await openCallOffer(a.peerUid, a.offerWire);
    peer.setCipher(cipher);
    if (!offer?.type) throw new Error('Secure call setup failed — ask the caller to try again');

    const answer = await peer.answer(offer);
    const stopResend = await signal.sendAnswerWithRetry(
      a.peerUid, s.meId, cipher.seal(answer), isDone,
    );
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
export function onConnected(): void {
  const s = session;
  if (!s || foregrounded) return;
  foregrounded = true;
  nativeCall.startCallSession({
    callId: String(s.chatId || s.peerUid || 'call'),
    peerName: s.peerName || 'VaultChat user',
    isVideo: s.kind === 'video',
  });
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
  const sender = solePeer(s!)?.videoSender();
  if (!s || !sender || !media.isScreenShareSupported()) return;
  const screen = await media.acquireScreenStream();
  const track = screen?.getVideoTracks?.()[0];
  if (!track) { media.stopStream(screen); return; }
  s.cameraTrack = sender.track;          // keep the camera alive for swap-back
  s.screenStream = screen;
  await sender.replaceTrack(track);
  try { dispatch({ type: 'local_stream', url: screen.toURL() }); } catch {}
  setFlag('sharing', true);
  signal.sendScreenShare(s.peerUid, s.chatId, true).catch(() => {});
  try { track.addEventListener?.('ended', () => { stopScreenShare().catch(() => {}); }); } catch {}
}

export async function stopScreenShare(): Promise<void> {
  const s = session;
  if (!s) return;
  const sender = solePeer(s)?.videoSender();
  try { if (sender && s.cameraTrack) await sender.replaceTrack(s.cameraTrack); } catch {}
  media.stopStream(s.screenStream);
  s.screenStream = null;
  s.cameraTrack = null;
  try { if (s.localStream) dispatch({ type: 'local_stream', url: s.localStream.toURL() }); } catch {}
  setFlag('sharing', false);
  signal.sendScreenShare(s.peerUid, s.chatId, false).catch(() => {});
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
