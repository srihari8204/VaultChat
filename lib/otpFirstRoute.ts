// lib/otpFirstRoute.ts — where sign-in goes after the SMS code (R4BE C15).
//
// Every number now proves possession with the SMS OTP FIRST, existing account
// or not; the phoneTicket that answer carries is what /auth/mpin/verify and the
// recovery routes require once the server's AUTH_REQUIRE_PHONE_TICKET is on.
// Before, an existing number went straight from /auth/lookup (no proof) to
// MPIN guesses, recovery questions and the owner's attempt budget.
//
// A server with C15 says `exists` (+ `userId`) on the verify answer. Today's
// server does not, so the client asks /auth/lookup — with the ticket — as it
// did before. Pure, so lib/otpFirstRoute.selftest.ts runs it under plain tsx.

export type SignInNext =
  | { to: 'mpin'; userId: string }
  | { to: 'signup' }
  | { to: 'conflict' }
  | { to: 'lookup' }
  | { to: 'error' };

const id = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** After POST /auth/onboard/verify-otp-phone. `lookup` = the server did not say. */
export function afterOtp(v: { exists?: unknown; userId?: unknown } | null | undefined): SignInNext {
  if (v?.exists === true && id(v.userId)) return { to: 'mpin', userId: id(v.userId)! };
  if (v?.exists === false) return { to: 'signup' };
  return { to: 'lookup' };
}

/** After POST /auth/lookup sent with the ticket. */
export function afterLookup(r: { exists?: unknown; userId?: unknown; conflict?: unknown } | null | undefined): SignInNext {
  if (r?.exists === true) return id(r.userId) ? { to: 'mpin', userId: id(r.userId)! } : { to: 'error' };
  if (r?.conflict) return { to: 'conflict' };
  return { to: 'signup' };
}

/**
 * 403 `otp_required` (R4BE C15): the phoneTicket is missing or past its
 * 15-minute life. Only a fresh SMS code fixes it, so callers send the person
 * back to the number step rather than showing a generic failure. The server
 * does not spend an MPIN attempt on this answer. Today's server never sends it.
 */
export function needsFreshOtp(e: unknown): boolean {
  const err = e as { status?: unknown; body?: { error?: { code?: unknown } } } | null | undefined;
  return err?.status === 403 && err?.body?.error?.code === 'otp_required';
}

/** The copy for that case, shared by the three screens that can meet it. */
export const FRESH_OTP_MESSAGE = 'Your mobile number check has expired. Verify your number again to continue.';
