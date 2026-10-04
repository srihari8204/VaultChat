// lib/protectedMedia.ts — VaultView local enforcement.
//
// The server side of revoke (POST /uploads/:id/revoke) stamps revoked_at, drops
// the bytes, and broadcasts 'media_revoked'. This module is the other half: the
// recipient device destroying what it already holds.
//
// Order matters. The KEY goes first, because with MEDIA_E2EE on it is the thing
// that makes revoke irreversible — a device holding ciphertext with no key has
// nothing recoverable, even if a plaintext delete later fails or the process is
// killed mid-wipe. Plaintext copies are deleted after.
//
// Two paths converge here:
//   online  — socket 'media_revoked' → wipeRevokedMedia()
//   offline — next fetch 410s with { revoked: true } → the fetch site calls
//             wipeRevokedMedia() on that signal
// so a recipient who was offline at revoke time still converges the moment they
// come back, without needing the event to have been delivered.

import * as FileSystem from 'expo-file-system/legacy';
import { deleteMediaKey } from './mediaKeyStore';
import { purgeLocalCopies } from './mediaStore';

// Cache-file prefixes that can hold decrypted plaintext for an attachment:
//   dec_ — streaming decrypt output (lib/mediaAttachments)
//   vo_  — view-once ephemeral download (app/media-viewer)
//   vv_  — VaultView protected render staging
const CACHE_PREFIXES = ['dec_', 'vo_', 'vv_'];

/** Local record of revoked attachments, so a bubble renders the tombstone
 *  without a round-trip and stays revoked across restarts. */
const REVOKED_KEY = 'vc_revoked_media';
let revokedCache: Set<string> | null = null;

async function loadRevoked(): Promise<Set<string>> {
  if (revokedCache) return revokedCache;
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const raw = await AsyncStorage.getItem(REVOKED_KEY);
    revokedCache = new Set<string>(raw ? JSON.parse(raw) : []);
  } catch { revokedCache = new Set<string>(); }
  return revokedCache;
}

async function persistRevoked(): Promise<void> {
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    await AsyncStorage.setItem(REVOKED_KEY, JSON.stringify([...(revokedCache ?? [])]));
  } catch {}
}

/** Warm the cache so isRevokedSync works during the first render pass. */
export async function preloadRevoked(): Promise<void> { await loadRevoked(); }

/** Synchronous check (valid after preloadRevoked). */
export function isRevokedSync(attachmentId: string): boolean {
  return revokedCache ? revokedCache.has(String(attachmentId)) : false;
}

export async function isRevoked(attachmentId: string): Promise<boolean> {
  return (await loadRevoked()).has(String(attachmentId));
}

/**
 * Destroy every local trace of a revoked attachment: the media key first, then
 * cached plaintext, then the persistent media-folder copies and thumbnail.
 *
 * Idempotent and never throws — a revoke that partially fails still leaves the
 * key gone, and the attachment marked revoked so the UI shows the tombstone.
 * Returns the number of plaintext files removed (diagnostic only).
 */
export async function wipeRevokedMedia(attachmentId: string): Promise<number> {
  const id = String(attachmentId);

  // 1. Key first — this is the irreversible step.
  await deleteMediaKey(id);

  // 2. Mark revoked before the slow file work, so a kill mid-wipe still renders
  //    the tombstone instead of a broken image on next launch.
  const set = await loadRevoked();
  if (!set.has(id)) { set.add(id); await persistRevoked(); }

  let removed = 0;

  // 3. Ephemeral cache copies.
  try {
    const dir = FileSystem.cacheDirectory;
    if (dir) {
      const names: string[] = await FileSystem.readDirectoryAsync(dir);
      for (const name of names) {
        if (!CACHE_PREFIXES.some((p) => name.startsWith(p)) || !name.includes(id)) continue;
        await FileSystem.deleteAsync(dir + name, { idempotent: true }).catch(() => {});
        removed++;
      }
    }
  } catch {}

  // 4. Persistent media-folder copies + thumbnail.
  try { removed += await purgeLocalCopies(id); } catch {}

  return removed;
}

/**
 * Inspect a failed attachment fetch and, when it is the server's revoke signal,
 * wipe locally. Call from any download path that can see the status code.
 * Returns true when the response meant "revoked" (caller should render the
 * tombstone rather than a generic error).
 */
export async function handleFetchStatus(attachmentId: string, status: number, body?: unknown): Promise<boolean> {
  // 410 covers both view-once consumption and revoke; only revoke carries the
  // flag, and only revoke should destroy the key (a consumed view-once is
  // already unreadable, and wiping its key would be harmless but pointless).
  if (status !== 410) return false;
  const revoked = body && typeof body === 'object' ? (body as { revoked?: unknown }).revoked === true : false;
  if (!revoked) return false;
  await wipeRevokedMedia(attachmentId);
  return true;
}

export default {};
