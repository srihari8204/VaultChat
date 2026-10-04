// lib/peerSafetySummary.ts — the one-line summary of the direct chats' safety
// states shown in the Encryption status screen's top card
// (app/d2de-status.tsx), from the same per-contact states its picker shows
// (lib/peerSafetyStatus). Pure, so lib/peerSafetySummary.selftest.ts runs it.

import type { PeerSafetyStatus } from './peerSafetyStatus';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 of 5 direct chats verified · 1 security code changed · checking 2 more…".
 *  `states` are the contacts checked so far, `total` how many direct chats. */
export function peerSafetySummary(states: readonly PeerSafetyStatus[], total: number): string {
  if (total <= 0) return 'No direct chats yet.';
  const count = (s: PeerSafetyStatus) => states.filter((x) => x === s).length;
  const parts = [`${count('verified')} of ${plural(total, 'direct chat', 'direct chats')} verified`];
  if (count('changed')) parts.push(`${plural(count('changed'), 'security code', 'security codes')} changed`);
  if (count('nokey')) parts.push(`${count('nokey')} without end-to-end encryption yet`);
  if (count('unknown')) parts.push(`${count('unknown')} could not be checked`);
  if (states.length < total) parts.push(`checking ${total - states.length} more…`);
  return parts.join(' · ');
}
