// lib/sessionEnded.ts — the one definition of "this session is over".
//
// AUDIT F09. When a refresh comes back terminal the app clears credentials and
// redirects to onboarding. That redirect was only half a fix: the request that
// discovered the dead session still had to answer its caller, and roughly
// twenty call sites do
//
//     catch (e) { Alert.alert('… failed', e?.message ?? 'Try again') }
//
// so an expired session stacked a "token_expired" dialog ON TOP of the sign-in
// screen — the exact dead end the redirect exists to prevent.
//
// The stopgap was a promise that never settled. It suppressed the dialog, but
// at a price: `finally` never ran either, so spinners, disabled buttons and
// "sending…" states were frozen on any screen that outlived the redirect, and
// nothing could ever clean up after a session death.
//
// The fix the audit actually prescribed is this: reject with a TYPED error, and
// suppress that one type at the alert boundary. Callers get a normal rejection —
// `finally` runs, state unwinds — and the user gets the sign-in screen with no
// dialog in front of it.
//
// This module is deliberately free of react-native and expo-router imports so
// it can be tested under plain Node. See lib/sessionEnded.selftest.ts.

/** Marker carried on the error object itself, so it survives a re-throw that
 *  loses the prototype (a common casualty of transpiled `extends Error`). */
export const SESSION_ENDED = 'VAULTCHAT_SESSION_ENDED';

/**
 * The message shown if this error ever DOES reach a surface — a log line, a
 * crash report, an inline error slot. It reads as an explanation rather than a
 * failure, because by the time anyone could see it the sign-in screen is
 * already up and nothing went wrong that the user should act on.
 */
export const SESSION_ENDED_MESSAGE = 'Your session ended. Please sign in again.';

export class SessionEndedError extends Error {
  /** Read by isSessionEnded. A plain property, not `instanceof`: see above. */
  readonly code = SESSION_ENDED;

  constructor(message: string = SESSION_ENDED_MESSAGE) {
    super(message);
    this.name = 'SessionEndedError';
    // Restores the prototype chain when the build target is ES5, where
    // `extends Error` otherwise produces a plain Error at runtime.
    Object.setPrototypeOf(this, SessionEndedError.prototype);
  }
}

/**
 * Is this the session-ended rejection?
 *
 * Checks the marker property rather than `instanceof`, so it still answers
 * correctly for an error that crossed a module boundary, was serialised and
 * revived, or was wrapped by a library that copied its fields.
 */
export function isSessionEnded(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  return code === SESSION_ENDED;
}

/**
 * Is this TEXT the session-ended message?
 *
 * The alert boundary needs this second form because a call site that does
 * `Alert.alert('Failed', e?.message)` has already thrown the error away and
 * kept only its string. Matching the exact message is narrow on purpose: a
 * looser match ("expired", "sign in") would swallow real errors the user needs
 * to see, and a suppressed real error is a far worse bug than an extra dialog.
 */
export function isSessionEndedText(s: unknown): boolean {
  return typeof s === 'string' && s.trim() === SESSION_ENDED_MESSAGE;
}
