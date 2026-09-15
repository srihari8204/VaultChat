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
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  pushRetryDelayMs, pushTokenFailureOutcome, setPushOutcome, shouldReregister, shouldRetryPush, type PushOutcome,
} from './pushRegistration';

const VaultCalls: any = NativeModules.VaultCalls ?? null;
const has = () => Platform.OS === 'android' && !!VaultCalls;

// What we last successfully told the server, so a rotation can be spotted.
// AsyncStorage, not SecureStore: an FCM token is a routing address, not a
// secret — it is useless without our server's credentials — and SecureStore
// reads are slow enough to matter on a path that runs at every foreground.
const LAST_TOKEN_KEY = 'push:lastRegisteredToken';
const LAST_OUTCOME_KEY = 'push:lastOutcome';

async function loadLast(): Promise<{ token: string | null; outcome: PushOutcome | null }> {
  try {
    const [token, outcome] = await Promise.all([
      AsyncStorage.getItem(LAST_TOKEN_KEY),
      AsyncStorage.getItem(LAST_OUTCOME_KEY),
    ]);
    return { token, outcome: (outcome as PushOutcome) ?? null };
  } catch {
    // Storage unavailable — treat as "never registered", which re-POSTs. A
    // duplicate registration is harmless; a missed one costs the user calls.
    return { token: null, outcome: null };
  }
}

/** One registration attempt. Classifies the outcome; never throws. */
async function attemptRegister(): Promise<PushOutcome> {
  if (!has()) return 'no_platform';

  let token: string | null = null;
  try {
    token = await VaultCalls.getFcmToken();
  } catch (error) {
    // The native bridge uses the same error code for provider and network
    // failures. A rejected token request does not establish missing GMS.
    return pushTokenFailureOutcome(error);
  }
  if (!token) return 'transient';

  const access = await getAccessToken();
  if (!access) return 'not_signed_in';

  // Let the native FCM service fetch the caller DP for the ring notification.
  try { VaultCalls.setApiContext(SERVER_URL, access); } catch {}

  try {
    await api('/call/token', { method: 'POST', json: { fcmToken: token, platform: 'android' } });
    // Remember WHAT was registered, so a later rotation is detectable. Written
    // only on success: recording a token we failed to deliver would make the
    // next foreground think the server already had it.
    try { await AsyncStorage.setItem(LAST_TOKEN_KEY, token); } catch {}
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
  // PERSISTED, so the decision to re-register survives a process restart. Without
  // it, a device that failed registration would look identical on next launch to
  // one that succeeded, and shouldReregister could not tell them apart.
  try { await AsyncStorage.setItem(LAST_OUTCOME_KEY, outcome); } catch {}
  // Logged in RELEASE too, deliberately: this is exactly the state that was
  // invisible before, and "calls don't ring when the app is closed" is
  // undiagnosable without it. One line per app start — no volume concern.
  if (outcome === 'ok') console.warn('[push] registered for call wake-ups');
  else console.warn(`[push][FAIL] stage=REGISTER code=${outcome.toUpperCase()} wakeable=false`);
  return outcome;
}

/**
 * Re-check registration cheaply. Safe to call on every app foreground.
 *
 * This is the half that was missing entirely. registerForCalls ran ONCE at boot,
 * so the three ordinary ways registration goes stale all went unnoticed:
 *
 *   • FCM rotated the token (reinstall, data clear, restore, expiry). The native
 *     onNewToken handler stored it and nothing ever sent it, so the server kept
 *     addressing a dead token and the phone quietly stopped ringing while killed.
 *   • The app booted with no network, so the initial attempt failed and nothing
 *     ever tried again for the life of the process.
 *   • The user signed in after launch, so the first attempt had no access token.
 *
 * Cheap by construction: it reads the current token (a local Firebase call) and
 * returns without a network request when nothing has changed, which is the case
 * on essentially every foreground.
 */
export async function refreshCallRegistration(): Promise<void> {
  if (!has()) return;
  let token: string | null = null;
  try { token = await VaultCalls.getFcmToken(); } catch { token = null; }

  const prev = await loadLast();
  if (token && token !== prev.token && prev.token) {
    console.warn('[push] FCM token rotated — re-registering');
  }
  if (!shouldReregister(prev, token)) return;
  await registerForCalls();
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
  action: 'incoming_call' | 'answer' | 'open_chat' | 'open_game' | string;
  callId?: string; callerId?: string; callerName?: string; isVideo?: boolean;
  /** True when the ring was for a GROUP call. Absent on older native builds,
   *  which is why the router treats undefined as 1:1 — the behaviour it had. */
  isGroup?: boolean;
  chatId?: string;   // set for action 'open_chat' (message-notification tap, F2)
  // set for action 'open_game' (VaultGames turn/invite tap) — the table to open
  game?: string; room?: string;
};

/** If the app was opened by tapping the full-screen call notification, returns
 *  the call to route to (once). Null otherwise. */
export async function getInitialCallIntent(): Promise<InitialCallIntent | null> {
  if (!has()) return null;
  try { return (await VaultCalls.getInitialCallIntent()) || null; } catch { return null; }
}


/**
 * Shrink the call to a Picture-in-Picture window.
 *
 * Back on a call screen used to END the call: the navigator pops the screen and
 * the screen's unmount hangs up. Every other calling app keeps talking in a
 * floating window, which is what the gesture means to a user.
 *
 * Resolves false when the OS refuses (no PiP support, permission off, or below
 * Android 8) so the caller can leave the call screen up instead of silently
 * doing nothing.
 */
export async function enterPipMode(): Promise<boolean> {
  if (!has()) return false;
  try { return !!(await VaultCalls.enterPip()); } catch { return false; }
}

/**
 * Android 14+: full-screen intents are a user-granted permission for anything
 * that is not the default dialer. Without it the ring is a heads-up banner
 * rather than a full-screen call UI on the lock screen — observed on device as
 * FSI_REQUESTED_BUT_DENIED on the ring notification.
 */
export async function canUseFullScreenIntent(): Promise<boolean> {
  if (!has()) return true;
  try { return !!(await VaultCalls.canUseFullScreenIntent()); } catch { return true; }
}

/** Opens the per-app "Full screen intents" toggle so the user can grant it. */
export async function openFullScreenIntentSettings(): Promise<boolean> {
  if (!has()) return false;
  try { return !!(await VaultCalls.openFullScreenIntentSettings()); } catch { return false; }
}

export default {
  registerForCalls, startCallForeground, stopCallForeground,
  dismissIncomingNotification, initiateCall, cancelCall, drainDeclinedCall, getInitialCallIntent,
};
