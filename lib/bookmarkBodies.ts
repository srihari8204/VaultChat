// lib/bookmarkBodies.ts — which body a bookmark row shows, and what may be cached.
//
// The readable copy of a bookmarked message is the SEALED local snapshot
// (lib/chatService.ts cacheBookmarkPlaintext). The server row's `content` is
// E2EE ciphertext while it still exists, so it is shown only when it is not an
// envelope. The plain AsyncStorage list cache (lib/localCache.ts) must never
// hold a decrypted body, so rows are cached with `content` removed and the body
// is re-read from the sealed store when the cache is painted.

export interface BookmarkLike {
  message: { content: string | null } | null;
}

export function bookmarkBody(
  server: string | null | undefined,
  local: string | null | undefined,
  isCipher: (s: string) => boolean,
): string | null {
  if (local) return local;
  if (server && !isCipher(server)) return server;
  return null;
}

/**
 * View-once and Invisible Ink messages are shown only in place, in their own
 * bubble. Bookmarks made before Star stopped snapshotting them may still hold
 * a sealed copy, so the list hides the body whenever the message carries one
 * of these flags.
 */
export function isProtectedMessage(meta: unknown): boolean {
  const m = meta as { viewOnce?: unknown; invisibleInk?: unknown } | null | undefined;
  return !!(m && typeof m === 'object' && (m.viewOnce || m.invisibleInk));
}

export function withoutBodies<T extends BookmarkLike>(rows: readonly T[]): T[] {
  return rows.map(r => (r.message && r.message.content != null
    ? { ...r, message: { ...r.message, content: null } }
    : r));
}

export function hasBodies(rows: readonly BookmarkLike[]): boolean {
  return rows.some(r => r.message?.content != null);
}
