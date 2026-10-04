// lib/ringtoneChoice.ts — which ringtone an incoming call plays. Pure, no RN.
//
// The settings screen let the user pick a ringtone, but on Android the ring
// always played the phone's system ringtone whenever the native module was
// present, so the pick was silently ignored. The phone ringtone is now an
// explicit choice ('system') and every other choice is honoured.

export const SYSTEM_RINGTONE = 'system';

export type RingPlan = { kind: 'system' } | { kind: 'bundled'; id: string };

/**
 * What to play for a stored choice.
 *
 * 'system' needs the native module (Android dev/prod builds); without it the
 * first bundled tone stands in. An unknown id also falls back to the first
 * bundled tone, never to silence.
 */
export function resolveRingtone(choice: string, nativeAvailable: boolean, bundledIds: readonly string[]): RingPlan {
  if (choice === SYSTEM_RINGTONE && nativeAvailable) return { kind: 'system' };
  const id = bundledIds.includes(choice) ? choice : bundledIds[0];
  return { kind: 'bundled', id };
}

/** Bumped when the stored meaning of `ringtone` changed. */
export const RINGTONE_PREFS_VERSION = 2;

/**
 * Read a stored choice written before the phone ringtone was a choice.
 *
 * Old prefs always held a ringtone id, and 'ring_pulse' was the default that
 * got written as soon as ANY sound setting changed — while Android actually
 * played the system ringtone. So an old 'ring_pulse' (or missing value) means
 * "whatever rang before", which is the phone ringtone; an old explicit pick of
 * another bundled tone is kept and is now honoured.
 */
export function migrateRingtone(stored: { ringtone?: unknown; ringtoneVersion?: unknown } | null | undefined, legacyDefault: string): string {
  const r = typeof stored?.ringtone === 'string' ? stored.ringtone : '';
  if (stored?.ringtoneVersion === RINGTONE_PREFS_VERSION && r) return r;
  return !r || r === legacyDefault ? SYSTEM_RINGTONE : r;
}
