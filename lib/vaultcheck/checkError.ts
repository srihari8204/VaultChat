// lib/vaultcheck/checkError.ts — the text app/vaultcheck.tsx shows when a
// check fails.
//
// The screen's own messages (no media given, media not found on this device,
// the timeout that says the check is still running and Try again keeps
// waiting for it) are written for people and are shown as they are. Anything
// else — a native module's or the OS's own text — goes through userErrorText,
// which shows a fixed line instead. Pure, so it is Node-tested
// (checkError.selftest.ts).

import { userErrorText } from '../userErrorText';

/** A failure whose message is the screen's own copy. */
export class VaultCheckMessage extends Error {
  constructor(message: string) { super(message); this.name = 'VaultCheckMessage'; }
}

export const CHECK_FAILED_TEXT = 'Verification failed. Try again.';

export function vaultCheckErrorText(e: unknown): string {
  return e instanceof VaultCheckMessage ? e.message : userErrorText(e, CHECK_FAILED_TEXT);
}
