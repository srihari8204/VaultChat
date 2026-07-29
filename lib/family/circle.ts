// lib/family/circle.ts — Circle lifecycle on top of existing groups. A Circle IS
// a group chat (no custom server type); we just track which groups are Circles
// locally (store) and expose create / join / invite / member helpers.

import { createGroupChat, getChat, createInviteLink, joinViaInvite, updateChat, removeChatMember, setMemberRole, type ChatMember } from '../chatService';
import { addCircle, removeCircle, type CircleRef } from './store';
import { type CircleMember } from './types';

export async function createCircle(name: string): Promise<CircleRef> {
  const g = await createGroupChat(name.trim() || 'Family Circle', { allowEmpty: true });
  const ref: CircleRef = { id: String(g.id), name: name.trim() || 'Family Circle' };
  await addCircle(ref);
  return ref;
}

export async function joinCircle(code: string): Promise<CircleRef> {
  const r = await joinViaInvite(code.trim());
  const id = String(r.chatId);
  let name = 'Family Circle';
  try { const chat = await getChat(id); if (chat?.name) name = chat.name; } catch {}
  const ref: CircleRef = { id, name };
  await addCircle(ref);
  return ref;
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

/** Leave the circle (self-remove) and forget it locally. */
export async function leaveCircle(circleId: string, myId: string): Promise<void> {
  try { await removeChatMember(circleId, myId); } catch {}
  await removeCircle(circleId);
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
  const members = await circleMembers(circleId).catch(() => [] as CircleMember[]);
  for (const m of members) {
    if (m.id !== myId) await removeChatMember(circleId, m.id).catch(() => {});
  }
  await removeChatMember(circleId, myId).catch(() => {});
  await removeCircle(circleId);
}
