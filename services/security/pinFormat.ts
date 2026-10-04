// services/security/pinFormat.ts — what a Device PIN may look like. Pure.
//
// One definition, shared by the only setter (pinStore.setPin via
// app/backup-pin) and every screen that asks for the PIN back (app/vault).
// The vault used to accept exactly 8 digits while backup-pin stored 6, so a
// user who set a PIN in Settings could never open the vault (2026-10-04).

export const PIN_MIN = 4;
export const PIN_MAX = 8;

/** True for a string of PIN_MIN..PIN_MAX ASCII digits. */
export function isPinFormat(pin: string): boolean {
  return typeof pin === 'string' && pin.length >= PIN_MIN && pin.length <= PIN_MAX && /^[0-9]+$/.test(pin);
}
