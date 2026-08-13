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
    out.push({ ...ordered[0], _album: ordered });
  }
  return out;
}

export default groupAlbums;
