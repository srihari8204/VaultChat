// lib/call/peer.ts — ONE RTCPeerConnection, its E2EE signalling cipher, and its
// ICE buffer. 1:1 uses one of these; a mesh uses one per remote participant.
//
// The whole point of this file is that the tricky parts exist once:
//
//   • setRemoteDescription for an answer is guarded on
//     signalingState === 'have-local-offer'. The callee re-sends its answer up
//     to 5x (a single socket blip used to drop the one-shot answer and strand
//     the call), so later copies MUST be no-ops rather than errors.
//   • ICE candidates that arrive before the remote description are buffered and
//     flushed after it lands — otherwise addIceCandidate throws and the
//     candidate is lost, which the 1:1 screens never handled and the mesh screen
//     did. Now both get it.
//   • Every frame is sealed/opened through lib/callCrypto, unchanged: a per-call
//     key ratchet-wrapped once, then AES-256-GCM per frame. plainCipher is a
//     transparent passthrough for a legacy peer, so this stays wire-compatible
//     with builds that predate the engine.

import {
  RTCIceCandidate, RTCPeerConnection, RTCSessionDescription,
} from '@livekit/react-native-webrtc';
import { plainCipher, type CallCipher } from '../callCrypto';
import type { IceServerLike } from '../iceCredentials';
// IPv6-first ICE ordering. Same module VaultBeam uses; calls were the one path
// that never got it.
import { reprioritizeIceObject } from '../icePriority';
import { tuneOpus } from './opus';

export interface PeerHandlers {
  /** A local candidate to seal and send to this peer. */
  onLocalCandidate: (candidate: any) => void;
  /** Remote media arrived. */
  onRemoteStream: (streamUrl: string | null) => void;
  /** Terminal connection failure for this peer. */
  onFailed: () => void;
  /**
   * Send an ICE-restart offer to this peer. Supplied by the engine because the
   * peer owns no signalling. Without it, restartIce() is a local no-op and a
   * handover can never recover.
   */
  onRenegotiate?: () => void;
  /**
   * The connection came back after a recovery. Used to re-attach OUTGOING
   * tracks — a screen share in particular, whose MediaProjection-backed track
   * can end up on a sender the renegotiated connection no longer owns. The peer
   * rebinds the INCOMING view itself.
   */
  onReconnected?: () => void;
  /**
   * This peer's transport reached `connected` — on the first connect AND after
   * every recovery. Distinct from onReconnected, which fires only after a
   * recovery because its job is to re-attach outgoing tracks.
   *
   * The engine uses it to clear the `reconnecting` status. It needs a signal
   * that fires on a plain reconnect because an ICE restart does NOT re-fire
   * `ontrack` — so on a voice call there is no other event to say the media
   * came back, and the status would stay "Reconnecting…" for a call that had
   * already recovered.
   */
  onConnected?: () => void;
}

/**
 * How long a peer may sit in `disconnected` before we treat it as dead.
 * `disconnected` is a TRANSIENT state — a Wi-Fi→LTE handover, a lift, a tunnel,
 * a few lost packets — and it recovers to `connected` on its own most of the
 * time. Failing the call on it (as this file used to) drops a call on every
 * blip. `failed` is the terminal state; this window covers the gap between them.
 */
export const DISCONNECT_GRACE_MS = 30_000;

/**
 * How often to re-attempt an ICE restart while waiting out the grace window.
 *
 * One restart at the moment of disconnect is not enough for a real handover:
 * when Wi-Fi drops, the new interface often has no usable route yet, so that
 * first attempt gathers nothing and the call then sits idle until the window
 * expires. Retrying keeps trying as the new network actually comes up.
 */
export const ICE_RETRY_MS = 4_000;

/**
 * How long a call that was ALREADY connected may sit in `connecting` before it
 * is treated as an outage.
 *
 * `connecting` after `connected` is a regression, not setup: the transport is
 * re-establishing and no media is flowing. It used to be handled nowhere —
 * recovery ran only for `disconnected` and `failed` — so a call that landed
 * here hung silently with no audio, no retry, and no honest failure. Captured
 * on device at 13:24:16: `connected → connecting`, then nothing at all.
 *
 * Long enough not to fight a normal ICE restart, which passes through
 * `connecting` on its way back to `connected` in well under this.
 */
export const CONNECTING_STALL_MS = 8_000;

export class CallPeer {
  readonly uid: string;
  readonly pc: RTCPeerConnection;
  private cipher: CallCipher = plainCipher;
  private pendingIce: any[] = [];
  /** Local candidates by type (host/srflx/relay) — logged when gathering ends. */
  private gathered: Record<string, number> = {};
  /** Remote candidates accepted vs dropped because the cipher returned null. */
  private remoteIce = { ok: 0, dropped: 0 };
  /** Call keys this call has superseded; kept so in-flight replies still open. */
  private staleCiphers: CallCipher[] = [];
  /** Last remote MediaStream, so the view can be rebound after a reconnect. */
  private remoteStream: any = null;
  /** True once recovery has run, so `connected` knows to rebind the view. */
  private recovered = false;
  /** Have we ever reached `connected`? Distinguishes setup from a regression. */
  private everConnected = false;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sealed candidates that arrived before the per-call cipher was known. */
  private undecryptedIce: any[] = [];
  /** ICE servers as given, kept so setConfiguration can re-apply them. */
  private readonly iceServers: readonly IceServerLike[];
  /** True once recovery has restricted this connection to the TURN relay. */
  private relayOnly = false;
  private closed = false;
  private graceTimer: any = null;
  /** Repeating ICE-restart attempts while inside the grace window. */
  private retryTimer: any = null;
  /**
   * True once a remote description has been applied, i.e. this peer has
   * completed one offer/answer exchange. Until then any incoming offer is the
   * INITIAL one, not an ICE restart — the engine relies on this to tell them
   * apart, because a 1:1 peer exists in the map before its first offer arrives.
   */
  hasNegotiated = false;
  /**
   * SDP of the last remote OFFER applied. The 1:1 ring loop re-sends the very
   * same offer every ~3s until the call is answered, so "an offer arrived on a
   * negotiated peer" is NOT enough to mean ICE restart — applying a stale
   * repeat would tear down a working connection. A genuine restart carries a
   * fresh ice-ufrag, so its SDP always differs; a ring repeat is identical.
   */
  private lastRemoteOfferSdp = '';

  /** True when `offer` is a real renegotiation rather than a ring repeat. */
  isNewOffer(offer: any): boolean {
    const sdp = String(offer?.sdp ?? '');
    return sdp !== '' && sdp !== this.lastRemoteOfferSdp;
  }

  constructor(uid: string, iceServers: readonly IceServerLike[], h: PeerHandlers) {
    this.uid = uid;
    this.iceServers = iceServers;
    // iceCandidatePoolSize pre-gathers candidates as soon as the connection
    // exists, instead of waiting for the offer/answer to be created. On a slow
    // mobile link that removes a gathering round-trip from the critical path
    // between "tap call" and "ringing", and gives ICE more time to find a
    // working path before either side gives up.
    this.pc = new RTCPeerConnection({
      iceServers: iceServers as any,
      iceCandidatePoolSize: 2,
    } as any);

    (this.pc as any).onicecandidate = (e: any) => {
      if (this.closed) return;
      // A null candidate means gathering finished. Tally what we found: a set
      // with no 'relay' entry cannot cross symmetric NAT, and that is otherwise
      // invisible until the call simply fails.
      if (!e?.candidate) {
        console.warn('[call] gathered', JSON.stringify(this.gathered), 'for', this.uid);
        return;
      }
      const type = String(e.candidate.candidate ?? '').match(/ typ (\w+)/)?.[1] ?? '?';
      this.gathered[type] = (this.gathered[type] ?? 0) + 1;
      // IPv6 first. On IPv6-native carriers (Jio, Airtel) the v4 path sits
      // behind CGNAT and usually ends up relayed through coturn, while the v6
      // path is a free direct connection — lower latency and no server
      // bandwidth. Rewriting the priority makes ICE TRY it first instead of
      // discovering it late, and it still falls through to v4 and relay on its
      // own if v6 does not work.
      //
      // This module existed and was wired into VaultBeam only; calls used
      // default ordering, which is the opposite of where it pays most.
      h.onLocalCandidate(this.cipher.seal(reprioritizeIceObject(e.candidate)));
    };
    (this.pc as any).ontrack = (e: any) => {
      if (this.closed) return;
      const remote = e?.streams?.[0];
      let url: string | null = null;
      if (remote) { try { url = remote.toURL(); } catch {} }
      // Remembered so the view can be rebound after a reconnect — see
      // republishRemoteStream().
      this.remoteStream = remote ?? this.remoteStream;
      h.onRemoteStream(url);
    };
    (this.pc as any).onconnectionstatechange = () => {
      if (this.closed) return;
      const st = (this.pc as any).connectionState;

      // A call that never connects gives the user no clue why. Recording the
      // state transitions, and which candidate type actually won, is the
      // difference between "sometimes calls fail" and a diagnosable fault:
      // 'relay' means TURN carried it, 'host'/'srflx' means a direct path —
      // and a failure with no relay candidate points at missing TURN.
      console.warn('[call] connection state →', st, 'peer', this.uid);
      if (st === 'connected') {
        this.logSelectedCandidatePair();
        // Before the recovery branch below: the status must clear whether or
        // not this connect followed a recovery, and the reducer ignores it in
        // every case that is not one.
        h.onConnected?.();
        // Rebind the remote view after a RECOVERY.
        //
        // An ICE restart moves the transport without firing `ontrack` again, so
        // the UI keeps rendering the stream URL it captured before the network
        // changed. Media resumes underneath, but the surface stays frozen —
        // reported as "screen share stopped working after switching to mobile,
        // and only came back after I stopped and re-shared", because
        // re-sharing produced a NEW track and therefore a new URL.
        //
        // Only after a recovery: doing it on the first connect would emit a
        // duplicate of the URL ontrack just delivered.
        if (this.recovered) {
          this.recovered = false;
          this.republishRemoteStream(h);
          // …and re-attach what WE are sending. Without this a screen share
          // survives as a frozen frame on the peer's screen.
          h.onReconnected?.();
        }
      }

      // Recovered (or moved on) — cancel any pending grace timer.
      if (st === 'connected' || st === 'closed') this.clearGrace();
      if (st === 'connected') this.everConnected = true;

      // A call that WAS connected and has slid back to `connecting` is an
      // outage, not setup. Nothing used to handle this state, so such a call
      // hung with no media until the user gave up — no retry, no failure, no
      // log. Give it a moment to come back on its own (an ICE restart passes
      // through here legitimately) and escalate into the normal recovery if it
      // does not.
      if (st === 'connecting' && this.everConnected && !this.graceTimer && !this.stallTimer) {
        this.stallTimer = setTimeout(() => {
          this.stallTimer = null;
          if (this.closed) return;
          if ((this.pc as any).connectionState !== 'connecting') return;   // came back
          console.warn('[call] stuck in connecting for', CONNECTING_STALL_MS / 1000, 's — recovering');
          this.beginRecovery(h);
        }, CONNECTING_STALL_MS);
      }

      if (st === 'failed' || st === 'closed') {
        // The two numbers that separate "no network path" from "signalling
        // never delivered the other side's candidates".
        console.warn('[call] at', st, '— local', JSON.stringify(this.gathered),
                     'remote accepted', this.remoteIce.ok, 'dropped', this.remoteIce.dropped);
      }

      // `closed` is terminal — the connection is gone and nothing can restart it.
      if (st === 'closed') { h.onFailed(); return; }

      // `failed` used to hang up INSTANTLY while only `disconnected` got the
      // grace window. That is backwards on Android: a Wi-Fi→mobile handover
      // usually tears the old path down hard enough that ICE goes straight to
      // `failed`, skipping `disconnected` entirely — so the 30s recovery budget
      // never applied to the one case it exists for, and the call dropped the
      // moment the network changed. `failed` IS recoverable: an ICE restart
      // moves the transport back to `checking` with a fresh candidate set.
      // Both states now enter the same recovery, and only the grace timer
      // expiring ends the call.
      if (st === 'failed' || st === 'disconnected') {
        // Hold the call open for the full grace window and keep RETRYING the
        // ICE restart, rather than trying once and waiting. On a Wi-Fi→mobile
        // handover the new interface frequently has no route for a second or
        // two, so a single immediate attempt gathers nothing.
        this.beginRecovery(h);
      }
    };
  }

  /**
   * Report which candidate pair carried the call. Best-effort and fully
   * guarded: getStats shapes differ across WebRTC builds, and a diagnostic must
   * never be able to break a working call.
   */
  private async logSelectedCandidatePair(): Promise<void> {
    try {
      const stats: any = await (this.pc as any).getStats?.();
      if (!stats?.forEach) return;
      const byId = new Map<string, any>();
      stats.forEach((r: any) => byId.set(r.id, r));
      let pair: any = null;
      stats.forEach((r: any) => {
        if (r.type === 'candidate-pair' && (r.selected || r.state === 'succeeded') && !pair) pair = r;
      });
      if (!pair) return;
      const local = byId.get(pair.localCandidateId);
      const remote = byId.get(pair.remoteCandidateId);
      console.warn('[call] media path — local:', local?.candidateType ?? '?',
                   'remote:', remote?.candidateType ?? '?',
                   local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? '(via TURN relay)' : '(direct)');
    } catch { /* diagnostics only */ }
  }

  /**
   * Hold a disconnected peer open for DISCONNECT_GRACE_MS, retrying the ICE
   * restart every ICE_RETRY_MS, and only fail if it is STILL disconnected when
   * the window expires. Idempotent: a second `disconnected` event while already
   * recovering does not restart the clock, or a flapping link would keep the
   * call alive forever instead of failing honestly.
   */
  /**
   * Hand the remote stream URL to the UI again.
   *
   * Prefers a stream taken live from the receivers: after a renegotiation the
   * transport is new, and the object captured at `ontrack` time can be stale
   * even though media is flowing through it.
   */
  private republishRemoteStream(h: PeerHandlers): void {
    try {
      let stream = this.remoteStream;
      for (const r of (this.pc as any).getReceivers?.() ?? []) {
        if (r?.track?.kind === 'video' && r.track.readyState === 'live') {
          const s = (r as any).streams?.[0];
          if (s) { stream = s; break; }
        }
      }
      const url = stream?.toURL?.() ?? null;
      if (url) {
        console.warn('[call] reconnected — rebinding remote video');
        h.onRemoteStream(url);
      }
    } catch { /* the call is fine; only the rebind was best-effort */ }
  }

  private beginRecovery(h: PeerHandlers): void {
    if (this.graceTimer) return;                 // already counting down
    this.recovered = true;                       // rebind the view once we return
    const started = Date.now();
    this.restartIce();                           // first attempt immediately
    h.onRenegotiate?.();

    this.retryTimer = setInterval(() => {
      if (this.closed) return;
      const st = (this.pc as any).connectionState;
      // `connected` is the ONLY success. Treating "not disconnected and not
      // failed" as recovered cancelled the budget as soon as our own ICE
      // restart moved the transport to `connecting` — so the retry loop
      // stopped itself after the first attempt and a call stuck in
      // `connecting` was abandoned mid-recovery.
      if (st === 'connected') { this.clearGrace(); return; }
      console.warn('[call] still', st, 'after', Math.round((Date.now() - started) / 1000), 's — retrying ICE');
      // One direct attempt was already made and did not take. Everything after
      // it goes over the relay, which is reachable from whichever network the
      // device just landed on.
      this.preferRelay();
      this.restartIce();
      h.onRenegotiate?.();          // the half that actually reaches the peer
    }, ICE_RETRY_MS);

    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.stopRetries();
      if (this.closed) return;
      const st = (this.pc as any).connectionState;
      // Anything that is not `connected` when the budget runs out is a dead
      // call and must END, rather than hang. `closed` is excluded only because
      // it already reported the failure on its own branch.
      if (st !== 'connected' && st !== 'closed') {
        console.warn('[call] no recovery within', DISCONNECT_GRACE_MS / 1000, 's (state:', st + ') — ending call');
        h.onFailed();
      }
    }, DISCONNECT_GRACE_MS);
  }

  /** Force a fresh candidate gather now — used when the OS reports a network change. */
  onNetworkChanged(): void {
    if (this.closed) return;
    const st = (this.pc as any).connectionState;
    // Restart on a live connection too: after a handover the existing pair can
    // linger in `connected` while no media flows, and waiting for WebRTC to
    // notice wastes seconds of the recovery budget.
    // `failed` belongs here for the same reason it now enters recovery: the
    // handover that triggered this callback is often what pushed ICE into
    // `failed` in the first place, and a restart is exactly what recovers it.
    if (st === 'connected' || st === 'disconnected' || st === 'failed') {
      console.warn('[call] network changed — restarting ICE (state:', st + ')');
      this.restartIce();
    }
  }

  private stopRetries(): void {
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
  }

  private clearGrace(): void {
    this.stopRetries();
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    // The stall watchdog belongs to the same outage; leaving it armed would
    // fire recovery on a call that already came back.
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
  }

  /**
   * Ask ICE to gather fresh candidates on an existing connection.
   *
   * This alone RECOVERS NOTHING. restartIce() only marks the connection as
   * needing renegotiation and fires onnegotiationneeded — the new candidates
   * reach the peer only if someone then creates an offer and SENDS it. Nothing
   * did, so on a Wi-Fi→mobile handover the retries below looked busy while no
   * signalling happened at all and the call died after the grace window
   * (observed on device: 'still disconnected after 4s / 8s' → drop).
   *
   * The engine supplies onRenegotiate to do the sending half.
   */
  private restartIce(): void {
    try { (this.pc as any).restartIce?.(); } catch {}
  }

  /**
   * Drop to relay-only for the rest of the call.
   *
   * A recovery restart is not a fresh connection attempt — it happens because a
   * path that WAS working just died, and on a Wi-Fi↔mobile handover the thing
   * that died is precisely the direct one. Re-gathering with host candidates
   * then hands ICE a pile of pairs built on an interface that no longer exists,
   * and it spends the recovery budget failing on them: measured on device as
   * ~9.7s to recover, all of it re-testing direct paths.
   *
   * The relay is reachable from any network by construction, which is why
   * WhatsApp and Telegram route through one by default. Restricting to it makes
   * recovery deterministic rather than a race.
   *
   * ponytail: never returns to direct once switched — the call finishes on the
   * relay, costing server bandwidth for its remainder. Re-probing for a direct
   * path would save that, but only matters if relay egress becomes a real cost.
   */
  private preferRelay(): void {
    if (this.relayOnly || this.closed) return;
    // Pointless (and harmful — it would gather nothing at all) if no relay was
    // ever issued: with a STUN-only config this would leave ICE no candidates.
    const hasRelay = this.iceServers.some(s => {
      const u = (s as any)?.urls;
      return Array.isArray(u) ? u.some((x: string) => /^turns?:/i.test(x)) : /^turns?:/i.test(String(u ?? ''));
    });
    if (!hasRelay) { console.warn('[call] cannot prefer relay — no TURN server in config'); return; }
    try {
      (this.pc as any).setConfiguration?.({
        iceServers: this.iceServers as any,
        iceCandidatePoolSize: 2,
        iceTransportPolicy: 'relay',
      });
      this.relayOnly = true;
      console.warn('[call] recovery is now relay-only for', this.uid);
    } catch (err) {
      // Not fatal: recovery still runs, just with direct candidates in the mix.
      console.warn('[call] setConfiguration(relay) failed —', (err as any)?.message ?? err);
    }
  }

  /**
   * Build an ICE-restart offer and apply it locally. The caller is responsible
   * for delivering it to the peer — this class does no signalling itself.
   * Returns null when renegotiation is not safe or not possible right now.
   */
  async createIceRestartOffer(): Promise<any | null> {
    if (this.closed) return null;
    // Only from `stable`: offering while an offer/answer is already in flight
    // is glare, and would leave both ends in an invalid signalling state.
    let st = (this.pc as any).signalingState;

    // ...except when the in-flight offer is OUR OWN and nobody answered it.
    //
    // Recovery deadlocked on device exactly here: a restart offer went out, no
    // answer ever came back, and signalingState sat at `have-local-offer`
    // forever. Every later retry hit the guard above and returned null — the
    // relay-only attempt included — so a call could never recover from a
    // handover no matter how long the grace window was.
    //
    // Rolling back returns the connection to `stable` so the next offer can be
    // built. This is safe by the time we get here: retries are ICE_RETRY_MS
    // apart, so an unanswered offer is already stale, and it doubles as the
    // standard resolution for glare (both sides offering at once).
    if (st === 'have-local-offer') {
      try {
        await (this.pc as any).setLocalDescription({ type: 'rollback' });
        st = (this.pc as any).signalingState;
        console.warn('[call] rolled back an unanswered offer — state now', st);
      } catch (e: any) {
        console.warn('[call] rollback failed —', e?.message ?? e);
      }
    }

    if (st !== 'stable') {
      console.warn('[call] skip ICE-restart offer — signalingState is', st);
      return null;
    }
    try {
      const offer = this.tuned(await (this.pc as any).createOffer({ iceRestart: true }));
      await this.pc.setLocalDescription(offer);
      return offer;
    } catch (e: any) {
      console.warn('[call] could not build ICE-restart offer —', e?.message ?? e);
      return null;
    }
  }

  /** Accept a re-offer on an ALREADY-CONNECTED peer (the other side restarted ICE). */
  async applyReoffer(offer: any): Promise<any | null> {
    if (this.closed || !offer?.type) return null;
    try {
      // GLARE: both sides restarted ICE at once, so a remote offer arrives
      // while our own is still outstanding. setRemoteDescription would throw
      // from `have-local-offer`, both sides would keep skipping, and neither
      // would ever answer — the deadlock seen on device, where recovery
      // retried for the full 30s window and never sent a single offer.
      //
      // Yield: drop our offer and answer theirs. One answered offer beats two
      // unanswered ones, and it does not matter whose survives.
      if ((this.pc as any).signalingState === 'have-local-offer') {
        console.warn('[call] glare — yielding our offer to answer the peer\'s');
        try { await (this.pc as any).setLocalDescription({ type: 'rollback' }); } catch {}
      }
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      this.hasNegotiated = true;
      this.lastRemoteOfferSdp = String(offer?.sdp ?? '');
      const answer = this.tuned(await this.pc.createAnswer());
      await this.pc.setLocalDescription(answer);
      await this.flushIce();
      return answer;
    } catch (e: any) {
      console.warn('[call] could not answer re-offer —', e?.message ?? e);
      return null;
    }
  }

  /**
   * Open a frame with the CURRENT call key, falling back to superseded ones.
   *
   * Re-sealing mid-ring mints a new call key, but the peer may already have
   * opened the ORIGINAL offer and replied under the old one — that reply is in
   * flight when the key changes. Discarding the old key made those frames
   * permanently unreadable: seen on device as "could NOT open answer — call key
   * mismatch" one second after a re-seal, leaving the call with no remote
   * description at all.
   *
   * Keeping a couple of superseded keys costs nothing (they are already-derived
   * bytes for THIS call, and the call ends with them) and makes the changeover
   * lossless in both directions.
   */
  openAny(wire: any): any {
    const opened = this.cipher.open(wire);
    if (opened != null) return opened;
    for (const stale of this.staleCiphers) {
      const alt = stale.open(wire);
      if (alt != null) return alt;
    }
    return null;
  }

  setCipher(c: CallCipher): void {
    // Retain the outgoing key so replies already sealed under it still open.
    if (c !== this.cipher && this.cipher.enc) {
      this.staleCiphers.unshift(this.cipher);
      if (this.staleCiphers.length > 2) this.staleCiphers.pop();
    }
    this.cipher = c;
    // Candidates that arrived before the real cipher existed were sealed with
    // it and could not be opened. Now they can be — retry them rather than
    // losing them. See addRemoteIce for why this is not an edge case.
    const queued = this.undecryptedIce;
    this.undecryptedIce = [];
    if (queued.length) console.warn('[call] re-opening', queued.length, 'early candidates for', this.uid);
    for (const w of queued) void this.addRemoteIce(w);
  }
  getCipher(): CallCipher { return this.cipher; }

  /**
   * Take one ICE candidate straight off the wire, sealed.
   *
   * Opening it here rather than at the call site is what makes the retry above
   * possible, and it closes a race that broke every call: a callee's peer is
   * created with `plainCipher` and only receives the real per-call cipher once
   * openCallOffer() has finished an X3DH/ratchet decrypt. The caller starts
   * sending candidates the instant it has an offer, so they arrive DURING that
   * window — and plainCipher.open() returns null for a sealed sig1f frame, so
   * every one of them used to be dropped and never re-sent. The callee ended up
   * with no path to the caller while the caller had one to it: coturn recorded
   * exactly that, 79 packets out and 0 back.
   */
  async addRemoteIce(wire: any): Promise<void> {
    if (this.closed || !wire) return;
    const candidate = this.openAny(wire);
    if (!candidate) {
      // Only a sealed frame is worth holding: a genuinely corrupt one will
      // never open, and the queue is bounded so a hostile peer cannot grow it.
      if (wire?.v === 'sig1f' && this.undecryptedIce.length < 64) this.undecryptedIce.push(wire);
      else this.remoteIce.dropped++;
      return;
    }
    await this.addRemoteCandidate(candidate);
  }

  addLocalTracks(stream: any): void {
    try { stream?.getTracks?.().forEach((t: any) => this.pc.addTrack(t, stream)); } catch {}
  }

  /**
   * Apply Opus FEC/DTX to an SDP we authored, before it is set locally.
   *
   * FEC and DTX are NEGOTIATED codec parameters — there is no runtime API for
   * them, unlike bitrate — so this has to happen on every offer and every
   * answer, or whichever direction skipped it never gets them.
   *
   * Non-fatal by design: an untuned call is worse on a lossy link, but a call
   * that will not start is worse still.
   */
  private tuned(desc: any): any {
    try {
      const sdp = tuneOpus(String(desc?.sdp ?? ''));
      return sdp && sdp !== desc?.sdp ? { type: desc.type, sdp } : desc;
    } catch { return desc; }
  }

  async createOffer(video: boolean): Promise<any> {
    const offer = this.tuned(await this.pc.createOffer({
      offerToReceiveAudio: true, offerToReceiveVideo: video,
    } as any));
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /** Apply a remote offer and produce the answer (already local-described). */
  async answer(offer: any): Promise<any> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.hasNegotiated = true;
    this.lastRemoteOfferSdp = String(offer?.sdp ?? '');
    await this.flushIce();
    const answer = this.tuned(await this.pc.createAnswer());
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Apply a remote answer. Returns false when it is a duplicate or arrives
   * after close — both expected, neither an error.
   */
  async applyAnswer(sdp: any): Promise<boolean> {
    if (this.closed || !sdp?.type) return false;
    if (this.pc.signalingState !== 'have-local-offer') return false;  // already applied
    try { await this.pc.setRemoteDescription(new RTCSessionDescription(sdp)); this.hasNegotiated = true; }
    catch { return false; }
    await this.flushIce();
    return true;
  }

  /** Add a remote candidate, buffering until the remote description exists. */
  async addRemoteCandidate(candidate: any): Promise<void> {
    if (this.closed) return;
    // A null here is a candidate the cipher could not open. Silently dropping
    // it is how a call fails with an empty log: both sides gather relays, one
    // side never learns the other's, ICE runs out of pairs and reports
    // 'failed' with no other trace. Count it and say so.
    if (!candidate) { this.remoteIce.dropped++; return; }
    this.remoteIce.ok++;
    // Both peers must agree on the ordering or only one side tries IPv6 first,
    // and ICE nominates whichever pair completes — so the remote list is
    // reprioritised too, exactly as VaultBeam does at both seams.
    candidate = reprioritizeIceObject(candidate);
    if (!(this.pc as any).remoteDescription) { this.pendingIce.push(candidate); return; }
    try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (err) { console.warn('[call] addIceCandidate rejected —', (err as any)?.message ?? err); }
  }

  private async flushIce(): Promise<void> {
    const queued = this.pendingIce;
    this.pendingIce = [];
    if (queued.length) console.warn('[call] flushing', queued.length, 'buffered remote candidates for', this.uid);
    for (const c of queued) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); }
      catch (err) { console.warn('[call] buffered addIceCandidate rejected —', (err as any)?.message ?? err); }
    }
  }

  /** The sender carrying video, for screen-share track swapping. */
  videoSender(): any {
    try {
      return this.pc.getSenders?.().find((s: any) => s.track?.kind === 'video') ?? null;
    } catch { return null; }
  }

  /**
   * Re-attach an outgoing video track after a renegotiation.
   *
   * A screen-capture track is not an ordinary camera track: on Android it is
   * backed by MediaProjection through a foreground service. When an ICE restart
   * renegotiates the transport, that binding can be left pointing at a sender
   * the connection no longer owns, and the next operation on it fails with
   * `Sender does not belong to this peer connection`. The peer then renders the
   * last frame it received forever — reported as "screen share stopped working
   * after switching to mobile, and only came back when I stopped and re-shared",
   * because re-sharing built a fresh track and a fresh sender.
   *
   * replaceTrack first: it swaps the source with no SDP exchange, so nothing is
   * renegotiated and no frame is dropped. Only if the sender is genuinely
   * detached do we pay for remove + add, which DOES need renegotiation — and
   * `true` is returned so the caller knows to send a fresh offer.
   *
   * @returns true when renegotiation is required.
   */
  async rebindVideoTrack(track: any, stream: any): Promise<boolean> {
    if (this.closed || !track) return false;
    const sender = this.videoSender();
    if (sender) {
      try {
        if (sender.track === track) return false;    // still attached; nothing to do
        await sender.replaceTrack(track);
        console.warn('[call] re-attached the outgoing video track after reconnect');
        return false;
      } catch (err) {
        console.warn('[call] replaceTrack failed —', (err as any)?.message ?? err);
        // Fall through: the sender is detached from this connection.
        try { this.pc.removeTrack?.(sender); } catch {}
      }
    }
    try {
      this.pc.addTrack(track, stream);
      console.warn('[call] rebuilt the outgoing video sender — renegotiating');
      return true;
    } catch (err) {
      console.warn('[call] could not rebuild the video sender —', (err as any)?.message ?? err);
      return false;
    }
  }

  /**
   * Apply an encoder ceiling to the outgoing video. Best-effort by design:
   * setParameters is not uniformly implemented across react-native-webrtc
   * versions and devices, and a call must never fail because a quality hint
   * could not be applied.
   */
  async applyVideoQuality(tier: { maxBitrate: number; maxFramerate: number; scaleResolutionDownBy: number }): Promise<void> {
    const sender = this.videoSender();
    if (!sender?.getParameters) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      for (const e of params.encodings) {
        e.maxBitrate = tier.maxBitrate;
        e.maxFramerate = tier.maxFramerate;
        e.scaleResolutionDownBy = tier.scaleResolutionDownBy;
      }
      await sender.setParameters(params);
    } catch { /* hint only — never fail a call over it */ }
  }

  /**
   * Suspend or resume the OUTBOUND video track (audio-priority mode).
   *
   * Disables the track rather than removing it: `track.enabled = false` stops
   * frames at the source — the encoder idles and the uplink is freed — while
   * the transceiver, its mid and the negotiated m-line all stay in place. That
   * means resuming needs no renegotiation, so a link that recovers gets its
   * video back in one tick instead of a fresh offer/answer round trip on a
   * connection that is only just healthy again.
   */
  setVideoEnabled(enabled: boolean): void {
    try {
      const sender = this.videoSender();
      if (sender?.track) sender.track.enabled = enabled;
    } catch { /* best effort — never fail a call over a quality hint */ }
  }

  /**
   * Apply an Opus ceiling to the outbound audio. Same best-effort contract as
   * applyVideoQuality: setParameters is unevenly implemented across
   * react-native-webrtc versions, and audio must keep flowing regardless.
   */
  async applyAudioBitrate(maxBitrate: number): Promise<void> {
    try {
      const sender = this.pc.getSenders?.().find((s: any) => s.track?.kind === 'audio');
      if (!sender?.getParameters) return;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{} as any];
      for (const e of params.encodings) e.maxBitrate = maxBitrate;
      await sender.setParameters(params);
    } catch { /* hint only */ }
  }

  /** Cumulative outbound video counters + RTT, for the quality policy. */
  async readOutboundStats(): Promise<{ packetsSent: number; packetsLost: number; rttMs: number | null } | null> {
    try {
      const report: any = await this.pc.getStats();
      let packetsSent = 0, packetsLost = 0, rttMs: number | null = null;
      report.forEach((r: any) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') packetsSent += r.packetsSent ?? 0;
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
          packetsLost += r.packetsLost ?? 0;
          if (typeof r.roundTripTime === 'number') rttMs = Math.round(r.roundTripTime * 1000);
        }
      });
      return { packetsSent, packetsLost, rttMs };
    } catch { return null; }
  }

  /** Silence/restore what we receive from this peer (call-waiting hold). */
  setRemoteAudible(audible: boolean): void {
    try {
      this.pc.getReceivers?.().forEach((r: any) => { if (r.track) r.track.enabled = audible; });
    } catch {}
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearGrace();
    this.pendingIce = [];
    // Drop handlers before closing so a close-triggered state change cannot
    // re-enter onFailed and end a call that is already being torn down.
    try {
      (this.pc as any).onicecandidate = null;
      (this.pc as any).ontrack = null;
      (this.pc as any).onconnectionstatechange = null;
    } catch {}
    try { this.pc.close(); } catch {}
  }
}

export default {};
