// lib/family/historyGate.ts — decide the history permission BEFORE reading a
// track, instead of guessing when the cached answer is missing.
//
// GroupRef.permissions is a cache of the server's answer and it is absent
// until a getChat has landed (a migrated circle, a space never made active,
// anything adopted offline). historyAccess() rightly reports that as
// 'unknown' — but both history screens then treated unknown as allowed and
// loaded every member's track. Unknown is now resolved by asking the server
// (GET /chats/:id carries the caller's resolved permission set). If the
// server cannot be asked, this throws and the screen shows "not loaded" with
// a Retry: it neither denies (a false fact about the viewer) nor reveals.

import { getGroup, historyAccess, saveGroup, type GroupRef } from '../groups/store';
import { getChat } from '../chatService';
import type { Permission } from '../groups/permissions';

/** The cached group, or — when its history permission is unknown, or the
 *  group is not in the local registry at all — the server's answer folded in
 *  (and cached for next time when the group is registered). */
export async function groupWithHistoryAccess(circleId: string): Promise<GroupRef | null> {
  const g = await getGroup(circleId);
  // A circle MISSING from the registry (a deep link, another device's space)
  // is not "legacy and open": historyAccess(null) says 'allowed' for untyped
  // legacy groups, so a missing one has to be asked about, not waved through.
  if (g && historyAccess(g) !== 'unknown') return g;
  const chat: any = await getChat(circleId);   // throws offline: caller shows "not loaded"
  // The server serialises an empty set as null; it answered, so that is "none".
  const permissions = (Array.isArray(chat?.permissions) ? chat.permissions : []) as Permission[];
  const resolved: GroupRef = {
    ...(g as GroupRef),
    id: circleId,
    name: g?.name ?? chat?.name ?? '',
    groupType: chat?.groupType ?? g?.groupType ?? null,
    ...(chat?.myRole ? { role: chat.myRole } : {}),
    permissions,
  };
  // A cache write; the decision does not depend on it. Only for a group the
  // registry already holds — adopting spaces is the hub's job, not this gate's.
  if (g) saveGroup(resolved).catch(() => {});
  return resolved;
}
