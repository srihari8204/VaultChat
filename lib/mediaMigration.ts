// lib/mediaMigration.ts — drain the legacy external media tree into the sandbox.
//
// Until this build, media lived at /Android/media/<pkg>/VaultChat/** — a path
// Android does NOT delete on uninstall. Every upgrading device therefore has a
// tree out there holding the user's photos, videos, documents, thumbnails and
// full encrypted chat backups, all of which survived every previous uninstall
// (audit F-1 / F-2).
//
// This module moves that tree into the private sandbox exactly once, then
// deletes it. Repointing the paths alone would have been worse than doing
// nothing: new media would go to the sandbox while the old media sat outside it
// forever, still surviving uninstall, now with nothing that even knows it is
// there.
//
// ── Safety model ───────────────────────────────────────────────────────────
// This moves the user's photo library, so it is built to be boring:
//
//   • COPY → VERIFY SIZE → UNLINK, per file. Never move-and-hope. A file whose
//     copy doesn't match its source is left alone, and the run is marked
//     incomplete so the next launch retries it.
//   • RESUMABLE. State is per-file, not per-run: a process kill mid-migration
//     leaves the remaining files in place and the completion flag unset, so the
//     next launch continues where it stopped.
//   • IDEMPOTENT. A destination that already exists is treated as done — the
//     source is verified against it and then removed.
//   • SPACE-SAFE BY CONSTRUCTION. Copy-then-delete one file at a time needs only
//     enough free space for the single largest file, not for the whole tree.
//   • NEVER FATAL. Every failure path is caught. A device that cannot migrate
//     keeps working, keeps its files, and retries next launch.
//
// Filenames are preserved because they are load-bearing: mediaStore derives
// paths from the attachment id (IMG-<id>.jpg), so a preserved name means the
// migrated file is found on the next render with no re-download.

import * as RNFS from '@dr.pogodin/react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  LEGACY_MEDIA_ROOT, MEDIA_ROOT, THUMB_ROOT, BACKUP_ROOT, ensureDir,
} from './storageRoots';

/** Set only after a run that left the legacy tree completely gone. */
const DONE_KEY = 'vc_media_migrated_v1';

export interface MigrationResult {
  ran: boolean;          // false when there was nothing to do
  moved: number;         // files successfully relocated
  failed: number;        // files left in place for a later retry
  bytes: number;         // total bytes relocated
  complete: boolean;     // legacy tree fully drained and removed
}

const EMPTY: MigrationResult = { ran: false, moved: 0, failed: 0, bytes: 0, complete: true };

/**
 * Map a path inside the legacy tree to its sandbox destination.
 *
 * Legacy layout                          →  Sandbox
 *   <legacy>/Media/VaultChat Images/…     →  <MEDIA_ROOT>/VaultChat Images/…
 *   <legacy>/Media/.Thumbs/…              →  <THUMB_ROOT>/…
 *   <legacy>/Databases/*.vcbak            →  <BACKUP_ROOT>/…
 *
 * Anything unrecognised lands under MEDIA_ROOT with its relative path intact,
 * so an unexpected folder is preserved rather than dropped.
 */
function destinationFor(legacyRoot: string, sourcePath: string): string {
  const rel = sourcePath.startsWith(legacyRoot)
    ? sourcePath.slice(legacyRoot.length).replace(/^\/+/, '')
    : sourcePath.split('/').pop() || 'file';

  if (rel.startsWith('Media/.Thumbs/')) return `${THUMB_ROOT}/${rel.slice('Media/.Thumbs/'.length)}`;
  if (rel.startsWith('Media/'))         return `${MEDIA_ROOT}/${rel.slice('Media/'.length)}`;
  if (rel.startsWith('Databases/'))     return `${BACKUP_ROOT}/${rel.slice('Databases/'.length)}`;
  return `${MEDIA_ROOT}/${rel}`;
}

/** Every file under `dir`, recursively. Directories are not returned. */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: any[];
  try { entries = await RNFS.readDir(dir); } catch { return out; }
  for (const e of entries) {
    try {
      if (e.isDirectory()) out.push(...await listFilesRecursive(e.path));
      else out.push(e.path);
    } catch { /* skip unreadable entry */ }
  }
  return out;
}

/** Byte size of a path, or -1 when it can't be read. */
async function sizeOf(path: string): Promise<number> {
  try { return Number((await RNFS.stat(path)).size) || 0; } catch { return -1; }
}

/**
 * Relocate one file. Returns the bytes moved, or -1 if the file was left in
 * place (which marks the whole run incomplete so it is retried).
 */
async function relocate(source: string, dest: string): Promise<number> {
  const srcSize = await sizeOf(source);
  if (srcSize < 0) return -1;

  // Destination already present from an interrupted earlier run: accept it when
  // the sizes agree, then drop the source.
  if (await RNFS.exists(dest)) {
    if (await sizeOf(dest) === srcSize) {
      await RNFS.unlink(source).catch(() => {});
      return srcSize;
    }
    // Sizes disagree — a torn copy. Delete the partial and redo it.
    await RNFS.unlink(dest).catch(() => {});
  }

  const parent = dest.slice(0, dest.lastIndexOf('/'));
  await ensureDir(parent);

  try {
    await RNFS.copyFile(source, dest);
  } catch {
    await RNFS.unlink(dest).catch(() => {});   // never leave a partial behind
    return -1;
  }

  // Verify before destroying the only other copy.
  if (await sizeOf(dest) !== srcSize) {
    await RNFS.unlink(dest).catch(() => {});
    return -1;
  }

  try { await RNFS.unlink(source); } catch { return -1; }   // copied but not freed → retry
  return srcSize;
}

/** Remove now-empty legacy directories, deepest first. Best-effort. */
async function pruneEmptyDirs(dir: string): Promise<void> {
  let entries: any[];
  try { entries = await RNFS.readDir(dir); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) await pruneEmptyDirs(e.path);
  }
  try {
    if ((await RNFS.readDir(dir)).length === 0) await RNFS.unlink(dir);
  } catch { /* non-empty or unlinkable — leave it */ }
}

/**
 * Run the migration if it hasn't completed yet. Safe to call on every launch:
 * it short-circuits on the completion flag and again when the legacy tree is
 * absent (iOS, fresh installs, already-migrated devices).
 *
 * Call OFF the first-frame path — this walks and copies potentially gigabytes.
 */
export async function migrateLegacyMedia(): Promise<MigrationResult> {
  const legacyRoot = LEGACY_MEDIA_ROOT;
  if (!legacyRoot) return EMPTY;                                  // not Android

  try {
    if (await AsyncStorage.getItem(DONE_KEY)) return EMPTY;
  } catch { /* unreadable flag → just re-check the tree below */ }

  try {
    if (!(await RNFS.exists(legacyRoot))) {
      await AsyncStorage.setItem(DONE_KEY, '1').catch(() => {});
      return EMPTY;
    }
  } catch { return EMPTY; }

  const files = await listFilesRecursive(legacyRoot);
  if (!files.length) {
    await pruneEmptyDirs(legacyRoot);
    await AsyncStorage.setItem(DONE_KEY, '1').catch(() => {});
    return { ...EMPTY, ran: true };
  }

  console.log(`[mediaMigration] draining ${files.length} legacy file(s) into the sandbox`);

  let moved = 0, failed = 0, bytes = 0;
  for (const source of files) {
    const n = await relocate(source, destinationFor(legacyRoot, source));
    if (n < 0) failed++;
    else { moved++; bytes += n; }
  }

  await pruneEmptyDirs(legacyRoot);

  // "Complete" means the legacy tree is actually gone — not merely that this
  // pass finished. Anything left keeps the flag unset so the next launch retries.
  let complete = false;
  try { complete = !(await RNFS.exists(legacyRoot)); } catch { complete = false; }
  if (complete) await AsyncStorage.setItem(DONE_KEY, '1').catch(() => {});

  console.log(
    `[mediaMigration] moved ${moved} file(s) (${Math.round(bytes / 1048576)} MB), ` +
    `${failed} deferred, complete=${complete}`,
  );

  return { ran: true, moved, failed, bytes, complete };
}

export default {};
