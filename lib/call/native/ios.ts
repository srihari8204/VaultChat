// lib/call/native/ios.ts — iOS implementation of NativeCallAdapter.
//
// HONEST STATUS: not implemented. Every method is a no-op, and
// `canRingWhenKilled` is FALSE so the UI can tell the truth rather than promise
// a ring that will not arrive. This file exists so the shape of the gap is
// visible in code instead of living only in a document, and so landing CallKit
// is filling in a file rather than reworking the call pipeline.
//
// The out-of-band ring still WORKS as far as the backend is concerned: the Go
// sender already emits APNs VoIP headers through FCM's bridge
// (internal/fcm/fcm.go — apns-push-type: voip, apns-priority: 10, apns-topic:
// <bundle>.voip). What is missing is entirely on the device.
//
// WHAT LANDING THIS REQUIRES — in order, and none of it can be written blind:
//
//  1. Apple credentials: a paid developer account, an APNs auth key, and a VoIP
//     push certificate uploaded to the Firebase project (FCM delivers the VoIP
//     push, so the certificate lives with Firebase, not in this repo).
//
//  2. A Swift PushKit registrar: PKPushRegistry with desiredPushTypes = [.voIP].
//     Register the resulting token so FCM can address the device.
//
//  3. A CallKit provider: CXProvider + CXProviderDelegate. In
//     pushRegistry(_:didReceiveIncomingPushWith:for:completion:) the call MUST
//     be reported via reportNewIncomingCall() SYNCHRONOUSLY. This is not a
//     style preference — iOS permanently revokes an app's VoIP push privileges
//     if it accepts a VoIP push and fails to report a call.
//
//  4. Audio: start WebRTC audio in provider(_:didActivate:), not before.
//     CallKit owns the AVAudioSession; taking it early fails or gets clobbered.
//
//  5. Re-enable the entitlement: plugins/withVaultChatCalls.js currently keeps
//     `voip` OUT of UIBackgroundModes behind IOS_CALLKIT_IMPLEMENTED=false,
//     because declaring it without the above is itself a rejection trigger.
//     That constant and this file flip together, in one change.
//
// A starting AppDelegate sketch is in CALLS_README.md; it has never been
// applied or compiled. See docs/IOS_PARITY.md for the full runbook.

import type { IncomingCallIntent, NativeCallAdapter } from './types';

export const iosAdapter: NativeCallAdapter = {
  platform: 'ios',
  // Flip to true ONLY with steps 1-5 above actually done and device-tested.
  canRingWhenKilled: false,

  // register() is intentionally NOT a throw: the app must keep working on iOS
  // with in-app calling (foreground, socket-delivered) even before CallKit.
  async register(): Promise<void> { /* PushKit registration — see header */ },

  startCallSession(): void { /* CallKit owns the audio session — see header */ },
  endCallSession(): void { /* CXEndCallAction */ },
  dismissIncomingUi(): void { /* CallKit dismisses its own UI */ },

  // The backend push path already works; only local presentation is missing, so
  // reporting "not delivered" here would be inaccurate. The engine treats the
  // return value as advisory (the socket ring is the primary path).
  async ringPeer(): Promise<boolean> { return false; },
  async cancelRing(): Promise<void> { /* handled server-side by /call/cancel */ },

  async consumeLaunchIntent(): Promise<IncomingCallIntent | null> { return null; },
  async consumeDeclinedCall(): Promise<string | null> { return null; },
};

export default iosAdapter;
