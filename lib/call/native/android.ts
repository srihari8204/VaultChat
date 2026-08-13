// lib/call/native/android.ts — Android implementation of NativeCallAdapter.
//
// A thin pass-through to lib/CallService, which is the existing, proven bridge
// to plugins/android/CallModule.kt. Nothing is reimplemented here: the point of
// this file is only to present that bridge behind the shared interface, so the
// engine has no Platform.OS branch in it.

import {
  cancelCall, dismissIncomingNotification, drainDeclinedCall, getInitialCallIntent,
  initiateCall, registerForCalls, startCallForeground, stopCallForeground,
} from '../../CallService';
import type { IncomingCallIntent, NativeCallAdapter } from './types';

export const androidAdapter: NativeCallAdapter = {
  platform: 'android',
  // Real: a data-only high-priority FCM message starts VaultCallMessagingService
  // from a cold start with no JS runtime, and it posts a CATEGORY_CALL
  // full-screen-intent notification.
  canRingWhenKilled: true,

  // The outcome is dropped here on purpose: the adapter interface is the
  // platform seam, and a push-provider result is Android-shaped detail that iOS
  // (CallKit/PushKit) will not have. Callers that want it — app/_layout.tsx —
  // call registerForCalls() directly and read lib/pushRegistration.
  register: async () => { await registerForCalls(); },

  startCallSession: ({ callId, peerName, peerPhotoUrl, isVideo }) =>
    startCallForeground(callId, peerName, peerPhotoUrl ?? '', isVideo),

  endCallSession: () => stopCallForeground(),

  dismissIncomingUi: () => dismissIncomingNotification(),

  ringPeer: (p) => initiateCall(p),

  cancelRing: (calleeId, callId) => cancelCall(calleeId, callId),

  consumeLaunchIntent: () => getInitialCallIntent() as Promise<IncomingCallIntent | null>,

  consumeDeclinedCall: () => drainDeclinedCall(),
};

export default androidAdapter;
