// lib/scopedChoice.ts — per-chat vs global appearance choice (bubble theme,
// wallpaper).
//
// A per-chat value wins over the global one. "Default" on a PER-CHAT screen is
// stored explicitly as SCOPED_DEFAULT, because deleting the per-chat key made
// the chat fall back to the global choice: a chat could never opt back to the
// app default while a global colour or wallpaper was set. On the global screen
// "Default" still just removes the key.

export const SCOPED_DEFAULT = 'default';

/** The effective stored value, or null for "app default". */
export function resolveScoped(perChat: string | null | undefined, global: string | null | undefined): string | null {
  if (perChat === SCOPED_DEFAULT) return null;
  const v = perChat || global;
  return v && v !== SCOPED_DEFAULT ? v : null;
}
