// components/chat/forwardFeedback.ts — the source chat's feedback for a forward.
//
// A forward is queued into the TARGET chat's outbox, so its bubble (and its
// "not sent" state) lives there. The chat you forwarded FROM remembers which
// queued ids were its forwards, and reports a server rejection ('failed' is
// emitted only for a permanent rejection — offline keeps retrying) by the
// target's name. 'sent' just forgets the id. Pure over the queue's event bus,
// so components/chat/forwardFeedback.selftest.ts drives it with a fake bus.
//
// ponytail: lives as long as the chat screen that created it; a rejection after
// the user leaves shows only as the red bubble in the target chat. Move it to
// an app-level outbox listener if forwards need feedback from anywhere.

type FailedEvent = { tempId: string; error: string };
type SentEvent = { tempId: string };
export interface ForwardQueueBus {
  (event: 'failed', fn: (e: FailedEvent) => void): () => void;
  (event: 'sent', fn: (e: SentEvent) => void): () => void;
}

export function forwardFeedback(on: ForwardQueueBus, onRejected: (name: string, error: string) => void) {
  const inFlight = new Map<string, string>();
  const offFailed = on('failed', ({ tempId, error }) => {
    const name = inFlight.get(tempId);
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

/** "Forwarding to X", numbered so a repeat of the same text is a new notice
 *  (remounted: announced again, with a fresh 4 s timer). */
export type ForwardNote = { text: string; n: number };
export function nextForwardNote(prev: ForwardNote | null, name: string): ForwardNote {
  return { text: `Forwarding to ${name}`, n: (prev?.n ?? 0) + 1 };
}
