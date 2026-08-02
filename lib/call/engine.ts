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
//   lib/CallService  native foreground service + FCM doorbell (Android today)
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
import { addCallLog } from '../callLog';
import { newCallCipher, openCallOffer } from '../callCrypto';
import {
  cancelCall, dismissIncomingNotification, initiateCall,
  startCallForeground, stopCallForeground,
} from '../CallService';
import { clearActiveCall, setActiveCall, type ActiveCall } from '../callState';
import { getIceServers } from '../iceConfig';
import * as media from './media';
import * as signal from './signal';
import { CallPeer } from './peer';
import { durationSeconds, shouldCancelRing, wasMissed, type CallFlag } from './machine';
import { INITIAL_CURSOR, INITIAL_QUALITY, TIERS, nextQuality, sampleFromTotals } from './quality';
import { dispatch, getSnapshot, begin, reset } from './store';
import type { CallKind, EndReason } from './types';

interface Session {
  chatId: string;
  peerUid: string;
  peerName: string;
  kind: CallKind;
  meId: string;
  peer: CallPeer | null;
  localStream: any;
  screenStream: any;
  cameraTrack: any;          // held during a screen share, for swap-back
  disposers: (() => void)[];
  logged: boolean;
  disposed: boolean;
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
  stopCallForeground();
  media.stopStream(s.screenStream);
  media.stopStream(s.localStream);
  s.peer?.close();
  s.peer = null;
  s.localStream = null;
  s.screenStream = null;
  s.cameraTrack = null;
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
    }).catch(() => {});
    // Outgoing call abandoned before it was answered → stop the callee's ring
    // and let it become a "missed call" on their device.
    if (shouldCancelRing(snap) && s.peerUid) {
      cancelCall(s.peerUid, String(s.chatId || s.peerUid)).catch(() => {});
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

async function bootstrap(a: StartArgs, direction: 'outgoing' | 'incoming') {
  // A previous call must be fully gone before a new one acquires the mic.
  if (session) hangUp('replaced', true);

  begin({ ...a, direction });
  session = {
    ...a, meId: '', peer: null, localStream: null, screenStream: null,
    cameraTrack: null, disposers: [], logged: false, disposed: false,
  };
  const s = session;

  media.startAudioSession(a.kind);

  const me = await getCachedUser();
  if (!me?.id) throw new Error('Not signed in');
  s.meId = me.id;

  const local = await media.acquireLocalMedia(a.kind);
  if (s.disposed) { media.stopStream(local.stream); throw new Error('cancelled'); }
  s.localStream = local.stream;
  dispatch({ type: 'local_stream', url: local.url });

  const iceServers = await getIceServers();
  const peer = new CallPeer(a.peerUid, iceServers, {
    onLocalCandidate: (sealed) => { signal.sendIce(a.peerUid, s.meId, sealed).catch(() => {}); },
    onRemoteStream: (url) => { dispatch({ type: 'remote_stream', uid: a.peerUid, url, name: a.peerName }); },
    onFailed: () => hangUp('failed', true),
  });
  s.peer = peer;
  peer.addLocalTracks(local.stream);

  const detach = await signal.attachCallListeners({
    peerUid: a.peerUid,
    onAnswer: (wire) => {
      const sdp = peer.getCipher().open(wire);
      peer.applyAnswer(sdp).then(applied => { if (applied) dispatch({ type: 'answer_applied' }); });
    },
    onIce: (wire) => { peer.addRemoteCandidate(peer.getCipher().open(wire)).catch(() => {}); },
    onEnd: () => hangUp('remote_hangup', false),
    onPeerScreenShare: (on) => dispatch({ type: 'flag', key: 'peerSharing', value: on }),
  });
  onDispose(detach);

  registerForCallWaiting(a, me.name ?? me.email ?? 'VaultChat user');
  if (a.kind === 'video') startQualityLoop(peer);
  return { s, peer, me };
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
  let quality = INITIAL_QUALITY;
  let cursor = INITIAL_CURSOR;
  peer.applyVideoQuality(TIERS[quality.tier]);

  const timer = setInterval(async () => {
    const totals = await peer.readOutboundStats();
    if (!totals) return;
    const { sample, cursor: next } = sampleFromTotals(
      { packetsSent: totals.packetsSent, packetsLost: totals.packetsLost }, totals.rttMs, cursor,
    );
    cursor = next;
    const prevTier = quality.tier;
    quality = nextQuality(quality, sample);
    if (quality.tier !== prevTier) peer.applyVideoQuality(TIERS[quality.tier]);
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
    initiateCall({ calleeId: a.peerUid, callId: String(a.chatId || a.peerUid), isVideo: a.kind === 'video' })
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
 * ANDROID ONLY today — lib/CallService gates on Platform.OS. On iOS this is a
 * silent no-op until CallKit lands, which is the tracked iOS gap.
 */
let foregrounded = false;
export function onConnected(): void {
  const s = session;
  if (!s || foregrounded) return;
  foregrounded = true;
  startCallForeground(
    String(s.chatId || s.peerUid || 'call'),
    s.peerName || 'VaultChat user',
    '',
    s.kind === 'video',
  );
  dismissIncomingNotification();
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
  const sender = s?.peer?.videoSender();
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
  const sender = s.peer?.videoSender();
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
      s.peer?.setRemoteAudible(false);
      setFlag('held', true);
    },
    resume: () => {
      const s = session; if (!s) return;
      const snap = getSnapshot();
      media.resumeAudioSession(a.kind, snap.speaker);
      media.setMicEnabled(s.localStream, !snap.muted);
      if (a.kind === 'video') media.setCameraEnabled(s.localStream, !snap.cameraOff);
      s.peer?.setRemoteAudible(true);
      setFlag('held', false);
    },
    hangUp: () => hangUp('local_hangup', true),
  };
  setActiveCall(me);
  onDispose(() => { clearActiveCall(me); foregrounded = false; });
}

export default {};
