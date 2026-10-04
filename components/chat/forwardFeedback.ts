// components/chat/forwardFeedback.ts — the source chat's feedback for a forward.
//
// A forward is queued into the TARGET chat's outbox, so its bubble (and its
// "not sent" state) lives there. The chat you forwarded FROM remembers which
// queued ids were its forwards, and reports a server rejection ('failed' is
// emitted only for a permanent rejection — offline keeps retrying) by the
// target's name. 'sent' just forgets the id. Pure over the queue's event bus,
// so components/chat/forwardFeedback.selftest.ts drives it with a fake bus.
//
// appForwardFeedback is the one app-wide instance the chat screen uses: it is
// created by the first forward and never disposed, so a rejection is reported
// even after the user has left the chat they forwarded from (the queue's bus is
// module state in lib/messageQueue, alive for the whole JS runtime).
//
// After an app restart the in-memory map is empty, so the outbox row carries the
// target's name too (lib/messageQueue QueuedMessage.forwardTo, local only) and
// the 'failed' event hands it back. The root's boot sequence arms this tracker
// as the outbox starts draining, once the launch gate has let the launch in
// (components/chat/forwardRejectionReport).
//
// ponytail: a launch that starts at the lock or sign-in screen is not armed at
// boot (the Alert names a chat), only by the next forward; a rejection in that
// window shows only as the red bubble in the target chat. Arming on unlock
// would need an "unlocked" signal the lock screens do not publish today.

type FailedEvent = { tempId: string; error: string; forwardTo?: string };
type SentEvent = { tempId: string };
export interface ForwardQueueBus {
  (event: 'failed', fn: (e: FailedEvent) => void): () => void;
  (event: 'sent', fn: (e: SentEvent) => void): () => void;
}

export function forwardFeedback(on: ForwardQueueBus, onRejected: (name: string, error: string) => void) {
  const inFlight = new Map<string, string>();
  const offFailed = on('failed', ({ tempId, error, forwardTo }) => {
    const name = inFlight.get(tempId) ?? forwardTo;
    if (name == null) return;
    inFlight.delete(tempId);
    onRejected(name, error);
  });
  const offSent = on('sent', ({ tempId }) => { inFlight.delete(tempId); });
  return {
    /** Remember a queued forward (by the outbox's tempId) and its target's name. */
    track(tempId: string, name: string) { inFlight.set(tempId, name); },
    pending(): number { return inFlight.size; },
    dispose() { offFailed(); offSent(); inFlight.clear(); },
  };
}

let appWide: ReturnType<typeof forwardFeedback> | null = null;
/** The app-wide tracker: subscribes to `on` once, on first use, and stays
 *  subscribed. Later calls return the same instance (their arguments are
 *  ignored), so a remounted chat screen cannot double-subscribe. */
export function appForwardFeedback(on: ForwardQueueBus, onRejected: (name: string, error: string) => void) {
  appWide ??= forwardFeedback(on, onRejected);
  return appWide;
}

/** "Forwarding to X", numbered so a repeat of the same text is a new notice
 *  (remounted: announced again, with a fresh 4 s timer). */
export type ForwardNote = { text: string; n: number };
export function nextForwardNote(prev: ForwardNote | null, name: string): ForwardNote {
  return { text: `Forwarding to ${name}`, n: (prev?.n ?? 0) + 1 };
}
