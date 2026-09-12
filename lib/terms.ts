// lib/terms.ts — fetch and record terms acceptance.
//
// AUDIT F10. Thin on purpose: the decision lives in ./termsPolicy (no
// react-native, unit-testable) and the authority lives on the server. This is
// only the plumbing between them.
//
// Two rules it shares with the version gate next door, for the same reason —
// neither must lock anyone out by accident:
//
//   1. Unreachable server ⇒ NOT OUTSTANDING. An offline user must never be
//      shown an acceptance screen they cannot get past. This app is local-first
//      and works offline by design.
//   2. Signed out ⇒ NOT ASKED. /user/terms needs auth, and calling it without a
//      session would trip the session-ended redirect on a user who is simply
//      not signed in yet. Onboarding is where a new account accepts.

import { api, hasSession } from './api';
import { termsOutstanding, type TermsState } from './termsPolicy';

export type { TermsState } from './termsPolicy';
export { termsAreAnUpdate, termsOutstanding } from './termsPolicy';

let cached: TermsState | null | undefined;

/** Ask the server. Never throws; null means "no usable answer". */
export async function fetchTermsState(force = false): Promise<TermsState | null> {
  if (!force && cached !== undefined) return cached;
  try {
    if (!(await hasSession())) {
      cached = null;
      return null;
    }
    cached = await api<TermsState>('/user/terms');
  } catch {
    // Offline, an outage, or a server predating this endpoint. All three mean
    // "do not interrupt the user"; an acceptance recorded a day later is a far
    // better outcome than a screen nobody can dismiss.
    cached = null;
  }
  return cached;
}

/** True when the user must accept before continuing. Never throws. */
export async function termsNeedAcceptance(): Promise<boolean> {
  return termsOutstanding(await fetchTermsState());
}

/**
 * Record acceptance of the version currently in force.
 *
 * The version is taken from the state the server just gave us rather than from
 * a constant in the app: the app must record what it actually showed, and what
 * it showed is whatever the server said was current. A build with a hard-coded
 * version would keep recording that label after the terms changed.
 */
export async function acceptTerms(state: TermsState): Promise<void> {
  const version = (state.requiredVersion ?? '').trim();
  if (!version) return;
  await api('/user/terms', { method: 'POST', json: { version } });
  cached = { ...state, acceptedVersion: version, acceptedAt: new Date().toISOString() };
}

/** Drop the cached answer — used after sign-in, when the user has changed. */
export function resetTermsCache(): void {
  cached = undefined;
}

export default { fetchTermsState, termsNeedAcceptance, acceptTerms, resetTermsCache };
