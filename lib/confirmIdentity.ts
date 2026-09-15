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
  /** The @handle every account gets (assigned lazily by GET /user/profile).
   *  Last resort, because sign-in is mobile-only and email is optional: without
   *  it an account whose profile carries neither phone nor email has NO way to
   *  confirm, and in-app deletion — which Play requires — can never arm. */
  vaultId?: string | null;
}

/** First non-blank, trimmed. Blank is absent: `''` is what an optional email
 *  looks like on the wire, and truthiness alone let it win its branch and then
 *  fail, hiding the identifier the account actually had. */
const firstReal = (...v: (string | null | undefined)[]) =>
  v.map(s => s?.trim() ?? '').find(s => s !== '') ?? '';

/**
 * True when `typed` names the account in `me`.
 *
 * Phone accounts match on digits, with or without the country code: to the
 * person typing, "+91 98765 43210" and "9876543210" are the same number, and
 * rejecting the second only teaches people to paste. Email and VaultID must
 * match in full, case- and whitespace-insensitively — neither has an
 * equivalent of "the local part is enough".
 *
 * Order is identity precedence, not preference: phone first because it is now
 * the account, email next for accounts that predate mobile-only sign-in.
 */
export function identityMatches(me: AccountIdentity | null, typed: string): boolean {
  if (!me) return false;

  const mine = digits(firstReal(me.phone));
  if (mine) {
    const t = digits(typed);
    if (t.length < MIN_PHONE_DIGITS) return false;
    return t === mine || mine.endsWith(t);
  }

  const email = firstReal(me.email).toLowerCase();
  if (email) return typed.trim().toLowerCase() === email;

  // Typing your own handle back is the same deliberate act as typing your own
  // number, and it is never shown on the delete screen — so it still cannot be
  // produced by a mis-tap. The leading @ is decoration; people will type it.
  const handle = firstReal(me.vaultId).toLowerCase().replace(/^@/, '');
  if (handle) return typed.trim().toLowerCase().replace(/^@/, '') === handle;

  return false;
}

export default { identityMatches, MIN_PHONE_DIGITS };
