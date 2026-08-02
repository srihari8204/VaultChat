// lib/call/media.ts — local capture and audio routing, in one place.
//
// Transcribed from the shipped call screens; the behaviour is deliberately
// identical, only the ownership moves:
//   • InCallManager owns the audio route. `auto: true` follows wired/Bluetooth
//     headsets. Voice defaults to earpiece (private), video to speaker.
//   • `setForceSpeakerphoneOn(null)` — NOT false — when turning speaker off, so
//     a connected headset keeps the route instead of being forced to earpiece.
//   • Screen share swaps the outgoing track via RTCRtpSender.replaceTrack(), so
//     the peer sees the screen with no renegotiation and no call drop.
//
// Everything acquired here is released by dispose(), which the engine's single
// disposal registry calls. That is the fix for the leak class where a crash or
// a replaced call left a live MediaStream holding native camera buffers.

import InCallManager from 'react-native-incall-manager';
import { mediaDevices } from '@livekit/react-native-webrtc';
import type { CallKind } from './types';

export interface LocalMedia {
  stream: any;
  /** streamURL for the self-preview, or null for an audio call. */
  url: string | null;
}

/** Start the audio session for a call of this kind. Safe to call twice. */
export function startAudioSession(kind: CallKind): void {
  try {
    InCallManager.start({ media: kind === 'video' ? 'video' : 'audio', auto: true });
    InCallManager.setForceSpeakerphoneOn(kind === 'video' ? true : false);
  } catch { /* not fatal: the call still works on the default route */ }
}

export function stopAudioSession(): void {
  try { InCallManager.stop(); } catch {}
}

/**
 * Speaker on/off. `null` when turning OFF is intentional — it hands the route
 * back to InCallManager so a Bluetooth or wired headset stays selected.
 */
export function setSpeaker(on: boolean): void {
  try { InCallManager.setForceSpeakerphoneOn(on ? true : null); } catch {}
}

/** Re-assert the route after a held call is resumed. */
export function resumeAudioSession(kind: CallKind, speaker: boolean): void {
  try {
    InCallManager.start({ media: kind === 'video' ? 'video' : 'audio', auto: true });
    InCallManager.setForceSpeakerphoneOn(speaker ? true : null);
  } catch {}
}

export async function acquireLocalMedia(kind: CallKind): Promise<LocalMedia> {
  const stream: any = await mediaDevices.getUserMedia(
    kind === 'video'
      ? ({ audio: true, video: { facingMode: 'user' } } as any)
      : { audio: true, video: false },
  );
  let url: string | null = null;
  if (kind === 'video') { try { url = stream.toURL(); } catch {} }
  return { stream, url };
}

export function setMicEnabled(stream: any, enabled: boolean): void {
  try { stream?.getAudioTracks?.().forEach((t: any) => { t.enabled = enabled; }); } catch {}
}

export function setCameraEnabled(stream: any, enabled: boolean): void {
  try { stream?.getVideoTracks?.().forEach((t: any) => { t.enabled = enabled; }); } catch {}
}

export function flipCamera(stream: any): void {
  try { stream?.getVideoTracks?.().forEach((t: any) => t._switchCamera?.()); } catch {}
}

/** Silence/restore what we RECEIVE — used by call-waiting hold. */
export function setRemoteAudible(pc: any, audible: boolean): void {
  try { pc?.getReceivers?.().forEach((r: any) => { if (r.track) r.track.enabled = audible; }); } catch {}
}

export function stopStream(stream: any): void {
  try { stream?.getTracks?.().forEach((t: any) => t.stop()); } catch {}
}

export const isScreenShareSupported = (): boolean =>
  typeof (mediaDevices as any).getDisplayMedia === 'function';

/** Prompts the system capture consent dialog. Throws if denied/cancelled. */
export async function acquireScreenStream(): Promise<any> {
  return (mediaDevices as any).getDisplayMedia();
}

export default {};
