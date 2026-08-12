// lib/CallService.ts — JS orchestration for the native call subsystem.
//
// Bridges to the native VaultCalls module (plugins/android/CallModule.kt):
//   • registerForCalls()      — push the FCM token to /call/token + give native
//                               the API base + JWT so it can fetch the caller DP.
//   • startCallForeground()   — promote to mic/camera foreground service so audio
//                               survives backgrounding.
//   • stopCallForeground()    — end the service + release the wake lock.
//   • initiateCall/cancelCall — ring/dismiss the callee via the backend FCM push.
//   • drainDeclinedCall()     — pick up a decline made from the lock-screen
//                               notification while the app was killed.
//
// Graceful: every native call is guarded so the app still runs in Expo Go / web
// (where the native module is absent).

import { NativeModules, Platform } from 'react-native';
import { api, getAccessToken } from './api';
import { SERVER_URL } from '../constants/server';
import {
  pushRetryDelayMs, setPushOutcome, shouldRetryPush, type PushOutcome,
} from './pushRegistration';

const VaultCalls: any = NativeModules.VaultCalls ?? null;
const has = () => Platform.OS === 'android' && !!VaultCalls;

/** One registration attempt. Classifies the outcome; never throws. */
async function attemptRegister(): Promise<PushOutcome> {
  if (!has()) return 'no_platform';

  let token: string | null = null;
  try {
    token = await VaultCalls.getFcmToken();
  } catch {
    // The provider itself could not issue a token. On Android that means Play
    // Services is missing, disabled or too old — a device with no GMS at all
    // (Huawei post-2019) lands here on every attempt. It is a permanent fact
    // about the install, not a transient error, so it must NOT be retried.
    return 'no_provider';
  }
  if (!token) return 'no_provider';

  const access = await getAccessToken();
  if (!access) return 'not_signed_in';

  // Let the native FCM service fetch the caller DP for the ring notification.
  try { VaultCalls.setApiContext(SERVER_URL, access); } catch {}

  try {
    await api('/call/token', { method: 'POST', json: { fcmToken: token, platform: 'android' } });
    return 'ok';
  } catch {
    // Network still coming up at boot, or the server is briefly unhappy. Worth
    // another try — this is the case the old one-shot silently lost.
    return 'transient';
  }
}

/**
 * Register this device for call wake-ups. Call after sign-in + on app start.
 *
 * Retries transient failures and RECORDS the outcome, neither of which it used
 * to do. The previous version was a one-shot whose every failure vanished behind
 * `if (__DEV__)`, so in a release build a phone that booted without network
 * registered no token for the whole session, rang for nothing while killed, and
 * left no trace of why. See lib/pushRegistration.ts.
 *
 * Resolves with the final outcome; never rejects. The push is a DOORBELL only —
 * signalling is a socket and media is peer-to-peer — so a failure here degrades
 * "rings while closed" and nothing else. That is why this stays off the critical
 * path and is safe to leave unawaited.
 */
export async function registerForCalls(): Promise<PushOutcome> {
  let outcome: PushOutcome = 'transient';
  for (let attempt = 0; ; attempt++) {
    outcome = await attemptRegister();
    if (!shouldRetryPush(outcome, attempt)) break;
    await new Promise(r => setTimeout(r, pushRetryDelayMs(attempt + 1)));
  }

  setPushOutcome(outcome);
  // Logged in RELEASE too, deliberately: this is exactly the state that was
  // invisible before, and "calls don't ring when the app is closed" is
  // undiagnosable without it. One line per app start — no volume concern.
  if (outcome === 'ok') console.warn('[push] registered for call wake-ups');
  else console.warn(`[push][FAIL] stage=REGISTER code=${outcome.toUpperCase()} wakeable=false`);
  return outcome;
}

/** Keep audio alive while a call is connected. */
export function startCallForeground(callId: string, otherName: string, otherDpUrl: string, isVideo: boolean): void {
  if (!has()) return;
  try { VaultCalls.startCallService(callId, otherName || 'VaultChat call', otherDpUrl || '', !!isVideo); } catch {}
}

export function stopCallForeground(): void {
  if (!has()) return;
  try { VaultCalls.stopCallService(); } catch {}
}

/** Cancel the native incoming-call notification (when answered/handled in-app). */
export function dismissIncomingNotification(): void {
  if (!has()) return;
  try { VaultCalls.dismissIncoming(); } catch {}
}

/** Ring the callee (sends the high-priority data push from the backend).
 *  Doorbell only (F6): the SDP never rides in the push — it carries the
 *  DTLS-SRTP fingerprint and the callee gets it over the socket anyway. */
export async function initiateCall(p: { calleeId: string; callId: string; isVideo: boolean }): Promise<boolean> {
  try {
    const r = await api<{ ok: boolean; delivered?: boolean }>('/call/initiate', {
      method: 'POST',
      json: { calleeId: p.calleeId, callId: p.callId, isVideo: p.isVideo },
    });
    return !!r?.delivered;
  } catch { return false; }
}

export async function cancelCall(calleeId: string, callId: string): Promise<void> {
  try { await api('/call/cancel', { method: 'POST', json: { calleeId, callId } }); } catch {}
}

/** A decline tapped on the lock-screen notification while the app was killed.
 *  Returns the callId so the caller can be notified over the socket on launch. */
export async function drainDeclinedCall(): Promise<string | null> {
  if (!has()) return null;
  try { return (await VaultCalls.consumeDeclinedCall()) || null; } catch { return null; }
}

export type InitialCallIntent = {
  action: 'incoming_call' | 'answer' | 'open_chat' | string;
  callId?: string; callerId?: string; callerName?: string; isVideo?: boolean;
  chatId?: string;   // set for action 'open_chat' (message-notification tap, F2)
};

/** If the app was opened by tapping the full-screen call notification, returns
 *  the call to route to (once). Null otherwise. */
export async function getInitialCallIntent(): Promise<InitialCallIntent | null> {
  if (!has()) return null;
  try { return (await VaultCalls.getInitialCallIntent()) || null; } catch { return null; }
}

export default {
  registerForCalls, startCallForeground, stopCallForeground,
  dismissIncomingNotification, initiateCall, cancelCall, drainDeclinedCall, getInitialCallIntent,
};
