// lib/call/sfuRoom.ts — join a LiveKit room, with frame-level E2EE.
//
// This is the missing half of two modes at once:
//
//   GROUP CALLS (6-64)  publish + subscribe, frames encrypted end to end so the
//                       SFU forwards ciphertext it cannot read.
//   BROADCAST           publish only. Egress transcodes the room to HLS, which
//                       is why broadcast MUST NOT be frame-encrypted: a
//                       transcoder cannot read ciphertext. That is not a
//                       configuration choice, it is arithmetic — and it is why
//                       migration 079 records e2ee=false for broadcasts.
//
// The E2EE flag therefore comes from the CALLER, never from a default. Getting
// it backwards either breaks the stream (encrypted broadcast, egress outputs
// noise) or silently downgrades a group call the UI claims is encrypted. The
// second is worse, so `e2eeKey` is required to be explicit: pass a key, or pass
// null and say why.

// IMPORT ORDER IS LOAD-BEARING — do not let a formatter sort these.
//
// livekit-client is a BROWSER library: it references DOMException, fetch and
// friends at module scope. Hermes has no DOMException, so importing it first
// throws `ReferenceError: Property 'DOMException' doesn't exist` before a single
// line of this file runs — which surfaces as a WHITE SCREEN with no error of
// ours anywhere in the log, because the module never evaluated.
//
// @livekit/react-native installs that polyfill as a side effect of being
// imported (its index requires ./polyfills/DOMException). Importing it FIRST is
// what makes the line below legal.
import { registerGlobals } from '@livekit/react-native';
import { Room, RoomEvent, Track, type RemoteParticipant } from 'livekit-client';
import { enableFrameCrypto, type FrameCryptoHandle } from './frameCrypto';

// livekit-client is a WEB library: it expects navigator.mediaDevices,
// RTCPeerConnection and friends as globals. registerGlobals installs the React
// Native WebRTC implementations under those names. Without it the SDK fails at
// connect with an error that points at the browser API rather than at this.
let globalsReady = false;
function ensureGlobals(): void {
  if (globalsReady) return;
  registerGlobals();
  globalsReady = true;
}

export interface SfuSession {
  room: Room;
  /** Frame encryption, or null for a deliberately unencrypted room. */
  crypto: FrameCryptoHandle | null;
  leave(): Promise<void>;
}

export interface JoinArgs {
  url: string;
  token: string;
  identity: string;
  /** Publish camera + mic. False for an audience member watching over WebRTC. */
  publish: boolean;
  /** Camera on. Audio-only broadcasts are far cheaper and often what is wanted. */
  video: boolean;
  /**
   * 32-byte media key, or null for NO frame encryption.
   *
   * null is correct for broadcast (egress must be able to read the frames) and
   * WRONG for a group call. Required rather than defaulted so the decision is
   * always visible at the call site.
   */
  e2eeKey: Uint8Array | null;
  onParticipant?: (p: RemoteParticipant, joined: boolean) => void;
  onDisconnected?: () => void;
}

export async function joinSfuRoom(a: JoinArgs): Promise<SfuSession> {
  ensureGlobals();

  const room = new Room({
    // Let the SDK drop layers under congestion rather than freezing. The same
    // reasoning as lib/call/quality.ts on the mesh path: degrade, do not stall.
    adaptiveStream: true,
    dynacast: true,
  });

  if (a.onParticipant) {
    room.on(RoomEvent.ParticipantConnected, p => a.onParticipant!(p, true));
    room.on(RoomEvent.ParticipantDisconnected, p => a.onParticipant!(p, false));
  }
  if (a.onDisconnected) room.on(RoomEvent.Disconnected, a.onDisconnected);

  await room.connect(a.url, a.token);

  // Attach frame crypto BEFORE publishing. Attaching afterwards leaves a window
  // where real camera frames leave the device unencrypted, which is precisely
  // the guarantee this is here to make.
  let crypto: FrameCryptoHandle | null = null;
  if (a.e2eeKey) {
    const pc = (room.engine as any)?.pcManager?.publisher?.pc
            ?? (room.engine as any)?.publisher?.pc;
    crypto = await enableFrameCrypto(pc, a.identity, a.e2eeKey);
    if (!crypto.active) {
      // A group call that believes it is encrypted but is not must not proceed
      // quietly. Broadcast never reaches here — it passes e2eeKey: null.
      await room.disconnect();
      throw new Error('Secure group call unavailable on this device');
    }
  }

  if (a.publish) {
    await room.localParticipant.setMicrophoneEnabled(true);
    if (a.video) await room.localParticipant.setCameraEnabled(true);
  }

  return {
    room,
    crypto,
    async leave() {
      try { await crypto?.dispose(); } catch {}
      try { await room.disconnect(); } catch {}
    },
  };
}

/** Track sources worth rendering, in the order a UI should prefer them. */
export const RENDER_SOURCES = [Track.Source.ScreenShare, Track.Source.Camera];

export default { joinSfuRoom };
