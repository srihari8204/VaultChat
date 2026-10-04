// lib/family/hubGroups.ts — the Family/Spaces hub's space list, moved out of
// app/family.tsx unchanged: the local group registry reconciled against the
// server's chat list (prune what we left, adopt typed spaces we are in).

import { listChats, getChat } from '../chatService';
import { listGroups, reconcileGroups, saveGroup, type GroupRef } from '../groups/store';
import { type Permission } from '../groups/permissions';

// The group registry is local, so a group you LEFT from the Chats screen would
// otherwise linger here (and in the Mini Apps tile) forever. Reconcile against
// the server's chat list on every load; a failed fetch changes nothing.
export async function loadGroupsReconciled(): Promise<GroupRef[]> {
  const groups = await listGroups();
  try {
    const chats = await listChats();
    // Prune spaces we are no longer in.
    let next = await reconcileGroups(chats.map((c: any) => String(c.id)));

    // ADOPT spaces we ARE in but have never seen on this device.
    //
    // reconcileGroups only ever removed. The registry was written by whichever
    // device created or joined the space, so a School or Employee space set up
    // on another phone — or joined from an invitation — never appeared here at
    // all: not in the switcher, not in the dashboard, nowhere. That is what
    // "school and employee are not working" looks like from the outside, and it
    // gets worse the more a family uses more than one space.
    //
    // The chat list already carries the id, name and type, so adopting is free:
    // no extra request, and it happens on the same load that was already
    // pruning.
    // The chat LIST does not carry group_type — only GET /chats/:id does — so
    // the type has to be fetched for chats we have never seen. Bounded at 8 and
    // only for unknown GROUP chats, so the common case (nothing new) costs
    // nothing and a user in many ordinary group chats is not punished for it.
    // Anything that is not a typed space is skipped and simply not adopted.
    const known = new Set(next.map((g) => String(g.id)));
    const unknown = chats
      .filter((c: any) => c?.type === 'group' && !known.has(String(c.id)))
      .slice(0, 8);
    for (const c of unknown) {
      try {
        const detail: any = await getChat(String(c.id));
        if (!detail?.groupType) continue;   // an ordinary group chat, not a space
        next = await saveGroup({
          id: String(c.id),
          name: detail.name || c.name || 'Space',
          groupType: detail.groupType,
          icon: detail.icon ?? null,
          color: detail.color ?? null,
          // Adopt the ROLE AND PERMISSIONS the same response already carries
          // (2026-09-17). Saving the type without them cached the space as
          // "typed, permissions unknown", and until the user made it active
          // — the only path that used to write permissions — every screen
          // reading the registry had to guess. Free: no extra request.
          // Spread conditionally because upsert() merges, and an explicit
          // `permissions: undefined` would BLANK a set we already had.
          ...(Array.isArray(detail.permissions)
            ? { role: detail.myRole, permissions: detail.permissions as Permission[] }
            : {}),
        } as GroupRef);
      } catch { /* one unreadable chat must not stop the others being adopted */ }
    }
    return next;
  } catch {
    return groups;   // offline — keep what we have rather than hiding everything
  }
}
