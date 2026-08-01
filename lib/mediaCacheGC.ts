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

/** Delete oldest cache files until under the cap. Call at boot (fire-and-forget). */
export async function sweepMediaCache(): Promise<void> {
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
