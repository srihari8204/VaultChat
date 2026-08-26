// lib/socketReconnect.ts — WHEN the socket must be forcibly rebuilt.
//
// The expensive bug this exists to stop: a Wi-Fi→cellular switch leaves a
// socket whose TCP connection is ALREADY DEAD but which nothing has told. It
// still reports `connected === true`, so no retry starts. socket.io only finds
// out when the server's ping goes unanswered — pingInterval 10s + pingTimeout
// 5s (realtime/server.go) — so the banner sits on "Connecting…" for ~15s
// before the first attempt, and reconnect backoff is added on top of that.
//
// The cure is to stop waiting for a timeout to tell us something the platform
// already knows. These are the pure decisions behind that; socket.ts owns the
// subscriptions and the actual teardown.

/** The parts of a NetInfo state this decision depends on. */
export interface NetSnapshot {
  isConnected: boolean | null;
  /** null while the reachability probe is still in flight. */
  isInternetReachable: boolean | null;
  /** 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown' | … */
  type: string;
}

/**
 * A network's IDENTITY, or null when there is no usable network.
 *
 * Two different networks must produce two different keys — that difference is
 * the whole signal. Reachability is deliberately compared against `false` and
 * not truthiness: NetInfo reports `null` while it is still probing, and
 * treating that as offline would make every probe look like a network change
 * and fire a reconnect storm on a link that never actually moved.
 */
export function netKeyOf(st: NetSnapshot): string | null {
  if (!st.isConnected) return null;
  if (st.isInternetReachable === false) return null;
  return st.type;
}

/**
 * Why the transport should be rebuilt, or null to leave it alone.
 *
 * Losing the network is NOT a reason: there is nothing to connect to, and
 * burning retries against a dead radio is how battery disappears. The reason
 * string is for the perf trace, so it names both ends of a switch.
 */
export function reconnectReason(prev: string | null, next: string | null): string | null {
  if (next === null) return null;        // no network — nothing to do
  if (prev === next) return null;        // same network, still up
  if (prev === null) return `net-up:${next}`;
  return `net-switch:${prev}->${next}`;
}

/**
 * Should returning to the foreground force a rebuild?
 *
 * Only when the socket is not already live. Android kills sockets in Doze
 * without telling the app, so a foregrounded app frequently holds a handle to
 * something long dead — but churning a HEALTHY socket on every app switch
 * would cost a reconnect for nothing.
 */
export function shouldKickOnForeground(socketConnected: boolean): boolean {
  return !socketConnected;
}

/**
 * Settle delay before reconnecting, in ms.
 *
 * A newly-attached interface is not immediately usable — the route and DNS
 * land a moment after the platform announces the change, and connecting into
 * that gap just burns an attempt and starts the backoff ladder. Short enough
 * to stay imperceptible, long enough to skip the gap.
 */
export const SETTLE_MS = 300;

export default {};
