// lib/sessionEpoch.ts — a counter that ticks whenever a peer's E2EE session is
// torn down and rebuilt.
//
// WHY
// ---
// Anything holding material derived from a session needs to know when that
// session is no longer the one the peer has. The concrete case is call setup:
// ringAndOffer() seals the SDP offer ONCE and re-emits that same wire every 3s
// for up to 27s. If the callee cannot open it, every repeat fails identically —
// so a re-key that lands mid-ring cannot rescue the call, and the user has to
// hang up and redial. Observed on device as four "openCallOffer failed —
// aes/gcm: invalid ghash tag" in a row while the re-key was working correctly.
//
// A counter rather than an event emitter: the ring loop is a polling timer that
// already wakes every 3s, so it only needs to answer "has this changed since I
// sealed?" — no subscription to leak, and no ordering to get wrong.
//
// Deliberately its own module so both chatService and callCrypto can bump it
// without importing each other.

const _epochs = new Map<string, number>();

/** Call immediately AFTER a peer's session is reset. */
export function bumpSessionEpoch(peerId: string): void {
  if (!peerId) return;
  _epochs.set(peerId, (_epochs.get(peerId) ?? 0) + 1);
}

/** Current epoch for a peer. Stable until a reset happens. */
export function sessionEpoch(peerId: string): number {
  return _epochs.get(peerId) ?? 0;
}

export default { bumpSessionEpoch, sessionEpoch };
