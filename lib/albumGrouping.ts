// lib/albumGrouping.ts — collapse an album into one timeline row.
//
// Picking ten photos sends ten messages. That is deliberate and stays that way:
// each keeps its own id, its own ciphertext, its own retry and its own delivery
// receipt, so nothing about sending, resending or receipts has to learn what an
// album is. Only the TIMELINE groups them, and only for layout.
//
// This lives in lib/ rather than inside the chat screen for one reason: logic
// inside a .tsx component cannot be executed by a test harness, so it can only
// ever be reviewed by eye. Here it runs under `npm test`.

/** The minimum an album member has to expose. */
export interface AlbumRow {
  id: number;
  _tempId?: string;
  meta?: { albumId?: string; albumIndex?: number } | null;
  _album?: AlbumRow[];
  [k: string]: any;
}

/**
 * Collapse runs of same-album rows into a single row carrying `_album`.
 *
 * Rules that matter:
 *   * only ADJACENT rows merge, so an album split by someone else's message
 *     renders as two groups instead of re-ordering the conversation;
 *   * a run of one is left exactly as it was — no `_album`, no wrapper, so a
 *     single photo keeps the ordinary bubble path;
 *   * members come back in pick order (`albumIndex`), because the timeline is
 *     inverted and a run therefore arrives newest-first;
 *   * the standing row is a COPY, so the caller's array is never mutated.
 */
export function groupAlbums<T extends AlbumRow>(rows: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < rows.length; i++) {
    const albumId = rows[i]?.meta?.albumId;
    if (!albumId) { out.push(rows[i]); continue; }

    const run: T[] = [rows[i]];
    while (i + 1 < rows.length && rows[i + 1]?.meta?.albumId === albumId) {
      run.push(rows[++i]);
    }
    if (run.length === 1) { out.push(run[0]); continue; }

    const ordered = [...run].sort(
      (a, b) => (a.meta?.albumIndex ?? 0) - (b.meta?.albumIndex ?? 0));
    out.push(stableRow(albumId, ordered));
  }
  return out;
}

// ─── identity, which is the whole performance story ──────────────────────
//
// The standing row is a NEW object (`{...first, _album}`), and this runs inside
// a useMemo keyed on the message array — which is rebuilt on every incoming
// message, every receipt, every optimistic send. So a naive implementation
// hands the list a fresh album object every time anything in the chat changes,
// and the bubble's memo comparator (which tests `a.msg === b.msg`) fails: every
// album re-renders, re-resolving its media, on traffic that has nothing to do
// with it.
//
// Everywhere else the chat already preserves identity — its state updates map
// with `: x` so untouched messages keep their reference. This keeps albums to
// the same standard: when every member is reference-equal to last time, the
// previously built row is returned unchanged.
//
// Bounded by the number of albums on screen, and each entry holds only
// references the caller already holds.
const _rowCache = new Map<string, { members: readonly AlbumRow[]; row: any }>();

function stableRow<T extends AlbumRow>(albumId: string, ordered: T[]): T {
  const hit = _rowCache.get(albumId);
  if (hit && hit.members.length === ordered.length &&
      hit.members.every((m, i) => m === ordered[i])) {
    return hit.row as T;
  }
  const row = { ...ordered[0], _album: ordered } as T;
  _rowCache.set(albumId, { members: ordered, row });
  // Keep the cache from growing with a long-lived session. Albums scroll out of
  // the window and never come back; rebuilding one is a single object literal.
  if (_rowCache.size > 64) {
    for (const k of _rowCache.keys()) {
      if (_rowCache.size <= 64) break;
      if (k !== albumId) _rowCache.delete(k);
    }
  }
  return row;
}

/** Drop cached rows — call when switching chats so identity cannot leak across. */
export function resetAlbumCache(): void { _rowCache.clear(); }

export default groupAlbums;
