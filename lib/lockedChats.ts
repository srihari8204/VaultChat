// lib/lockedChats.ts — which chats are locked, read once for a whole list.
//
// Screens that show message text OUTSIDE the chat (the Chats row preview,
// global search) must not show a locked chat's text without unlocking it.
// app/scheduled.tsx, app/bookmarks.tsx and app/message-reminder.tsx already
// apply the same rule per chat with isChatLocked(id).catch(() => true); this is
// that rule for a list: one read of the lock table instead of one per row.

import { getAllLocks, type LockedChat } from './chatLock';

/** Ids whose lock is on (same test as lib/chatLock.getLock). */
export function lockedIdsOf(all: Record<string, LockedChat | undefined>): Set<string> {
  const out = new Set<string>();
  for (const [id, e] of Object.entries(all)) if (e && e.locked) out.add(id);
  return out;
}

/**
 * The locked chat ids, or null when the lock table cannot be read. Null means
 * "treat every chat as locked": lib/chatLock fails closed, and so do its
 * callers.
 */
export async function lockedChatIds(): Promise<Set<string> | null> {
  try { return lockedIdsOf(await getAllLocks()); } catch { return null; }
}

/** True when a chat's text must be hidden, given lockedChatIds()'s answer. */
export function isLockedIn(locked: ReadonlySet<string> | null, chatId: string): boolean {
  return locked === null || locked.has(chatId);
}
