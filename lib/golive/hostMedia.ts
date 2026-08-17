// lib/golive/hostMedia.ts — the Go Live host's camera, microphone and screen.
//
// WHY THIS IS NOT lib/call/room.ts setScreenShare
// -----------------------------------------------
// That one belongs to calling. It drives the call engine's own capture, restores
// the camera through replaceTrack when a share stops, and coordinates with the
// mesh↔SFU fallback and the frame cryptor. Go Live has none of that: one
// publisher, no mesh, no encryption (egress must be able to read the frames), and
// screen share is an ADDITIONAL publication rather than a swap of the camera
// track — so the audience can keep seeing the host while a screen is shared,
// which is what a broadcast wants and a 1:1 call does not.
//
// Reaching into the call engine to get that would mean changing working code for
// a different product's requirement. This is the separate path instead. Nothing
// in lib/call is imported, called, or modified.
//
// WHAT IS DELIBERATELY COPIED, AND WHY
// ------------------------------------
// The encoder settings. They are not preference — they are the fix for a defect
// documented at length in lib/call/room.ts:304: a phone screen is 1080x2400 and
// hardware H.264 encoders silently produce NO OUTPUT for dimensions that are not
// a multiple of 16. The publication completes, subscribers subscribe, and not one
// frame is ever sent. VP8 accepts the odd geometry; dropping simulcast leaves one
// encoder to satisfy instead of three; bounding capture to 720p15 keeps it inside
// what every encoder on the market takes.
//
// Rediscovering that on the Go Live path would mean shipping the same bug twice.

import { Track } from 'livekit-client';
import type { Room } from 'livekit-client';
import {
  beforeScreenShare, afterScreenShareConsent, reassertWindowSecure, stopBroadcastService,
} from './native';

/** What the host is currently sending. Rendered by the control bar. */
export interface HostMediaState {
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

export function hostMediaState(room: Room): HostMediaState {
  const p = room.localParticipant;
  return {
    mic: p.isMicrophoneEnabled,
    camera: p.isCameraEnabled,
    screen: p.isScreenShareEnabled,
  };
}

export async function setMic(room: Room, on: boolean): Promise<void> {
  await room.localParticipant.setMicrophoneEnabled(on);
}

/**
 * Camera on/off — by MUTING an existing publication rather than tearing it down.
 *
 * WHY NOT JUST setCameraEnabled(false)
 * ------------------------------------
 * That unpublishes, which makes livekit-client remove the sender from the
 * publisher PeerConnection. Measured on a Honor ELI-NX9 against prod, three runs
 * on one build:
 *
 *   joined WITH camera, toggled off          → clean
 *   joined WITH camera, toggled on then off  → clean
 *   joined WITHOUT camera, toggled on/off    → "failed to remove track:
 *                                              Sender does not belong to this
 *                                              peer connection", then the room
 *                                              dropped to reconnecting
 *
 * The difference is whether the publisher had a video transceiver AT JOIN. When
 * it does not, the first video track added afterwards renegotiates one into
 * existence and the sender livekit-client cached no longer matches the peer
 * connection, so removal throws. The reconnect that follows is what broke a
 * screen share started straight after — the room was still recovering.
 *
 * That path became the common one the moment a camera-off host stopped
 * publishing video at join, so this is the removal that had to stop happening.
 *
 * MUTE INSTEAD. The publication and its transceiver stay put, nothing is
 * removed, nothing renegotiates, and the SDK sets mediaStreamTrack.enabled =
 * false so no frames leave the device. Unmuting is then just as cheap, which
 * also makes repeated toggling free rather than a renegotiation each way.
 *
 * The first enable still has to publish for real — there is nothing to unmute
 * yet — and that add is not the operation that fails.
 */
export async function setCamera(room: Room, on: boolean): Promise<void> {
  const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);

  if (!on) {
    // Nothing published (a camera-off host who never turned it on) is already
    // the desired state — and calling setCameraEnabled(false) there is exactly
    // the no-op that used to trip the stale-sender path.
    if (pub?.track) { await pub.mute(); return; }
    return;
  }

  if (pub?.track) { await pub.unmute(); return; }
  await room.localParticipant.setCameraEnabled(true);
}

/**
 * Start or stop the host's screen share.
 *
 * The camera publication is left alone: on platforms that allow simultaneous
 * tracks the audience receives both, and egress composites whichever is
 * speaking. That is the "camera can continue where the platform supports it"
 * requirement, and it falls out of publishing a second source rather than
 * swapping the first.
 *
 * Throws on refusal — a user who declines the system capture prompt, or a build
 * without screen capture — so the caller can say what happened instead of
 * leaving a button stuck in the "sharing" state.
 */
export async function setScreenShare(room: Room, on: boolean): Promise<void> {
  if (!on) {
    await room.localParticipant.setScreenShareEnabled(false);
    // Nothing to restore — the flag was never lowered. Re-asserted anyway, for
    // the one case that is real: a device still carrying an older build that
    // DID lower it. Same belt-and-braces as lib/call/engine.ts stopScreenShare.
    await reassertWindowSecure();
    return;
  }

  // The foreground service must carry mediaProjection before Android will let
  // anything capture. FLAG_SECURE is deliberately left ON — VaultChat's own
  // window is excluded from the capture and every other app records normally.
  // See lib/golive/native.ts.
  await beforeScreenShare();

  try {
    await room.localParticipant.setScreenShareEnabled(
      true,
      { resolution: { width: 1280, height: 720, frameRate: 15 }, contentHint: 'detail', audio: false },
      { videoCodec: 'vp8', simulcast: false, videoEncoding: { maxBitrate: 1_500_000, maxFramerate: 15 } },
    );
  } catch (err) {
    // The user declined the system capture prompt, or the platform refused.
    // Rethrown so the caller can un-stick its "sharing" button; the re-assert
    // is defensive only, since nothing here ever lowered the flag.
    await reassertWindowSecure();
    throw err;
  }

  // AGAIN, after consent. Android 14+ refuses to grant the mediaProjection
  // service type until a projection actually exists, so the promotion before
  // the dialog was a no-op there — while 10-13 needed exactly that one. Both
  // calls are idempotent; between them every version is covered.
  await afterScreenShareConsent();

  // TUNE FOR TEXT, NOT FOR MOTION.
  //
  // An untuned encoder treats a screen like a camera: it protects frame rate and
  // throws away resolution the moment bandwidth dips, so shared code and slides
  // turn to mush — while a screen that is mostly static needs almost no frames.
  //
  // Best-effort throughout: React Native's WebRTC does not implement every knob,
  // and a share that is merely untuned is still a working share. A throw here
  // would turn "slightly soft" into "screen sharing is broken".
  const track: any = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
  try { if (track?.mediaStreamTrack) track.mediaStreamTrack.contentHint = 'detail'; } catch {}
  try {
    const sender = track?.sender;
    const params = sender?.getParameters?.();
    if (params?.encodings?.length) {
      params.degradationPreference = 'maintain-resolution';
      // SCALE AT THE ENCODER, because capture cannot be constrained: Android's
      // getDisplayMedia ignores the resolution constraint above and hands back
      // the panel's native geometry. Halving each dimension quarters the pixel
      // count and leaves the bitrate to spend on sharpness instead of size.
      params.encodings[0].scaleResolutionDownBy = 2;
      params.encodings[0].maxBitrate = 2_500_000;
      params.encodings[0].maxFramerate = 15;
      await sender.setParameters(params);
    }
  } catch (err) {
    console.warn('[GOLIVE] screen share: could not tune the encoder —', (err as any)?.message ?? err);
  }
}

/**
 * Stop everything the host is publishing.
 *
 * Called when a broadcast ends. Without the explicit screen-share stop, Android
 * keeps the capture session — and its persistent "recording" notification —
 * alive after the room is gone, which reads to the user as VaultChat still
 * watching their screen.
 */
export async function stopAllHostMedia(room: Room): Promise<void> {
  try { await room.localParticipant.setScreenShareEnabled(false); } catch {}
  try { await room.localParticipant.setCameraEnabled(false); } catch {}
  try { await room.localParticipant.setMicrophoneEnabled(false); } catch {}
  // Defensive only — this code never lowers FLAG_SECURE. It covers a device
  // still running an older build that did, which would otherwise stay
  // capturable until the next launch. Setting a flag that is already set is free.
  await reassertWindowSecure();
  await stopBroadcastService();
}

/**
 * The host's local camera track, as a stream URL for RTCView.
 *
 * Returns null before capture starts, while the camera is off, and during a
 * screen-only broadcast — every one of which is a legitimate state, so the
 * caller renders a placeholder rather than treating null as a failure.
 */
export function localPreviewURL(room: Room): string | null {
  try {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    // MUTED COUNTS AS OFF. Camera-off now mutes instead of unpublishing (see
    // setCamera), so the publication outlives the "off" state — and its last
    // captured frame stays renderable. Returning it would leave the host
    // looking at a frozen still of themselves after turning the camera off,
    // which reads as a stuck preview rather than a camera that is off.
    if (!pub || pub.isMuted) return null;
    const t: any = pub.track;
    return t?.mediaStream?.toURL?.() ?? null;
  } catch { return null; }
}

export default {
  hostMediaState, setMic, setCamera, setScreenShare, stopAllHostMedia, localPreviewURL,
};
