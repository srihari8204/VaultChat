// lib/golive/audio.ts — who owns the audio route during a broadcast.
//
// A COPY OF CALLING'S PROVEN PATTERN, NOT A SHARED MODULE.
//
// lib/call/media.ts does this for calls and is not to be touched, so the rules
// are restated here rather than imported. They are the same rules for the same
// reason; only the default route differs (see below).
//
// WHY THIS FILE HAD TO EXIST
// --------------------------
// Go Live called AudioSession.startAudioSession() and nothing else. That starts
// LiveKit's WebRTC audio session but leaves the ROUTE unmanaged, so nothing ever
// asked Android to use a connected Bluetooth headset. A host wearing earbuds
// broadcast from the phone's own mic and heard nothing through the buds.
//
// InCallManager is what owns the route on the calling side, and `auto: true` is
// the part that follows a wired or Bluetooth headset as it connects and
// disconnects mid-session.
//
// THE null-vs-false RULE, RESTATED BECAUSE IT IS THE WHOLE BUG
// -----------------------------------------------------------
// setForceSpeakerphoneOn takes three values and they are not two:
//
//   true  → FORCE the loudspeaker, overriding any headset
//   false → FORCE it off, pinning the earpiece, also overriding any headset
//   null  → release the force, so the route follows `auto: true`
//
// A broadcast wants the loudspeaker when there is nothing better and the
// HEADSET when there is. That is `null`, never `true` — forcing speaker is
// exactly what would silence the Bluetooth earbuds this exists to support.
// `media: 'video'` already makes the loudspeaker the unforced default, so the
// fallback comes for free.

import InCallManager from 'react-native-incall-manager';

/**
 * Take over the audio route for a broadcast.
 *
 * Safe to call twice — InCallManager.start() is idempotent, and the host path
 * can reach it again after a reconnect.
 *
 * Never throws: a broadcast on the default route is a working broadcast, and an
 * exception here would take down publishing over a routing preference.
 */
export function startBroadcastAudio(): void {
  try {
    // 'video' rather than 'audio': it makes the LOUDSPEAKER the default when no
    // headset is present, which is what a broadcast wants. 'audio' would default
    // to the earpiece, and a host talking to an audience is not holding the
    // phone to their ear.
    InCallManager.start({ media: 'video', auto: true });
    // Release the force so `auto: true` can do its job. See the rule above.
    InCallManager.setForceSpeakerphoneOn(null);
  } catch { /* the broadcast still works on whatever route Android picked */ }
}

/**
 * Hand the route back.
 *
 * Paired with startBroadcastAudio. Left running, InCallManager keeps the device
 * in communication mode after the broadcast ends — which on Android means media
 * from every other app stays ducked and routed as if a call were still up.
 */
export function stopBroadcastAudio(): void {
  try { InCallManager.stop(); } catch {}
}

/**
 * Force the loudspeaker on, or hand the route back to `auto`.
 *
 * `on ? true : null` — NOT `on` — for the same reason as above: turning the
 * speaker "off" must release the route to whatever headset is connected, not
 * pin it to the earpiece.
 */
export function setBroadcastSpeaker(on: boolean): void {
  try { InCallManager.setForceSpeakerphoneOn(on ? true : null); } catch {}
}
