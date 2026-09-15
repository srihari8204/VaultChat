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

/** Firebase uses one bridge error code for both missing services and outages. */
export function pushTokenFailureOutcome(error: unknown): PushOutcome {
  const message = error instanceof Error ? error.message : String((error as any)?.message ?? error ?? '');
  return /\bMISSING_INSTANCEID_SERVICE\b/.test(message) ? 'no_provider' : 'transient';
}

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
      return 'Calls will not ring while crazzychat is closed on this device, because Google Play Services is unavailable. Keep the app open to receive calls.';
    case 'transient':
      return 'crazzychat could not register for call notifications. Calls may not ring while the app is closed.';
    // 'ok' and 'no_platform' need no warning, and 'not_signed_in' resolves
    // itself the moment the user signs in — warning about it would be noise.
    default:
      return null;
  }
}

/**
 * Should registration be POSTed again?
 *
 * WHY THIS IS NEEDED AT ALL
 * -------------------------
 * FCM rotates a device's token — on app-data clear, reinstall, restore to a new
 * phone, and Google-initiated expiry. VaultCallMessagingService.onNewToken
 * catches the rotation and writes the new token to SharedPreferences, and its
 * own comment says "CallModule.getFcmToken() lets JS read + POST /call/token".
 * But JS only ever called registerForCalls() ONCE, at app boot. So nothing
 * POSTed it.
 *
 * The server therefore kept the OLD token, every wake push went to a dead
 * address, and the phone stopped ringing for calls while killed — silently,
 * until the next cold start. On a phone that keeps the app in memory for days,
 * that is days of missed calls with no symptom to report beyond "it just stopped
 * ringing sometimes".
 *
 * The rule:
 *   • token changed        → POST. This is the rotation case.
 *   • last attempt not ok  → POST. Covers network-came-back, just-signed-in, and
 *                            a server that was briefly unhappy.
 *   • otherwise            → skip. The server already holds this exact token, so
 *                            re-POSTing it on every foreground would be pure
 *                            request volume for no state change.
 */
export function shouldReregister(
  prev: { token: string | null; outcome: PushOutcome | null },
  currentToken: string | null,
): boolean {
  if (!currentToken) return false;         // nothing to register
  if (currentToken !== prev.token) return true;
  return prev.outcome !== 'ok';
}

// ── last known state ──────────────────────────────────────────────────
//
// Module-level rather than persisted: it describes THIS process's ability to be
// woken, and a stale answer from a previous launch (different network, since
// signed in, Play Services since updated) would be worse than none.

let last: PushOutcome | null = null;

export function setPushOutcome(o: PushOutcome): void { last = o; }
export function getPushOutcome(): PushOutcome | null { return last; }

// ── the second push provider (Huawei / no-GMS) ────────────────────────
//
// STATUS: NOT IMPLEMENTED. This is the seam, not the implementation, and the
// distinction is deliberate — claiming Huawei support that has never run on a
// Huawei device would be worse than the honest gap that exists now.
//
// WHAT WORKS TODAY ON A NO-GMS DEVICE
//   Calls ring and connect normally whenever the app is running: signalling is a
//   realtime connection and media is peer-to-peer, neither of which involves
//   Google. What does NOT work is the doorbell — waking a KILLED or DOZING app —
//   because that is the one job FCM does. attemptRegister() classifies such a
//   device `no_provider`, never retries it, and pushWarningText() explains the
//   limitation in words a user can act on.
//
// WHAT AN HMS PROVIDER WOULD NEED, exactly:
//   1. A Huawei Developer account with the app registered in AppGallery Connect.
//   2. `agconnect-services.json` in android/app/ (the HMS analogue of
//      google-services.json).
//   3. The AGConnect Gradle plugin + `com.huawei.hms:push` dependency, added via
//      the existing config plugin (plugins/withVaultChatCalls.js) so `expo
//      prebuild` does not discard it.
//   4. A native HmsMessagingService mirroring VaultCallMessagingService: same
//      data-only payload, same CATEGORY_CALL full-screen notification.
//   5. Server-side send support — vaultchat-backend-go currently speaks FCM
//      HTTP v1 only (internal/realtime/delivery.go). HMS uses a different
//      endpoint and OAuth flow, so `/call/token` would need to record WHICH
//      provider a token belongs to.
//   6. A physical Huawei device without GMS to verify against. There is none
//      available, and nothing here can be trusted until there is.
//
// None of that can be invented, and the credentials in particular must come from
// the account owner. Until then the honest state is the one implemented above.
//
// The seam itself is `attemptRegister()` in lib/CallService.ts: it is the only
// place that turns "this device" into a token, so a provider chosen there — FCM
// when GMS is present, HMS when it is not — needs no change anywhere else in the
// call stack. The wire protocol, the state machine, and E2EE are all
// provider-agnostic already, which is the property worth protecting.

export default {};
