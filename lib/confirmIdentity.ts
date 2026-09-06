// lib/confirmIdentity.ts — does what they typed match the account they are on?
//
// Used by the delete-account screen to arm its button. This is a CONFIRMATION,
// not an authentication check: the person is already signed in, and the only
// thing being asked is "did you mean to do this, to this account". So it is
// forgiving about formatting and unforgiving about being blank.
//
// Kept out of the screen so it can be tested without React Native —
// see confirmIdentity.selftest.ts.

const digits = (s: string) => s.replace(/\D/g, '');

/** Shortest suffix we accept for a phone. Below this, a slip of the thumb
 *  could match, which is exactly what the confirmation exists to prevent. */
export const MIN_PHONE_DIGITS = 6;

export interface AccountIdentity {
  phone?: string | null;
  email?: string | null;
}

/**
 * True when `typed` names the account in `me`.
 *
 * Phone accounts match on digits, with or without the country code: to the
 * person typing, "+91 98765 43210" and "9876543210" are the same number, and
 * rejecting the second only teaches people to paste. Email accounts must match
 * in full, case- and whitespace-insensitively — an email has no equivalent of
 * "the local part is enough".
 */
export function identityMatches(me: AccountIdentity | null, typed: string): boolean {
  if (!me) return false;
  if (me.phone) {
    const mine = digits(me.phone);
    const t = digits(typed);
    if (!mine || t.length < MIN_PHONE_DIGITS) return false;
    return t === mine || mine.endsWith(t);
  }
  if (me.email) return typed.trim().toLowerCase() === me.email.trim().toLowerCase();
  return false;
}

export default { identityMatches, MIN_PHONE_DIGITS };
