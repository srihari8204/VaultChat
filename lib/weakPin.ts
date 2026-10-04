// lib/weakPin.ts — the ONE "too easy to guess" rule for every PIN the user
// chooses: the account MPIN (onboard-mpin, mpin-recover) and the Device PIN
// (backup-pin). There were three local copies and they disagreed — recovery
// had no birth-year rule and the Device PIN accepted 123456-style lists.
// Pure; Node-tested in weakPin.selftest.ts. The server re-checks the MPIN.

const COMMON = ['123456', '654321', '000000', '121212', '112233', '1234', '0000', '1212', '123123'];

/**
 * True when `pin` is all digits of `length` and still weak: one repeated digit,
 * a straight run up or down, a well-known PIN, or containing the birth year.
 * Anything not exactly `length` digits is also rejected.
 */
export function isWeakPin(pin: string, length = 6, dobYear?: string): boolean {
  if (!new RegExp(`^\\d{${length}}$`).test(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true;
  if ('01234567890'.includes(pin) || '09876543210'.includes(pin)) return true;
  if (COMMON.includes(pin)) return true;
  if (dobYear && /^\d{4}$/.test(dobYear) && pin.includes(dobYear)) return true;
  return false;
}
