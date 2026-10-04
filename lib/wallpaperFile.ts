// lib/wallpaperFile.ts — which copied wallpaper file a save leaves behind.
//
// app/chat-wallpaper.tsx copies a picked photo into <documents>/wallpapers/
// (the picker's cache URI can be evicted). Each storage key owns its copies,
// so once a new choice is stored the previous copy is garbage — unless the
// "new" choice is that same file (re-saving an unchanged photo).

/**
 * The file to delete after `prevRaw` (the stored JSON, or null/sentinel) was
 * replaced by a wallpaper whose value is `nextValue` (null for a non-image).
 * Only files inside `dir` are ever returned: never a picker or user URI.
 */
export function replacedWallpaperFile(
  prevRaw: string | null | undefined,
  nextValue: string | null | undefined,
  dir: string,
): string | null {
  if (!prevRaw || !dir) return null;
  let prev: unknown;
  try { prev = JSON.parse(prevRaw); } catch { return null; }
  if (!prev || typeof prev !== 'object') return null;
  const { type, value } = prev as { type?: unknown; value?: unknown };
  if (type !== 'image' || typeof value !== 'string') return null;
  if (!value.startsWith(dir)) return null;
  const name = value.slice(dir.length);
  if (!name || name.includes('/') || /^\.+$/.test(name)) return null;
  return value === nextValue ? null : value;
}
