// lib/msgIds.ts — wire ids are strings; the device is number-keyed.
//
// Deliberately its OWN module with zero imports. It lives apart from
// chatService so `lib/msgIds.selftest.ts` can exercise it under plain tsx —
// importing chatService pulls in react-native, which the selftest runner
// cannot transform, and a rule nobody can run is a rule that rots.

/**
 * Coerce a message row's wire ids to numbers, in place.
 *
 * `chatsPublicMsg` serializes every BIGINT as a string (`ID string`,
 * `ReplyToID *string`) to mirror node-pg, on EVERY path: the GET page, the
 * POST/PATCH ack, the socket payload and `/chats/delta`.
 *
 * Four call sites had each grown their own `Number(msg.id)` patch and not one
 * of them touched `replyToId` — which is why a reply quote rendered the
 * "Replied message / Tap to view" placeholder: the reply-target lookup is a
 * `Map<number, …>` and `extraReplies`/`getCachedMessagesByIds` both filter on
 * `typeof id === 'number'`, so a string `replyToId` missed in memory AND in
 * the cache. `cacheMessages` skips non-number ids too, so un-normalized rows
 * were silently never persisted — history that rendered fine and vanished on
 * the next cold start.
 *
 * Mutates in place: these are freshly-parsed JSON payloads with no other owner.
 * `null` is preserved rather than coerced — `Number(null)` is 0, which would
 * point every ordinary message at message 0 as its reply target.
 */
export function normalizeMsgIds<T>(m: T): T {
  const x = m as any;
  if (x && x.id != null) x.id = Number(x.id);
  if (x && x.replyToId != null) x.replyToId = Number(x.replyToId);
  return m;
}

/**
 * Strict wire-id parser: the canonical decimal rendering of a positive
 * BIGSERIAL, and nothing else. Returns null — never throws — for anything it
 * cannot hold; the caller decides what null means (drop the row for `id`,
 * `null` for every pointer field).
 *
 * A SIBLING of normalizeMsgIds, not a replacement: that one is a bare
 * `Number()` on the JSON paths and validates nothing. This one is for the
 * typed-wire boundary, where a rejection is a real outcome.
 *
 * Rejects, deliberately: whitespace (`Number` trims, the regex does not),
 * fractions, exponent/hex, trailing characters, leading zeros, empty (= proto3
 * absence, which means null and never 0), zero (the optimistic-bubble band),
 * negatives (the Exit-Kit import band, `localDb.importMessages`) — and
 * anything past 2^53-1.
 *
 * THE SAFE-INTEGER BOUND IS REACHABLE, not a formality: BIGSERIAL is int64.
 * Rounding 2^53+1 down to 2^53 produces an id that collides with a real row
 * under the `ON CONFLICT(id)` upsert in localDb.cacheMessages — one message
 * silently overwriting a different one. Rejecting degrades; rounding corrupts.
 *
 * Regex precedent: lib/ccwire/transport.ts (ack id). Bound precedent:
 * lib/receipts.ts (`mark`).
 */
export function wireId(s: unknown): number | null {
  if (typeof s !== 'string' || !/^[1-9][0-9]*$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export default normalizeMsgIds;
