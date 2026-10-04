// lib/statusPrivacySelection.ts
// The server keeps ONE audience list for status privacy (status_audience), read
// as "excluded" in except mode and "shared with" in only mode. Carrying the list
// across a mode switch would turn the people a user hid their status from into
// the only people who can see it, so a mode switch always starts from an empty
// selection and the user picks again. "My contacts" stores no list at all.

export type PrivacyMode = 'contacts' | 'except' | 'only';

/** The selection to save when moving from `from` to `to`. */
export function selectionAfterModeSwitch(from: PrivacyMode, to: PrivacyMode, current: ReadonlySet<string>): Set<string> {
  return from === to ? new Set(current) : new Set();
}

/** The user ids sent with a save for `mode`. */
export function privacyUserIds(mode: PrivacyMode, selected: ReadonlySet<string>): string[] {
  return mode === 'contacts' ? [] : [...selected];
}
