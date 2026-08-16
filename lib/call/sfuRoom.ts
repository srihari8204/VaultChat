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
import { LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack } from 'livekit-client';
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
  /**
   * Swap what the published video track carries — camera ⇄ screen.
   *
   * The mesh does this with RTCRtpSender.replaceTrack and no renegotiation; the
   * room needs the same, because unpublishing and republishing would drop the
   * subscriber's view (and on a screen share that is exactly the moment the
   * user is showing something). Returns false when there is no video
   * publication to swap — a voice call.
   */
  replaceVideo(track: any): Promise<boolean>;
  /** Silence/restore every remote participant (call-waiting hold). */
  setRemoteAudible(audible: boolean): void;
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
  /**
   * Tracks to publish INSTEAD of letting the SDK open its own capture.
   *
   * The engine already holds a live capture (media.acquireLocalMedia) and every
   * control it exposes — mute, camera off, screen share, the quality loop —
   * operates on those tracks. Letting LiveKit capture again is not merely
   * wasteful: on Android the second open of the same camera fails outright, and
   * the mute controls would be pointing at a track nobody is sending.
   */
  tracks?: any[];
  /** A remote track arrived: participant identity (the user id) + stream URL. */
  onTrack?: (uid: string, url: string | null, kind: 'audio' | 'video') => void;
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

  // Same rule as TrackSubscribed: never throw back into the SDK, and log, since
  // "did the other side actually arrive in the room?" is the first question of
  // every call that does not connect.
  const participant = (p: RemoteParticipant, joined: boolean) => {
    console.warn('[call] sfu participant', joined ? 'joined' : 'left', p.identity,
      'room now', room.remoteParticipants.size + 1);
    try { a.onParticipant?.(p, joined); } catch (err) {
      console.warn('[call] onParticipant handler threw —', (err as any)?.message ?? err);
    }
  };
  room.on(RoomEvent.ParticipantConnected, p => participant(p, true));
  room.on(RoomEvent.ParticipantDisconnected, p => participant(p, false));
  room.on(RoomEvent.ConnectionStateChanged, st => console.warn('[call] sfu room state →', st));
  // These two split the one question that matters when a call joins and stays
  // silent: did we never HEAR about the other side's track (signalling), or did
  // we hear about it and never receive it (the subscriber transport)?
  room.on(RoomEvent.TrackPublished, (pub, p) =>
    console.warn('[call] sfu remote published', pub.kind, 'by', p.identity, '— awaiting subscribe'));
  room.on(RoomEvent.TrackSubscriptionFailed, (sid, p, reason) =>
    console.warn('[call] sfu SUBSCRIBE FAILED', sid, 'from', p.identity, '—', String(reason)));
  if (a.onDisconnected) room.on(RoomEvent.Disconnected, a.onDisconnected);
  // The SFU's equivalent of `ontrack`, and the only signal that says a call on
  // this transport is actually up. Without it a call joins a room, publishes,
  // and sits in "calling…" until the ring budget hangs it up.
  let crypto: FrameCryptoHandle | null = null;

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
    // NOTHING in here may throw. This handler is invoked from inside the SDK's
    // event emitter, so an exception does not just skip the rest of this
    // function — it unwinds into livekit-client's own subscription handling.
    // The call then has a remote track the app never hears about, sits in
    // "ringing" with media flowing underneath, and dies on the ring timeout.
    let url: string | null = null;
    try {
      // A receiver exists only once its track is subscribed, so THIS is the
      // moment its cryptor can be created. Without it every incoming frame
      // stays ciphertext and the remote video is noise or nothing at all.
      crypto?.attach();
    } catch (err) {
      console.warn('[call] frame cryptor attach failed on subscribe —', (err as any)?.message ?? err);
    }
    try { url = (track.mediaStream as any)?.toURL?.() ?? null; } catch {}
    const kind = track.kind === Track.Kind.Video ? 'video' : 'audio';
    // Logged because this is the event that decides whether a call is
    // "connected". Its absence was indistinguishable from a dead SFU.
    console.warn('[call] sfu track subscribed —', kind, 'from', p.identity, url ? 'with stream' : 'NO STREAM URL');
    try { a.onTrack?.(p.identity, url, kind); } catch (err) {
      console.warn('[call] onTrack handler threw —', (err as any)?.message ?? err);
    }
  });
  // A reconnect rebuilds the transports, and the new senders/receivers come up
  // bare. Re-attaching is idempotent — the handle skips what it already covers.
  room.on(RoomEvent.Reconnected, () => { crypto?.attach(); });

  await room.connect(a.url, a.token);

  // The key provider must exist BEFORE anything is published — see the publish
  // block below, which keeps the tracks silent until their cryptors are on.
  if (a.e2eeKey) {
    // BOTH transports. LiveKit publishes on one peer connection and subscribes
    // on another; attaching to only the publisher encrypts what we send and
    // leaves everything we receive undecryptable.
    const pcs = () => {
      const e: any = room.engine as any;
      return [
        e?.pcManager?.publisher?.pc ?? e?.publisher?.pc,
        e?.pcManager?.subscriber?.pc ?? e?.subscriber?.pc,
      ].filter(Boolean);
    };
    crypto = await enableFrameCrypto(pcs, a.identity, a.e2eeKey);
    if (!crypto.active) {
      // A call that believes it is encrypted but is not must not proceed
      // quietly. Broadcast never reaches here — it passes e2eeKey: null.
      await room.disconnect();
      throw new Error('Secure calling is unavailable on this device');
    }
  }

  // Held so screen share can swap what it carries without republishing.
  let published: LocalVideoTrack | null = null;
  let attached = 0;

  if (a.publish) {
    const own = (a.tracks ?? []).filter((t: any) => t?.kind === 'audio' || (a.video && t?.kind === 'video'));
    if (own.length) {
      // PUBLISH SILENT, THEN ENCRYPT, THEN UNMUTE.
      //
      // A sender does not exist until publishTrack resolves, and the cryptor
      // can only be attached to a sender — so there is an unavoidable window
      // between "sending" and "encrypted". Disabling the track first makes that
      // window carry silence and black frames instead of the room's audio and
      // the user's camera. `enabled` is restored to what the engine had it at,
      // so a call started while muted stays muted.
      const wasEnabled = new Map<any, boolean>(own.map((t: any) => [t, t.enabled !== false]));
      for (const t of own) { try { t.enabled = false; } catch {} }
      try {
        for (const t of own) {
          // THE SOURCE MUST BE DECLARED, or the SDK refuses before the server
          // is ever asked.
          //
          // A LocalTrack built from a MediaStreamTrack we captured ourselves has
          // source = Unknown, and livekit-client checks
          // `canPublishSources.includes(track.source)` locally — our grant lists
          // camera/microphone/screen_share, so Unknown is not in it and
          // publishTrack throws "failed to publish track, insufficient
          // permissions" with nothing at all in the server log. Measured on
          // device: every call fell back to the mesh for this one reason.
          //
          // Widening the grant to an empty (= allow-all) source list would also
          // "fix" it, and would quietly destroy the audience guarantee the grant
          // exists for. Declaring the source is the honest half.
          if (t.kind === 'audio') {
            const audio = new LocalAudioTrack(t);
            audio.source = Track.Source.Microphone;
            await room.localParticipant.publishTrack(audio, { source: Track.Source.Microphone });
          } else {
            published = new LocalVideoTrack(t);
            published.source = Track.Source.Camera;
            await room.localParticipant.publishTrack(published, { source: Track.Source.Camera });
          }
        }
        attached = crypto?.attach() ?? 0;
      } finally {
        for (const t of own) { try { t.enabled = wasEnabled.get(t) ?? true; } catch {} }
      }
    } else {
      await room.localParticipant.setMicrophoneEnabled(true);
      if (a.video) await room.localParticipant.setCameraEnabled(true);
      attached = crypto?.attach() ?? 0;
    }

    // Publishing with nothing attached is the silent downgrade this whole file
    // exists to prevent: the call would work perfectly and the server would be
    // able to read it. Refuse instead — the engine then degrades to the mesh,
    // which is peer-to-peer and encrypted by construction.
    if (a.e2eeKey && attached === 0) {
      await room.disconnect();
      throw new Error('Secure calling is unavailable on this device');
    }
  }

  return {
    room,
    crypto,
    async replaceVideo(track: any) {
      const vid = published
        ?? (room.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined)
        ?? null;
      if (!vid || !track) return false;
      // userProvidedTrack: the engine owns this track's lifetime — it stops the
      // screen capture itself and restores the camera afterwards. Letting the
      // SDK adopt it would have it stopped underneath the engine.
      await vid.replaceTrack(track, true);
      published = vid;
      return true;
    },
    setRemoteAudible(audible: boolean) {
      try {
        room.remoteParticipants.forEach(p => {
          p.audioTrackPublications.forEach(pub => {
            const t: any = pub.track?.mediaStreamTrack;
            if (t) t.enabled = audible;
          });
        });
      } catch {}
    },
    async leave() {
      try { await crypto?.dispose(); } catch {}
      try { await room.disconnect(); } catch {}
    },
  };
}

/** Track sources worth rendering, in the order a UI should prefer them. */
export const RENDER_SOURCES = [Track.Source.ScreenShare, Track.Source.Camera];

export default { joinSfuRoom };
