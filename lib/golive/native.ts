// lib/golive/native.ts — the Android platform work a broadcast needs.
//
// Every function here is BEST-EFFORT and never throws. A missing native module
// (iOS, or an old build that predates plugins/withVaultChatGoLive.js) must
// degrade the broadcast, not fail it: camera and microphone still publish while
// the app is in the foreground, which is a usable stream.
//
// WHY ANY OF THIS IS NEEDED
// -------------------------
// Two Android behaviours, both silent from the host's side:
//
//  1. Android 12+ revokes microphone and camera capture seconds after the app
//     is backgrounded unless a foreground service of the matching type is
//     running. A host who checks a message mid-stream goes silent and black
//     while the banner still reads LIVE to every viewer.
//
//  2. Android 10+ refuses MediaProjection.createVirtualDisplay() unless a
//     foreground service of type mediaProjection is running. Without one the
//     encoder produces `encoded=0 size=0x0` — no frames at all — however
//     correct everything else is.
//
// FLAG_SECURE is deliberately NOT one of them: crazzychat's own window stays
// protected and Android simply excludes it from the capture, which is the
// product rule. See beforeScreenShare below.
//
// The call engine solves the same two problems for CALLS (lib/call/engine.ts,
// CallForegroundService). None of that applies here: those hang off the call
// lifecycle, and during a broadcast there is no call.

import { NativeModules, Platform } from 'react-native';
import { noteWindowSecure } from '../screenGuard';

/** com.vaultchat.app.golive.GoLiveModule. Null on iOS and on older builds. */
const GoLive: any = (NativeModules as any).VaultGoLive ?? null;

/**
 * VaultCalls, used for ONE thing: setWindowSecure.
 *
 * FLAG_SECURE is a property of the activity window, not of calling — the method
 * takes a boolean and holds no call state. Calling it is reuse; duplicating it
 * in GoLiveModule would give one window flag two owners, and they would fight
 * the moment a call and a broadcast overlapped. Nothing in lib/call is imported
 * and nothing in CallModule.kt is modified.
 */
const VaultCalls: any = (NativeModules as any).VaultCalls ?? null;

export const goLiveNativeAvailable = Platform.OS === 'android' && GoLive != null;

/**
 * Hold a foreground service for the life of the broadcast.
 *
 * Call as soon as the host has published — not when the screen opens — so a
 * broadcast that never starts does not leave a notification on the shade.
 */
export async function startBroadcastService(title: string): Promise<void> {
  try { await GoLive?.startBroadcastService?.(title); } catch {}
}

export async function stopBroadcastService(): Promise<void> {
  try { await GoLive?.stopBroadcastService?.(); } catch {}
}

/**
 * Make screen capture legal.
 *
 * FLAG_SECURE IS LEFT ALONE — crazzychat is never made capturable.
 *
 * Android excludes a SECURE window from the capture and records everything else
 * normally, which is exactly the product rule: the host's own crazzychat screens
 * stay protected while Chrome, Maps, a gallery or a game share fine. The host
 * starts the broadcast and switches away; what they switch TO is what the
 * audience sees.
 *
 * This used to clear the flag, on the theory that a secure window produces no
 * frames at all. lib/call/engine.ts:631 records that the calling side tried
 * exactly that and backed it out as "the wrong trade even if it worked" — it
 * makes the app's own messages capturable for the duration of every share. That
 * trade is worse here than in a call: a call has one peer, a broadcast has an
 * unbounded audience, so a host who glanced at a chat mid-share would show it to
 * everyone watching.
 *
 * Capture still works. room.ts measured it: zero frames while crazzychat's secure
 * window is the only thing on screen, frames the moment the host switches to the
 * app they actually meant to show.
 *
 * ORDER, which is not obvious: the mediaProjection service type is asked for
 * TWICE — now, which is what Android 10-13 require, and again after consent,
 * which is the only moment 14+ permits it. Both are idempotent.
 */
export async function beforeScreenShare(): Promise<void> {
  try { await GoLive?.allowScreenCapture?.(); } catch {}
}

export async function afterScreenShareConsent(): Promise<void> {
  try { await GoLive?.allowScreenCapture?.(); } catch {}
}

/**
 * Re-assert FLAG_SECURE. Only ever sets it ON; nothing here turns it off.
 *
 * A no-op in the normal case, because the flag is never lowered. Kept as
 * belt-and-braces for one real situation: an older build DID lower it, and a
 * device carrying that build would otherwise stay capturable until the next
 * launch. Mirrors what lib/call/engine.ts stopScreenShare does, for the same
 * reason.
 */
export async function reassertWindowSecure(): Promise<void> {
  if (typeof VaultCalls?.setWindowSecure !== 'function') return;
  // Reported to lib/screenGuard (this path bypasses setSecure) so its status reads true.
  try { await VaultCalls.setWindowSecure(true); noteWindowSecure(true); } catch {}
}

export default {
  goLiveNativeAvailable,
  startBroadcastService,
  stopBroadcastService,
  beforeScreenShare,
  afterScreenShareConsent,
  reassertWindowSecure,
};
