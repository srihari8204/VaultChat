// lib/storageRoots.ts — the ONE authority on where VaultChat writes to disk.
//
// Before this module, every subsystem invented its own path. The media store
// wrote to the external media folder, the GC swept only the cache dir, the
// storage manager measured only document+cache, and logout wiped neither. Those
// four lists disagreed, which is how media ended up surviving both logout and
// uninstall (audit F-1 / F-6).
//
// Everything that ENUMERATES storage — the storage manager, the cache GC, the
// logout/account-switch wipe, the panic wipe, the media migration — must read
// its roots from here, so a new root can never be added in one place and
// forgotten in the other four.
//
// ── The uninstall contract ────────────────────────────────────────────────
// Every root below lives under the app's PRIVATE sandbox (documentDirectory /
// cacheDirectory). Android deletes that sandbox on uninstall, so uninstalling
// the app really does remove the user's data.
//
// This is a deliberate reversal. Media used to live in
// /Android/media/<pkg>/VaultChat/Media — the app-specific EXTERNAL media dir,
// which Android does NOT delete on uninstall (it is the same trick that makes
// WhatsApp media survive a reinstall). Combined with deterministic filenames
// (IMG-<attachmentId>.jpg), a reinstalled app re-adopted the orphaned files and
// re-displayed "deleted" photos. The only durable, user-visible copy is now the
// one the user explicitly exports via the system gallery (MediaLibrary), which
// is a consented action rather than a silent side effect.
//
// LEGACY_MEDIA_ROOT below is retained for exactly one purpose: lib/mediaMigration
// moves the old tree into the sandbox on first launch, then deletes it.

import { Platform } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';

/** Fallback package id; the real one is read from the native app at runtime. */
const FALLBACK_PKG = 'com.vaultchat.app';

/**
 * The application id, read from the native side rather than hardcoded (audit
 * F-11 — two modules each carried their own `const PKG = 'com.vaultchat.app'`,
 * which silently breaks for a renamed or flavoured build). Falls back to the
 * literal when the native module is unavailable (Expo Go / web).
 */
export function packageName(): string {
  try {
    const DeviceInfo = require('react-native-device-info').default;
    return DeviceInfo?.getBundleId?.() || FALLBACK_PKG;
  } catch {
    return FALLBACK_PKG;
  }
}

// ── Sandbox roots (plain filesystem paths, no scheme — RNFS style) ─────────
//
// On Android RNFS.DocumentDirectoryPath is /data/user/0/<pkg>/files and
// expo-file-system's documentDirectory is file:///data/user/0/<pkg>/files/ —
// the SAME directory in two notations. Keeping both forms here means callers
// never hand a file:// string to RNFS (which wants a bare path) or a bare path
// to expo-file-system (which wants a URI).

/** Private app storage root. Deleted by uninstall. */
export const APP_DOCS = RNFS.DocumentDirectoryPath;

/** Private cache root. Deleted by uninstall AND by the OS under disk pressure. */
export const APP_CACHE = RNFS.CachesDirectoryPath;

/** Chat media (photos, video, audio, voice notes, documents). */
export const MEDIA_ROOT = `${APP_DOCS}/VaultChat/Media`;

/** Media thumbnails. Dot-prefixed for parity with the old layout. */
export const THUMB_ROOT = `${MEDIA_ROOT}/.Thumbs`;

/** Encrypted local chat backups (*.vcbak). */
export const BACKUP_ROOT = `${APP_DOCS}/VaultChat/Databases`;

/** Downloaded/decrypted attachments kept by lib/mediaAttachments. */
export const ATTACHMENT_ROOT = `${APP_DOCS}/media`;

/** Encrypted-notes attachments (lib/notesAttachments). */
export const NOTES_ROOT = `${APP_DOCS}/note_attachments`;

/** Completed VaultBeam transfers (lib/vaultBeamController). */
export const VAULTBEAM_ROOT = `${APP_DOCS}/VaultBeam`;

/**
 * The pre-migration external media tree — the root that survived uninstall.
 * Android only; null elsewhere. Read ONLY by lib/mediaMigration, which drains
 * it into the sandbox and then removes it.
 */
export const LEGACY_MEDIA_ROOT: string | null = Platform.OS === 'android'
  ? `${RNFS.ExternalStorageDirectoryPath}/Android/media/${packageName()}/VaultChat`
  : null;

// ── URI helpers ────────────────────────────────────────────────────────────

/** Bare filesystem path → file:// URI (for expo-file-system, <Image>, <Video>). */
export function toUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

/** file:// URI → bare filesystem path (for RNFS). */
export function toPath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

// ── Root sets ──────────────────────────────────────────────────────────────

/**
 * Every root holding USER CONTENT that a logout, account switch or panic wipe
 * must clear. Deliberately excludes the cache dir, which the GC owns and which
 * holds nothing that isn't re-derivable.
 */
export function userContentRoots(): string[] {
  return [MEDIA_ROOT, BACKUP_ROOT, ATTACHMENT_ROOT, NOTES_ROOT, VAULTBEAM_ROOT];
}

/** Just the media roots — the target of "Delete all media from this device". */
export function mediaRoots(): string[] {
  return [MEDIA_ROOT, ATTACHMENT_ROOT];
}

/**
 * Every root the storage manager should MEASURE, so its total matches what the
 * app actually occupies on disk. MEDIA_ROOT and friends sit under APP_DOCS, so
 * walking the two parents covers them without double-counting.
 */
export function measuredRoots(): string[] {
  return [APP_DOCS, APP_CACHE];
}

// ── Directory utilities ────────────────────────────────────────────────────

/** mkdir -p. Safe to call repeatedly. */
export async function ensureDir(path: string): Promise<void> {
  try {
    if (!(await RNFS.exists(path))) await RNFS.mkdir(path);
  } catch { /* a concurrent create is fine; a real failure surfaces at write */ }
}

/**
 * Recursively delete a directory's CONTENTS, leaving the directory itself.
 * Returns the number of files removed. Never throws — a wipe that partially
 * fails must still remove everything it can rather than abort at the first
 * locked file.
 */
export async function purgeDirContents(path: string): Promise<number> {
  let removed = 0;
  try {
    if (!(await RNFS.exists(path))) return 0;
    for (const entry of await RNFS.readDir(path)) {
      try {
        if (entry.isDirectory()) {
          removed += await purgeDirContents(entry.path);
          await RNFS.unlink(entry.path).catch(() => {});
        } else {
          await RNFS.unlink(entry.path);
          removed++;
        }
      } catch { /* skip this entry, keep going */ }
    }
  } catch { /* unreadable root — nothing we can do */ }
  return removed;
}

/** Purge every user-content root. Returns the total number of files removed. */
export async function purgeUserContent(): Promise<number> {
  let removed = 0;
  for (const root of userContentRoots()) removed += await purgeDirContents(root);
  return removed;
}

/** Purge only the media roots. Returns the total number of files removed. */
export async function purgeMedia(): Promise<number> {
  let removed = 0;
  for (const root of mediaRoots()) removed += await purgeDirContents(root);
  return removed;
}

/** Total bytes under a root, recursively. Best-effort; unreadable paths score 0. */
export async function dirSize(path: string): Promise<number> {
  let total = 0;
  try {
    if (!(await RNFS.exists(path))) return 0;
    for (const entry of await RNFS.readDir(path)) {
      if (entry.isDirectory()) total += await dirSize(entry.path);
      else total += Number(entry.size) || 0;
    }
  } catch { /* best-effort */ }
  return total;
}

export default {};
