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
 * Delete every ephemeral protected-media plaintext left in the cache.
 * Unconditional (not size-capped) — see EPHEMERAL_PREFIXES. Safe to call any
 * time no protected viewer is on screen; media-viewer also cleans up its own
 * file on unmount, so this is the crash-recovery path.
 */
export async function purgeEphemeralMedia(): Promise<number> {
  let n = 0;
  try {
    const dir = (FileSystem as any).cacheDirectory;
    if (!dir) return 0;
    const names = await FileSystem.readDirectoryAsync(dir);
    for (const name of names) {
      if (!EPHEMERAL_PREFIXES.some((p) => name.startsWith(p))) continue;
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
    if (purged > 0) console.log(`[cacheGC] purged ${purged} ephemeral protected-media file(s)`);
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
