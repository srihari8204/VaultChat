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

/** The cached group, or — when its history permission is unknown — the same
 *  group with the server's answer folded in (and cached for next time). */
export async function groupWithHistoryAccess(circleId: string): Promise<GroupRef | null> {
  const g = await getGroup(circleId);
  if (historyAccess(g) !== 'unknown') return g;
  const chat: any = await getChat(circleId);   // throws offline: caller shows "not loaded"
  // The server serialises an empty set as null; it answered, so that is "none".
  const permissions = (Array.isArray(chat?.permissions) ? chat.permissions : []) as Permission[];
  const resolved: GroupRef = {
    ...(g as GroupRef),
    id: circleId,
    groupType: chat?.groupType ?? g?.groupType ?? null,
    ...(chat?.myRole ? { role: chat.myRole } : {}),
    permissions,
  };
  saveGroup(resolved).catch(() => {});   // a cache write; the decision below does not depend on it
  return resolved;
}
