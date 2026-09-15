// lib/call/store.ts — the single active call's state, held OUTSIDE React.
//
// Same pattern as lib/socket.ts (useConnectionState), lib/unreadStore.ts and
// lib/nav/navSettings.ts: a module-level value, a Set of listeners, and
// useSyncExternalStore on top. No new dependency and no new concept — a call is
// app-wide state that outlives any one screen, which is precisely why holding it
// in a screen's useState was wrong.
//
// Everything mutating goes through dispatch(), so the reducer's invariants
// (lib/call/machine.ts, 42 self-test checks) hold for every path — screen,
// socket handler, native intent or teardown.

import { reduce, startSnapshot, type CallEvent, type StartParams } from './machine';
import { IDLE_SNAPSHOT, type CallSnapshot } from './types';

let snapshot: CallSnapshot = IDLE_SNAPSHOT;
const listeners = new Set<() => void>();

function emit(): void {
  // Copy before iterating: a listener may unsubscribe during notification.
  for (const l of Array.from(listeners)) {
    try { l(); } catch { /* one bad subscriber must not stall the rest */ }
  }
}

export function getSnapshot(): CallSnapshot {
  return snapshot;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Begin a new call. Replaces any previous snapshot outright — the engine is
 * responsible for having torn the old call down first (see engine.hangUp).
 */
export function begin(p: StartParams): CallSnapshot {
  snapshot = startSnapshot(p);
  emit();
  return snapshot;
}

/**
 * Apply an event. Notifies subscribers ONLY when the reducer actually produced
 * a new snapshot, so the re-send storms around call setup — repeated
 * answer_applied, repeated offer_sent, repeated identical remote_stream — cost
 * nothing at all in the UI.
 */
export function dispatch(e: CallEvent, now: number = Date.now()): CallSnapshot {
  const next = reduce(snapshot, e, now);
  if (next === snapshot) return snapshot;
  snapshot = next;
  emit();
  return snapshot;
}

/**
 * Return to idle. Called after a finished call's screen has popped, so a stale
 * `ended` snapshot can't be mistaken for a live call by anything that mounts
 * later.
 */
export function reset(): void {
  if (snapshot === IDLE_SNAPSHOT) return;
  snapshot = IDLE_SNAPSHOT;
  emit();
}

/** True when a call is live enough that a second one is "call waiting". */
export function isActive(): boolean {
  return snapshot.status !== 'ended' && !!snapshot.chatId;
}

export default {};
