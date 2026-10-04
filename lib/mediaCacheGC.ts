// lib/mediaCacheGC.ts — bound the re-derivable media cache (LRU by mtime).
//
// The persistent media store (documentDirectory/media, VaultChat/Media, the
// outbox) is the user's library and is NEVER touched here. This only caps the
// CACHE dir: decrypted copies (dec_<id>, re-downloadable+re-decryptable) and any
// stray upload temps (enc_/mp_ left by a killed upload). So the cache can't grow
// unbounded, while nothing the user needs is ever deleted.

import * as FileSystem from 'expo-file-system/legacy';

const CAP_BYTES = 500 * 1024 * 1024;   // 500 MB cache ceiling
const PREFIXES = ['dec_', 'enc_', 'mp_'];

// Ephemeral protected-media plaintext (view-once / VaultView). media-viewer
// deletes these on unmount, but a crash or force-stop mid-view leaves the
// decrypted file behind — and unlike dec_*, it must NEVER survive the session:
// the server has already burned the attachment, so the only remaining copy of a
// "gone" photo would be this file. Purged unconditionally at boot, before the
// size-capped sweep below.
const EPHEMERAL_PREFIXES = ['vo_', 'vv_'];

/**
 * Plaintext the file viewers stage in the cache root: file-viewer's text/doc
 * downloads and external hand-off copies, file-preview's download, the
 * archive-viewer's downloaded archive and single-entry extractions, and
 * media-viewer's code preview. Each screen deletes its own on exit where no
 * other app may still be reading it; this prefix is how boot and logout catch
 * the rest (hand-offs, crashes, force-stops). Use it for any new viewer temp.
 */
export const VIEWER_TEMP_PREFIX = 'vt_';
/** Names those screens used before VIEWER_TEMP_PREFIX existed. Left behind by
 *  older builds; purged by the same sweep. (Hand-off copies saved under their
 *  bare original filename cannot be told apart from other files and are not.) */
const LEGACY_VIEWER_TEMP_PREFIXES = ['temp_view_', 'temp_doc_', 'preview_', 'prev_'];
const LEGACY_VIEWER_TEMP_DIRS = ['archive'];

/** True for a cache-root entry that is viewer/protected-media plaintext. */
function isEphemeralName(name: string): boolean {
  return EPHEMERAL_PREFIXES.some((p) => name.startsWith(p))
    || name.startsWith(VIEWER_TEMP_PREFIX)
    || LEGACY_VIEWER_TEMP_PREFIXES.some((p) => name.startsWith(p))
    || LEGACY_VIEWER_TEMP_DIRS.includes(name.replace(/\/$/, ''));
}

/** Mirrors mediaStore.DOC_CACHE_PREFIX; duplicated to keep this module import-free of it. */
const DOC_DIR_PREFIX = 'dc_';

/**
 * Delete every ephemeral protected-media plaintext left in the cache.
 * Unconditional (not size-capped) — see EPHEMERAL_PREFIXES. Safe to call any
 * time no protected viewer is on screen; media-viewer also cleans up its own
 * file on unmount, so this is the crash-recovery path.
 */
/**
 * Delete document plaintext staged for a viewer or an external hand-off.
 *
 * These live in `dc_<attachmentId>/` subdirectories of the cache (see
 * mediaStore.copyToCache). Before that prefix existed they were written to the
 * cache ROOT under their original filename, where they matched no sweep at all
 * and so survived revoke, view-once and logout — S2 in DOCUMENT_SURFACE_AUDIT.md.
 *
 * Pass an attachmentId to drop just that document (revocation, view-once
 * completion); pass nothing to drop all of them (logout, account switch, boot).
 *
 * Deletes only `dc_` entries. The cache also holds other apps' business and the
 * user's own library lives outside the cache entirely, so a blanket wipe is
 * exactly what this must not do.
 */
export async function purgeDocumentCache(attachmentId?: string): Promise<number> {
  let n = 0;
  try {
    const dir = (FileSystem as any).cacheDirectory;
    if (!dir) return 0;
    const want = attachmentId
      ? DOC_DIR_PREFIX + attachmentId.replace(/[^A-Za-z0-9_.-]/g, '_')
      : null;
    for (const name of await FileSystem.readDirectoryAsync(dir)) {
      if (!name.startsWith(DOC_DIR_PREFIX)) continue;
      if (want && name !== want) continue;
      await FileSystem.deleteAsync(dir + name, { idempotent: true }).catch(() => {});
      n++;
    }
  } catch {}
  return n;
}

export async function purgeEphemeralMedia(): Promise<number> {
  let n = 0;
  try {
    const dir = (FileSystem as any).cacheDirectory;
    if (!dir) return 0;
    const names = await FileSystem.readDirectoryAsync(dir);
    for (const name of names) {
      if (!isEphemeralName(name)) continue;
      await FileSystem.deleteAsync(dir + name, { idempotent: true }).catch(() => {});
      n++;
    }
  } catch {}
  return n;
}

/** Delete oldest cache files until under the cap. Call at boot (fire-and-forget). */
export async function sweepMediaCache(): Promise<void> {
  // Protected-media plaintext first, and unconditionally — a size-capped sweep
  // would leave it on disk whenever the cache happens to be under the ceiling.
  try {
    const purged = await purgeEphemeralMedia();
    if (purged > 0) console.log(`[cacheGC] purged ${purged} ephemeral protected-media/viewer temp file(s)`);
  } catch { /* best-effort */ }

  // P4.2: the message cache is bounded on the same boot sweep as media. It
  // grew forever, and the local full-scan paths scale with its size. Runs
  // first and independently — a media-sweep early return must not skip it.
  try {
    const { pruneMessageCache } = await import('./localDb');
    const n = await pruneMessageCache();
    if (n > 0) console.log(`[cacheGC] pruned ${n} cached message(s)`);
  } catch { /* best-effort */ }

  try {
    const dir = (FileSystem as any).cacheDirectory;
    if (!dir) return;
    const names = await FileSystem.readDirectoryAsync(dir);
    const ours = names.filter((n: string) => PREFIXES.some((p) => n.startsWith(p)));
    if (!ours.length) return;

    const files: { uri: string; size: number; mtime: number }[] = [];
    let total = 0;
    for (const n of ours) {
      const uri = dir + n;
      const info: any = await FileSystem.getInfoAsync(uri).catch(() => null);
      if (info?.exists) { const size = info.size ?? 0; files.push({ uri, size, mtime: info.modificationTime ?? 0 }); total += size; }
    }
    if (total <= CAP_BYTES) return;

    files.sort((a, b) => a.mtime - b.mtime);   // oldest first
    for (const f of files) {
      if (total <= CAP_BYTES) break;
      await FileSystem.deleteAsync(f.uri, { idempotent: true }).catch(() => {});
      total -= f.size;
    }
  } catch {}
}

export default {};
