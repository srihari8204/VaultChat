// lib/forwardPolicy.ts — how far a message has travelled, and what that changes.
//
// AUDIT F10. Messages already carried a "Forwarded" label, but nothing counted
// HOPS, so a message on its fiftieth relay looked exactly like one a friend
// passed along once. Every large messenger added this after learning what
// encrypted broadcast does: end-to-end encryption means nobody — not even the
// operator — can read a viral chain, so the only available brake is telling the
// reader how far it has come and making the next hop deliberate.
//
// THE HOP COUNT IS NOT A SECURITY CONTROL, and this file will not pretend
// otherwise. It rides in the message's own metadata, which the sending client
// writes, so a modified client can reset it to zero. WhatsApp's has the same
// property. It is honest signalling for honest clients, which is the entire
// mechanism — and it is still worth having, because virality is driven by
// ordinary people using ordinary apps, not by people patching binaries.
//
// Deliberately free of react-native imports so it runs under plain Node; see
// lib/forwardPolicy.selftest.ts.

/**
 * Hops at which a message becomes "forwarded many times".
 *
 * Five matches WhatsApp. The number is not magic, but it is well chosen: a
 * message reaching a fifth independent relay has left the circle of people who
 * know where it came from, which is the moment the reader most needs telling.
 */
export const FORWARD_MANY_THRESHOLD = 5;

/** Targets one forward action may fan out to, by how far the message has come. */
export const FORWARD_LIMIT_NORMAL = 5;
export const FORWARD_LIMIT_MANY = 1;

export interface ForwardMeta {
  forwardedFrom?: { messageId: number; chatId: string; senderId: string };
  forwardScore?: number;
}

/**
 * How many hops this message has already made.
 *
 * A message with `forwardedFrom` but no score predates this feature — it was
 * forwarded at least once, so it counts as 1 rather than 0. Treating it as
 * unforwarded would silently strip the label off every message already in
 * people's histories.
 */
export function forwardScoreOf(meta: unknown): number {
  if (!meta || typeof meta !== 'object') return 0;
  const m = meta as ForwardMeta;
  const raw = m.forwardScore;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // Clamp: a hostile client cannot inflate this into a rendering problem.
    return Math.min(Math.floor(raw), 1000);
  }
  return m.forwardedFrom ? 1 : 0;
}

/** The score the NEXT hop carries. */
export function nextForwardScore(meta: unknown): number {
  return forwardScoreOf(meta) + 1;
}

export function isForwarded(meta: unknown): boolean {
  return forwardScoreOf(meta) > 0;
}

export function isForwardedManyTimes(meta: unknown): boolean {
  return forwardScoreOf(meta) >= FORWARD_MANY_THRESHOLD;
}

/**
 * The label to show above the bubble, or null when the message is original.
 *
 * Two tiers and no number. Showing "forwarded 7 times" would invite reading it
 * as a popularity score, which is the opposite of the intended effect.
 */
export function forwardLabel(meta: unknown): string | null {
  const score = forwardScoreOf(meta);
  if (score >= FORWARD_MANY_THRESHOLD) return '↪↪ Forwarded many times';
  if (score > 0) return '↪ Forwarded';
  return null;
}

/**
 * How many chats this message may be forwarded to in one action.
 *
 * The picker is single-select today, so this is satisfied by construction — it
 * exists so the rule lives with the rest of the policy rather than being
 * reinvented (or forgotten) the day the picker gains multi-select.
 */
export function maxForwardTargets(meta: unknown): number {
  return isForwardedManyTimes(meta) ? FORWARD_LIMIT_MANY : FORWARD_LIMIT_NORMAL;
}

/**
 * What to tell someone about to forward this, or null when there is nothing
 * worth saying. Only the many-times case earns a notice: a warning on every
 * ordinary forward is noise that trains people to dismiss it unread.
 */
export function forwardNotice(meta: unknown): string | null {
  return isForwardedManyTimes(meta)
    ? 'This has been forwarded many times. It can be sent to one chat at a time.'
    : null;
}
