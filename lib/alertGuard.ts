// lib/alertGuard.ts — the alert boundary the session-ended fix needs.
//
// AUDIT F09 prescribed "suppress it at UI alert boundaries". There are 694
// `Alert.alert` call sites in this app, so there is no boundary to suppress it
// at — unless one is made.
//
// WHY A WRAPPER AND NOT A HELPER EVERY SITE IMPORTS
// ------------------------------------------------
// A shared `showAlert()` would be the textbook answer, and it would require
// editing 694 call sites to fix one bug — a diff nobody can review, in files
// that have nothing to do with sessions. Worse, it only holds until the next
// screen calls `Alert.alert` directly, which is what every existing screen
// does and therefore what the next one will copy.
//
// Wrapping `Alert.alert` once, at startup, covers every existing site and every
// future one, in one file that says exactly what it does. React Native's Alert
// is a plain object with static methods, so this is an assignment, not a hack
// on a frozen module.
//
// WHAT IT SUPPRESSES
// ------------------
// One exact message: SESSION_ENDED_MESSAGE. Nothing else, ever. The temptation
// is to also drop "Network request failed" and friends; do not. A suppressed
// real error is a user staring at a screen that silently did nothing, which is
// a worse bug than the one this fixes.

import { Alert, type AlertButton, type AlertOptions } from 'react-native';

import { isSessionEndedText } from './sessionEnded';

let installed = false;

/**
 * Install the boundary. Idempotent — a second call is a no-op, so a fast
 * refresh that re-runs the root layout cannot wrap the wrapper (which would
 * still work, but each reload would add a frame to every alert's stack).
 */
export function installAlertGuard(): void {
  if (installed) return;
  installed = true;

  const original = Alert.alert.bind(Alert);

  Alert.alert = (
    title: string,
    message?: string,
    buttons?: AlertButton[],
    options?: AlertOptions,
  ): void => {
    // The message is where the error text lands: the overwhelmingly common
    // shape is Alert.alert('Something failed', e?.message). The title is
    // checked too for the handful of sites that pass the error as the title.
    if (isSessionEndedText(message) || isSessionEndedText(title)) {
      if (__DEV__) {
        console.log('[alertGuard] suppressed a session-ended alert; the sign-in screen is already up');
      }
      return;
    }
    original(title, message, buttons, options);
  };
}

/** Test seam: report whether the boundary is in place. */
export function alertGuardInstalled(): boolean {
  return installed;
}

export default { installAlertGuard, alertGuardInstalled };
