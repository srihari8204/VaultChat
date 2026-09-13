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
      // NOT cached. "Nobody is signed in yet" is not an answer to "has this
      // user accepted", it is the absence of a user — and caching it as an
      // answer is what made the gate never fire at all: TermsGate mounts at app
      // start, which is BEFORE sign-in, so the first call always landed here,
      // stored null, and every later call returned that stored null through the
      // early return at the top. Every new user skipped the screen. Found on a
      // device, because nothing else could have found it.
      return null;
    }
    cached = await api<TermsState>('/user/terms');
  } catch {
    // Offline, an outage, a server predating this endpoint, or SecureStore
    // throwing inside hasSession(). All of them mean "do not interrupt the
    // user" — an acceptance recorded a day later beats a screen nobody can
    // dismiss.
    //
    // NOT cached, for the same reason the signed-out path is not. A transient
    // failure is not an answer, and storing it as one pinned `cached = null`
    // for the life of the process: the early return at the top of this function
    // then short-circuited every later call, so TermsGate's retry ladder kept
    // re-scheduling and every retry returned the pinned null WITHOUT a network
    // call. One network blip at the wrong moment disabled the gate until the
    // app was killed. Observed on a device: the gate ran on one boot and never
    // requested /user/terms at all on the next.
    //
    // `cached` now only ever holds a real answer from the server. That is the
    // whole invariant, and it is why both failure paths return without writing.
    return null;
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
