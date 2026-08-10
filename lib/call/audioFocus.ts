// lib/call/audioFocus.ts — survive a carrier call, an alarm, or an assistant.
//
// Android grants ONE app the audio at a time. When a GSM call arrives mid-call
// the OS takes focus away, and an app that ignores that keeps capturing and
// playing into a device that is no longer its own: the user hears the carrier
// call over VaultChat, the peer hears the room, and when the interruption ends
// nothing restores. That is the "the app went weird after a phone call" bug,
// and it is one of the few remaining ways a call can end up in a state the user
// cannot recover from without force-quitting.
//
// WHY THIS IS NOT IN engine.ts
// The native module reports what the OS did; the ENGINE decides what that means
// for the call. Keeping the seam here means the engine never branches on
// Platform.OS, and iOS — where CallKit owns the AVAudioSession and handles this
// itself — simply attaches nothing.

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type FocusState = 'interrupted' | 'resumed' | 'lost';

/**
 * Take audio focus and report changes. Returns a detach function.
 *
 * `onChange` fires on the JS thread and must be cheap: it runs while the OS is
 * mid-transition, and on some devices a slow handler here shows up as clipped
 * audio at the start of the carrier call.
 */
export function attachAudioFocus(onChange: (s: FocusState) => void): () => void {
  // iOS: CallKit owns the audio session and restores it itself; requesting
  // focus manually there fights the platform rather than helping it.
  if (Platform.OS !== 'android') return () => {};

  const mod: any = (NativeModules as any).VaultCalls;
  if (!mod?.acquireAudioFocus) return () => {};   // older build, no native half

  let emitter: NativeEventEmitter | null = null;
  let sub: any = null;
  try {
    emitter = new NativeEventEmitter(mod);
    sub = emitter.addListener('VaultCallAudioFocus', (e: any) => {
      const s = e?.state;
      if (s === 'interrupted' || s === 'resumed' || s === 'lost') onChange(s);
    });
    mod.acquireAudioFocus();
  } catch {
    // Never let audio-focus plumbing break a call that would otherwise work.
    try { sub?.remove?.(); } catch {}
    return () => {};
  }

  return () => {
    try { sub?.remove?.(); } catch {}
    try { mod.releaseAudioFocus?.(); } catch {}
  };
}

export default { attachAudioFocus };
