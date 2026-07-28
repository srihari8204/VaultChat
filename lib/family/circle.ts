// lib/family/circle.ts — Circle lifecycle on top of existing groups. A Circle IS
// a group chat (no custom server type); we just track which groups are Circles
// locally (store) and expose create / join / invite / member helpers.

import { createGroupChat, getChat, createInviteLink, joinViaInvite, type ChatMember } from '../chatService';
import { addCircle, type CircleRef } from './store';
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
