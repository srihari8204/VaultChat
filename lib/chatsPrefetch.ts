// lib/chatsPrefetch.ts — start the chat-list request at BOOT, not at mount.
//
// WHY THIS EXISTS (measured 2026-09-23, Redmi Note 8 Pro, WiFi, 160ms RTT to
// api.corefinite.com, n=5 cold starts):
//
//   boot_effect_start      +0ms
//   chats_paint_cache    +395ms   cached rows on screen, no network involved
//   chats_fetch_start    +395ms   listChats() dispatched — ONLY now
//   chats_fetch_done     +883ms   ~488ms later, on a connection it had to open
//
// listChats() was dispatched at +395ms because that is when the Chats screen's
// effect runs, not because anything it needs was unavailable earlier. It needs a
// token and a network, both of which exist within the first few tens of ms. The
// 488ms itself is mostly TCP+TLS: the same call on an already-warm connection
// measures ~206ms, so ~280ms of it is handshake that has to happen once either
// way. Starting it earlier does not make the request faster — it moves it off
// the end of the boot, overlapping it with JS init and the first paint that were
// happening anyway.
//
// THIS IS A HEAD START, NOT A SECOND SOURCE OF TRUTH. The screen consumes this
// exact promise; everything it does with the rows afterwards — mergeChats,
// cacheChats, the unread badge, the error path — is untouched. If the head start
// is missing, stale or failed, the screen calls listChats() itself exactly as it
// always did, so the worst case is the behaviour that shipped before this file.
//
// Deliberately NOT a cache: one request, consumed once, then gone. A cache here
// would need invalidation on every mutation the app performs, which is the bug
// factory this avoids by simply not existing after first use.

import { listChats } from './chatService';
import type { ChatSummary } from './chatService';
import { mark } from './perf';

type Primed = { at: number; p: Promise<ChatSummary[]> };

let primed: Primed | null = null;

/**
 * Dispatch the boot chat-list request. Idempotent and fire-and-forget: calling
 * it twice keeps the first request rather than opening a second one.
 *
 * The caller must already know there is a token — this makes no auth decision
 * of its own, so it can never turn a signed-out launch into a request.
 */
export function primeChats(): void {
  if (primed) return;
  mark('chats_prime_start');
  const p = listChats();
  // Attached HERE, at dispatch, not where it is awaited. Between this line and
  // the screen consuming it there are hundreds of ms of boot, and a rejection
  // with no handler in that window is an unhandled rejection. The catch only
  // stops the warning — `p` itself still rejects for whoever awaits it, which is
  // what lets the screen fall back and report the failure as it always did.
  p.then(
    rows => mark('chats_prime_done', { rows: rows.length }),
    () => mark('chats_prime_failed'),
  );
  primed = { at: Date.now(), p };
}

/**
 * Hand the boot request to the first caller that wants it, or null.
 *
 * SINGLE USE, and cleared before the age check so a stale entry cannot be
 * re-offered to a later caller either.
 *
 * `maxAgeMs` matters because a cold start does not always land on Chats: the app
 * may open on another tab, or on a chat from a notification, and the user may
 * reach the list minutes later. Rows fetched at boot would be silently old by
 * then — and unlike the on-disk cache, they would arrive wearing the authority
 * of a fresh network answer. Past the window the screen fetches normally.
 */
export function takePrimedChats(maxAgeMs = 10_000): Promise<ChatSummary[]> | null {
  const held = primed;
  primed = null;
  if (!held) return null;
  if (Date.now() - held.at > maxAgeMs) {
    mark('chats_prime_stale');
    return null;
  }
  return held.p;
}

/** Test seam: forget any in-flight head start. */
export function resetChatsPrefetch(): void {
  primed = null;
}

export default { primeChats, takePrimedChats, resetChatsPrefetch };
