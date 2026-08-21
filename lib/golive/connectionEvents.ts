// lib/golive/connectionEvents.ts — forward the SDK's connection lifecycle.
//
// WHAT THIS IS NOT
//
// It is not a reconnect mechanism. livekit-client owns that entirely: its
// DefaultReconnectPolicy retries on [0, 300, 1200, 2700, 4800, 7000×5] ms —
// ten attempts across roughly forty-four seconds — and adding a second
// scheduler on top is how two connections end up racing to publish into one
// room. Nothing here calls connect(), leave(), or a timer.
//
// WHAT IT IS FOR
//
// Go Live listened to none of it. RoomEvent.Reconnecting was unobserved and
// onDisconnected was an optional callback no call site supplied, so for that
// entire forty-four-second window the host's screen still said LIVE while
// nothing reached the audience — and if the SDK ultimately gave up, still
// nothing changed. The gap was never the retry; it was that the app threw away
// the two signals telling it what was happening.
//
// PURE ON PURPOSE: no react-native, no @livekit/react-native, no Room. That is
// what lets connectionEvents.selftest.ts run under `npx tsx` and cover the
// wiring, which is otherwise the one part of the path with no test — joinSfuRoom
// cannot run outside a device because it opens a real transport.

/**
 * The three RoomEvent names, as literals.
 *
 * Duplicated rather than imported so this module stays runnable in Node.
 * room.ts asserts at import time that they still match the SDK's enum
 * (assertConnectionEventNames), so the duplication cannot drift silently — a
 * renamed event fails loudly on the device instead of quietly never firing.
 *
 * Note the near-misses these must NOT be confused with: the SDK also has
 * `signalReconnecting` (signalling only, transport still up) and
 * `participantDisconnected` (someone else left). Neither means what we want.
 */
export const CONNECTION_EVENTS = {
  reconnecting: 'reconnecting',
  reconnected: 'reconnected',
  disconnected: 'disconnected',
} as const;

/** All wireConnectionEvents needs from a Room: an event emitter. */
export interface ConnectionEventSource {
  on(event: string, cb: (...args: any[]) => void): unknown;
}

export interface ConnectionHandlers {
  /** Transport lost; the SDK is recovering it. NOT terminal — do not tear down. */
  onReconnecting?: () => void;
  /** Transport back. Publishing resumes on its own. */
  onReconnected?: () => void;
  /** The SDK gave up. This is the only terminal one. */
  onDisconnected?: () => void;
}

/**
 * Register the three listeners. Registering is all it does.
 *
 * A healthy broadcast therefore gains three idle listeners and nothing else —
 * no timer, no poll, no extra socket — which is what keeps the normal LIVE path
 * exactly as cheap as it was before.
 */
export function wireConnectionEvents(
  room: ConnectionEventSource, h: ConnectionHandlers,
): void {
  if (h.onReconnecting) room.on(CONNECTION_EVENTS.reconnecting, h.onReconnecting);
  if (h.onReconnected) room.on(CONNECTION_EVENTS.reconnected, h.onReconnected);
  if (h.onDisconnected) room.on(CONNECTION_EVENTS.disconnected, h.onDisconnected);
}

/**
 * Fail loudly if the SDK ever renames these events.
 *
 * Called once from room.ts with the real enum. A silent rename would not break
 * the build — room.on() takes a string — it would simply mean the callbacks
 * never fire again, and the symptom (a host stuck on LIVE through an outage) is
 * exactly the bug this change exists to fix. Cheap insurance against shipping
 * the same defect back in under a different cause.
 */
export function assertConnectionEventNames(
  actual: { Reconnecting: string; Reconnected: string; Disconnected: string },
): void {
  const drift: string[] = [];
  if (actual.Reconnecting !== CONNECTION_EVENTS.reconnecting) drift.push('Reconnecting');
  if (actual.Reconnected !== CONNECTION_EVENTS.reconnected) drift.push('Reconnected');
  if (actual.Disconnected !== CONNECTION_EVENTS.disconnected) drift.push('Disconnected');
  if (drift.length) {
    console.warn(
      '[golive] RoomEvent names drifted from CONNECTION_EVENTS: ' + drift.join(', ')
      + ' — connection-state callbacks will not fire until lib/golive/connectionEvents.ts is updated.',
    );
  }
}

export default { CONNECTION_EVENTS, wireConnectionEvents, assertConnectionEventNames };
