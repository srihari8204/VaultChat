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
} from 'react-native-webrtc';
import { plainCipher, type CallCipher } from '../callCrypto';
import type { IceServerLike } from '../iceCredentials';

export interface PeerHandlers {
  /** A local candidate to seal and send to this peer. */
  onLocalCandidate: (candidate: any) => void;
  /** Remote media arrived. */
  onRemoteStream: (streamUrl: string | null) => void;
  /** Terminal connection failure for this peer. */
  onFailed: () => void;
}

export class CallPeer {
  readonly uid: string;
  readonly pc: RTCPeerConnection;
  private cipher: CallCipher = plainCipher;
  private pendingIce: any[] = [];
  private closed = false;

  constructor(uid: string, iceServers: readonly IceServerLike[], h: PeerHandlers) {
    this.uid = uid;
    this.pc = new RTCPeerConnection({ iceServers: iceServers as any });

    (this.pc as any).onicecandidate = (e: any) => {
      if (!e?.candidate || this.closed) return;
      h.onLocalCandidate(this.cipher.seal(e.candidate));
    };
    (this.pc as any).ontrack = (e: any) => {
      if (this.closed) return;
      const remote = e?.streams?.[0];
      let url: string | null = null;
      if (remote) { try { url = remote.toURL(); } catch {} }
      h.onRemoteStream(url);
    };
    (this.pc as any).onconnectionstatechange = () => {
      if (this.closed) return;
      const st = (this.pc as any).connectionState;
      if (st === 'failed' || st === 'disconnected' || st === 'closed') h.onFailed();
    };
  }

  setCipher(c: CallCipher): void { this.cipher = c; }
  getCipher(): CallCipher { return this.cipher; }

  addLocalTracks(stream: any): void {
    try { stream?.getTracks?.().forEach((t: any) => this.pc.addTrack(t, stream)); } catch {}
  }

  async createOffer(video: boolean): Promise<any> {
    const offer = await this.pc.createOffer({
      offerToReceiveAudio: true, offerToReceiveVideo: video,
    } as any);
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /** Apply a remote offer and produce the answer (already local-described). */
  async answer(offer: any): Promise<any> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.flushIce();
    const answer = await this.pc.createAnswer();
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
    try { await this.pc.setRemoteDescription(new RTCSessionDescription(sdp)); }
    catch { return false; }
    await this.flushIce();
    return true;
  }

  /** Add a remote candidate, buffering until the remote description exists. */
  async addRemoteCandidate(candidate: any): Promise<void> {
    if (this.closed || !candidate) return;
    if (!(this.pc as any).remoteDescription) { this.pendingIce.push(candidate); return; }
    try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  }

  private async flushIce(): Promise<void> {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const c of queued) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
  }

  /** The sender carrying video, for screen-share track swapping. */
  videoSender(): any {
    try {
      return this.pc.getSenders?.().find((s: any) => s.track?.kind === 'video') ?? null;
    } catch { return null; }
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
