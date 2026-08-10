// lib/call/netChange.ts — which NetInfo events are worth restarting ICE for.
//
// Pure predicate, no NetInfo import, so the decision is checkable in Node
// (netChange.selftest.ts) rather than only on a phone mid-handover.
//
// A handover is not one event. It arrives as a PAIR:
//
//   wifi:true -> none:false        the old interface went away
//   none:false -> cellular:true    the new one came up, seconds later
//
// Only the second is actionable. Restarting on the first gathers candidates
// with no interface to gather from and emits an offer with no path to carry
// it, which then has to be rolled back by the restart that can actually
// succeed.

/** What NetInfo tells us, reduced to the part that matters. */
export interface NetState {
  type?: string;
  isConnected?: boolean;
}

/** Stable identity of a network state; a change in this is a real transition. */
export function netKey(st: NetState | null | undefined): string {
  return `${st?.type}:${!!st?.isConnected}`;
}

/**
 * Should this transition trigger an ICE restart?
 *
 * `prev` is the last key seen, `''` on the first callback — NetInfo emits the
 * current state immediately on subscribe, and that is not a change.
 *
 * Returns false for a transition INTO no-connectivity. That is not a debounce:
 * a timer suppressing restarts within N seconds of the last one would also
 * suppress the restart onto the new network, which is the one that reconnects
 * the call. The condition here is "is there a network to restart onto", which
 * cannot swallow a useful restart.
 */
export function shouldRestartIce(prev: string, st: NetState | null | undefined): boolean {
  const key = netKey(st);
  if (key === prev) return false;   // signal-strength wobble, not a transition
  if (!prev) return false;          // first callback = current state
  return !!st?.isConnected;         // nothing to gather from on a dead network
}

export default { netKey, shouldRestartIce };
