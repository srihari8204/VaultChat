// lib/family/circle.ts — Circle lifecycle on top of existing groups. A Circle IS
// a group chat (no custom server type); we just track which groups are Circles
// locally (store) and expose create / join / invite / member helpers.

import { createGroupChat, getChat, createInviteLink, joinViaInvite, updateChat, removeChatMember, setMemberRole, type ChatMember } from '../chatService';
import { addCircle, removeCircle, type CircleRef } from './store';
import type { GroupRef } from '../groups/store';
// The circle registry moved to lib/groups/store (typed groups). Leaving must
// clear BOTH: forgetting only the legacy key left the group listed in Family
// Space and the Mini Apps tile after the user had already left it.
import { removeGroup, saveGroup, setActiveGroupId } from '../groups/store';
import { type CircleMember } from './types';

/**
 * Create a circle as a TYPED `family` group and register it where the hub
 * reads (lib/groups/store). Writing only the legacy circle key used to lose
 * it: listGroups reads that key once, at its one-shot migration, and the hub
 * adopts server chats only when they carry a groupType — so a circle created
 * here never appeared anywhere.
 */
export async function createCircle(name: string): Promise<CircleRef> {
  const n = name.trim() || 'Family Circle';
  const g = await createGroupChat(n, { allowEmpty: true }, { groupType: 'family' });
  const ref: CircleRef = { id: String(g.id), name: n };
  await saveGroup({ id: ref.id, name: n, groupType: g.groupType ?? 'family' });
  await setActiveGroupId(ref.id);
  await addCircle(ref);   // legacy key, kept for a rollback build
  return ref;
}

export type JoinResult = CircleRef & { pending: boolean; alreadyMember: boolean };

/**
 * Join by code. `pending` means an admin must approve first — the group is not
 * registered locally then, since the user is not in it yet.
 */
export async function joinCircle(code: string): Promise<JoinResult> {
  const r = await joinViaInvite(code.trim());
  const id = String(r.chatId);
  const pending = !!r.pending;
  const alreadyMember = !!r.alreadyMember;
  let name = 'Family Circle';
  if (pending) return { id, name, pending, alreadyMember };
  let groupType: GroupRef['groupType'] = null;
  try {
    const chat: any = await getChat(id);
    if (chat?.name) name = chat.name;
    groupType = chat?.groupType ?? null;
  } catch {}
  const ref: CircleRef = { id, name };
  await saveGroup({ id, name, groupType });
  await setActiveGroupId(id);
  await addCircle(ref);
  return { ...ref, pending, alreadyMember };
}

/** A shareable join code for the circle (never expires, unlimited uses by default). */
export async function circleInviteCode(circleId: string): Promise<string> {
  const link = await createInviteLink(circleId, { expiresInHours: 0, maxUses: 0 });
  return link.code;
}

export async function circleMembers(circleId: string): Promise<CircleMember[]> {
  const chat = await getChat(circleId);
  return (chat?.members ?? [])
    .filter((m: ChatMember) => !m.leftAt)
    .map((m: ChatMember) => ({
      id: String(m.userId),
      name: m.name || m.email || 'Member',
      avatar: m.photoURL ?? null,
      role: (m.role === 'owner' || m.role === 'admin' ? 'guardian' : 'member') as CircleMember['role'],
    }));
}

// ─── Circle CRUD (all on existing group endpoints — no new server surface) ───

export async function renameCircle(circleId: string, name: string): Promise<void> {
  const n = name.trim();
  if (!n) throw new Error('Name required');
  await updateChat(circleId, { name: n });
  await addCircle({ id: circleId, name: n }); // upsert refreshes the local ref
}

/** 403/404 on a membership call: the server already has us out (or the group is gone). */
const alreadyGone = (e: any) => e?.status === 403 || e?.status === 404;

/**
 * Leave the circle (self-remove) and forget it locally. Throws when the server
 * refused: forgetting locally after a failed leave hid a group the user was
 * still in — and still sharing a location with.
 */
export async function leaveCircle(circleId: string, myId: string): Promise<void> {
  try { await removeChatMember(circleId, myId); }
  catch (e: any) { if (!alreadyGone(e)) throw e; }
  await removeCircle(circleId);
  await removeGroup(circleId).catch(() => {});
}

/** Guardian-only: kick a member out of the circle. */
export async function removeCircleMember(circleId: string, userId: string): Promise<void> {
  await removeChatMember(circleId, userId);
}

/** Guardian-only: promote/demote between guardian (group admin) and member. */
export async function setGuardian(circleId: string, userId: string, guardian: boolean): Promise<void> {
  await setMemberRole(circleId, userId, guardian ? 'admin' : 'member');
}

/** Guardian-only: disband the circle — remove every member, then ourselves.
 * There is no group-delete endpoint; an emptied group is equivalent (nobody can
 * see or rejoin it, invite links die with the membership). */
export async function deleteCircle(circleId: string, myId: string): Promise<void> {
  // Every failure is reported, not swallowed: a half-disbanded circle whose
  // remaining members still see each other must not look deleted. We stay a
  // member (and keep it listed) until everyone else is really out, so the user
  // can retry.
  const members = await circleMembers(circleId);
  let failed = 0;
  for (const m of members) {
    if (m.id === myId) continue;
    try { await removeChatMember(circleId, m.id); }
    catch (e: any) { if (!alreadyGone(e)) failed++; }
  }
  if (failed) {
    throw new Error(`${failed} member${failed === 1 ? '' : 's'} could not be removed. The circle was not deleted — try again.`);
  }
  try { await removeChatMember(circleId, myId); }
  catch (e: any) { if (!alreadyGone(e)) throw e; }
  await removeCircle(circleId);
  await removeGroup(circleId).catch(() => {});
}
