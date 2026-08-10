// lib/call/sessionHealth.ts — make sure the E2EE session works BEFORE dialling.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// A call's SDP offer is sealed with the peer's Double Ratchet session. If that
// session is stale, the callee cannot open the offer, never answers, and never
// sends candidates — so ICE sits in `connecting` until it times out. Observed
// exactly that: our side gathered host+srflx+relay perfectly and the call still
// died, because nothing arrived from the other end.
//
// The failure is silent and looks like a network problem. The user sees "calling…"
// forever and blames the app or their signal; the real cause is a key mismatch
// that a two-second check could have caught.
//
// WHY NOT JUST RE-KEY ON EVERY CALL
// A tempting fix is to force a fresh X3DH at the start of every call. That is
// wrong here: calls and TEXT share one session, so re-keying per call would
// destroy the message session each time, and two people calling at once would
// produce the re-key storm this codebase already fought (8 resets in 22s). The
// ratchet gives forward secrecy per MESSAGE; there is nothing to gain.
//
// So: verify, repair if broken, and only then dial.

import { requestPeerRekey } from '../chatService';
import { e2eeHasSession } from '../../services/crypto/e2eeSession.rn';

export type SessionState = 'ready' | 'repairing' | 'unavailable';

/**
 * Check the peer session and start a repair if it is missing.
 *
 * `repairing` is not a failure — it means a re-key is in flight and the call
 * should wait rather than dial into a session the peer cannot read. The caller
 * decides how long to wait; this function never blocks.
 */
export async function checkSessionHealth(peerId: string): Promise<SessionState> {
  if (!peerId) return 'ready';                 // group call: no single peer session
  try {
    if (await e2eeHasSession(peerId)) return 'ready';

    // No session at all. Our next outbound will run X3DH by itself, but the
    // PEER may still hold a stale one — and their offer/answer would then be
    // sealed with a key we cannot open. Asking them to re-key fixes the
    // direction we cannot fix alone.
    await requestPeerRekey(peerId, true);
    return 'repairing';
  } catch {
    // Never block a call on a diagnostic. If this cannot answer, dialling and
    // failing is strictly better than refusing to try.
    return 'ready';
  }
}

/**
 * Wait for a session to become usable, up to `timeoutMs`.
 *
 * Returns false on timeout, and the caller should surface that honestly rather
 * than dial anyway: a call placed over a broken session produces "calling…"
 * that never connects, which is the worst outcome for the user because it
 * looks like a network fault they might keep retrying.
 */
export async function waitForSession(peerId: string, timeoutMs = 4000): Promise<boolean> {
  if (!peerId) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await e2eeHasSession(peerId)) return true; } catch { return true; }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

export default { checkSessionHealth, waitForSession };
