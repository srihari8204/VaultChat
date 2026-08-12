// lib/pushRegistration.ts — why this device can (or cannot) be woken for a call.
//
// WHY THIS EXISTS
// ---------------
// registerForCalls() used to swallow every failure:
//
//     } catch (e) {
//       if (__DEV__) console.warn('[CallService] register failed:', e?.message);
//     }
//
// In a RELEASE build `__DEV__` is false, so a failure produced no log, no retry
// and no user-visible sign. The consequences are invisible and severe: without a
// push token on the server, `sendCallWakePush` has nothing to send to, so the
// device can only ring while a socket happens to be alive. A killed or dozing
// phone never rings at all — and nothing, anywhere, says why.
//
// It is also a ONE-SHOT: app/_layout.tsx calls it once at boot. A phone that
// starts with no network — the single most ordinary way for this to fail — never
// registers for that entire session, however long the app then stays open.
//
// NOT AN OEM PROBLEM, and deliberately not written as one. The obvious trigger
// is a device with no Google Play Services (Huawei post-2019), where the FCM
// token call rejects outright. But the same silent hole opens on a Pixel with a
// slow boot network, an expired access token, or a 500 from /call/token. Fixing
// the class costs the same as special-casing one vendor and covers all of them,
// so there is no OEM branch here and none is wanted.
//
// This module holds the parts that can be got wrong and are testable under Node:
// the CLASSIFICATION of an outcome (which failures are worth retrying, and which
// are permanent facts about the device) and the BACKOFF schedule. The bridge
// calls themselves stay in lib/CallService.ts.

/**
 * Outcome of one registration attempt.
 *
 *   ok            — the server holds a current token for this device
 *   no_platform   — not Android / native module absent (Expo Go, web). Normal.
 *   no_provider   — the push provider could not produce a token at all. On
 *                   Android that means Play Services is missing, disabled or too
 *                   old. PERMANENT for this install: retrying cannot conjure a
 *                   provider that is not on the device.
 *   not_signed_in — no access token yet. Transient: sign-in re-runs this.
 *   transient     — network/server failure. Worth retrying.
 */
export type PushOutcome = 'ok' | 'no_platform' | 'no_provider' | 'not_signed_in' | 'transient';

/** Attempts after the first, before giving up on a transient failure. */
export const PUSH_RETRY_LIMIT = 4;

/**
 * Backoff before attempt `n` (1-based: attempt 1 is the first RETRY).
 *
 * Exponential from 2s, capped at 30s. The cap matters more than the curve: this
 * runs at app start, competing with sync, receipts and the media outbox for a
 * network that is often still coming up, and an uncapped exponential would push
 * the last attempt minutes out — long past the point the user has given up and
 * closed the app.
 */
export function pushRetryDelayMs(attempt: number): number {
  if (attempt < 1) return 0;
  return Math.min(2_000 * 2 ** (attempt - 1), 30_000);
}

/** Should another attempt be made after this outcome? */
export function shouldRetryPush(outcome: PushOutcome, attempt: number): boolean {
  // Only `transient` is worth another try. `no_provider` is a fact about the
  // hardware, and `no_platform` is not a failure at all — retrying either would
  // be a timer waking the CPU to fail identically, forever.
  if (outcome !== 'transient') return false;
  return attempt < PUSH_RETRY_LIMIT;
}

/**
 * Can this device be woken for a call while the app is killed or dozing?
 *
 * The honest answer, for a UI that wants to warn the user. `false` does NOT mean
 * calls are broken: signalling is a socket and media is peer-to-peer, so a call
 * still rings and still connects whenever the app is running. It means the
 * DOORBELL is missing, which is a real and explainable limitation rather than a
 * mysterious one.
 */
export function canWakeForCalls(outcome: PushOutcome | null): boolean {
  return outcome === 'ok';
}

/**
 * One-line explanation suitable for showing a user, or null when there is
 * nothing worth saying.
 *
 * Deliberately free of jargon — "Google Play Services" is a thing a user can act
 * on; "FCM token registration failed" is not. Nothing here names a vendor as a
 * fault, because on most of these devices it simply is not one.
 */
export function pushWarningText(outcome: PushOutcome | null): string | null {
  switch (outcome) {
    case 'no_provider':
      return 'Calls will not ring while VaultChat is closed on this device, because Google Play Services is unavailable. Keep the app open to receive calls.';
    case 'transient':
      return 'VaultChat could not register for call notifications. Calls may not ring while the app is closed.';
    // 'ok' and 'no_platform' need no warning, and 'not_signed_in' resolves
    // itself the moment the user signs in — warning about it would be noise.
    default:
      return null;
  }
}

// ── last known state ──────────────────────────────────────────────────
//
// Module-level rather than persisted: it describes THIS process's ability to be
// woken, and a stale answer from a previous launch (different network, since
// signed in, Play Services since updated) would be worse than none.

let last: PushOutcome | null = null;

export function setPushOutcome(o: PushOutcome): void { last = o; }
export function getPushOutcome(): PushOutcome | null { return last; }

export default {};
