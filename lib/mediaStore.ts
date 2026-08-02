// lib/mediaStore.ts — WhatsApp-style media storage & retrieval.
//
// Stores media in the app's EXTERNAL media folder (no runtime permission, freely
// writable, browsable in any file manager), mirroring WhatsApp's layout:
//
//   /Android/media/com.vaultchat.app/VaultChat/Media/
//     ├─ VaultChat Images/        └─ Sent/
//     ├─ VaultChat Video/         └─ Sent/
//     ├─ VaultChat Audio/         └─ Sent/
//     ├─ VaultChat Voice Notes/
//     └─ VaultChat Documents/     └─ Sent/
//
// Retrieval = read straight from these files. Media is downloaded once; after
// that it's local, so it survives "Clear cache" AND the server's post-delivery
// purge. Encrypted media (flag) falls back to the internal decrypt path.

import { Platform } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { attachmentUrl } from './chatService';
import { getAccessToken } from './api';
import { getMediaKey } from './mediaKeyStore';
import { getDecryptedAttachmentUri } from './mediaAttachments';

export type MediaKind = 'image' | 'video' | 'audio' | 'voice' | 'file';

const PKG = 'com.vaultchat.app';

// Android → app-specific external media dir (browsable, no permission).
// iOS → app Documents (no external concept; same persistence guarantees).
const BASE = Platform.OS === 'android'
  ? `${RNFS.ExternalStorageDirectoryPath}/Android/media/${PKG}/VaultChat/Media`
  : `${RNFS.DocumentDirectoryPath}/VaultChat/Media`;

const FOLDER: Record<MediaKind, string> = {
  image: 'VaultChat Images',
  video: 'VaultChat Video',
  audio: 'VaultChat Audio',
  voice: 'VaultChat Voice Notes',
  file:  'VaultChat Documents',
};

// Voice Notes has no Sent/ subfolder (matches WhatsApp).
const HAS_SENT: Record<MediaKind, boolean> = {
  image: true, video: true, audio: true, voice: false, file: true,
};

function extFor(kind: MediaKind, mime?: string, filename?: string): string {
  if (filename && filename.includes('.')) return filename.split('.').pop()!.toLowerCase();
  const m = (mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.startsWith('video')) return 'mp4';
  if (m.startsWith('audio')) return 'm4a';
  switch (kind) {
    case 'image': return 'jpg';
    case 'video': return 'mp4';
    case 'audio':
    case 'voice': return 'm4a';
    default:      return 'bin';
  }
}

function fileNameFor(attachmentId: string, kind: MediaKind, ext: string, filename?: string): string {
  if (kind === 'file' && filename) return filename.replace(/[/\\:*?"<>|]/g, '_');
  const prefix = kind === 'image' ? 'IMG' : kind === 'video' ? 'VID' : kind === 'voice' ? 'PTT' : kind === 'audio' ? 'AUD' : 'DOC';
  return `${prefix}-${attachmentId}.${ext}`;
}

async function ensureDir(path: string): Promise<void> {
  if (!(await RNFS.exists(path))) await RNFS.mkdir(path);
}

export interface MediaOpts { kind: MediaKind; isMine?: boolean; mime?: string; filename?: string }

// Hidden thumbnails folder (the leading dot keeps it out of the gallery, exactly
// like WhatsApp's .Thumbs).
const THUMB_DIR = `${BASE}/.Thumbs`;

export async function saveThumb(attachmentId: string, base64: string): Promise<void> {
  try {
    await ensureDir(BASE);
    await ensureDir(THUMB_DIR);
    const path = `${THUMB_DIR}/${attachmentId}.jpg`;
    if (!(await RNFS.exists(path))) await RNFS.writeFile(path, base64, 'base64');
  } catch { /* best-effort */ }
}

export async function getThumbUri(attachmentId: string): Promise<string | null> {
  try {
    const path = `${THUMB_DIR}/${attachmentId}.jpg`;
    return (await RNFS.exists(path)) ? `file://${path}` : null;
  } catch { return null; }
}

/**
 * Copy a media-folder file into the app cache (via RNFS, which CAN read
 * /Android/media) so the OS FileProvider can serve it — needed to open a file
 * with another app (expo-file-system can't touch the media folder). Returns the
 * cache file:// uri.
 */
export async function copyToCache(sourceUri: string, filename: string): Promise<string> {
  const safe = (filename || 'file').replace(/[/\\:*?"<>|]/g, '_');
  const dest = `${RNFS.CachesDirectoryPath}/${safe}`;
  const src = sourceUri.replace('file://', '');
  if (src !== dest) {
    try { if (await RNFS.exists(dest)) await RNFS.unlink(dest); } catch {}
    await RNFS.copyFile(src, dest);
  }
  return `file://${dest}`;
}

function pathFor(attachmentId: string, opts: MediaOpts): { folder: string; path: string } {
  const folder = `${BASE}/${FOLDER[opts.kind]}${opts.isMine && HAS_SENT[opts.kind] ? '/Sent' : ''}`;
  const ext  = extFor(opts.kind, opts.mime, opts.filename);
  const name = fileNameFor(attachmentId, opts.kind, ext, opts.filename);
  return { folder, path: `${folder}/${name}` };
}

async function ensureTree(opts: MediaOpts, folder: string): Promise<void> {
  await ensureDir(BASE);
  await ensureDir(`${BASE}/${FOLDER[opts.kind]}`);
  if (opts.isMine && HAS_SENT[opts.kind]) await ensureDir(folder);
}

/**
 * Save the sender's ORIGINAL local file straight into the WhatsApp-style Sent/
 * folder at send time, so the sender NEVER re-downloads their own media. Called
 * after upload; best-effort (a failure just means it falls back to a download).
 */
export async function storeSentCopy(attachmentId: string, sourceUri: string, opts: MediaOpts): Promise<void> {
  try {
    if (await getMediaKey(attachmentId)) return;   // encrypted: skip (flag-off path)
    const { folder, path } = pathFor(attachmentId, { ...opts, isMine: true });
    if (await RNFS.exists(path)) return;
    await ensureTree({ ...opts, isMine: true }, folder);
    await RNFS.copyFile(sourceUri.replace('file://', ''), path);
    if (Platform.OS === 'android') { try { await RNFS.scanFile(path); } catch {} }
  } catch { /* best-effort — sender just re-downloads if this fails */ }
}

/**
 * Resolve a local file:// URI for an attachment, downloading once into the
 * WhatsApp-style folder if needed. Returns a path that renders/plays directly.
 */
export async function getMedia(attachmentId: string, opts: MediaOpts & { cacheOnly?: boolean; onProgress?: (pct: number) => void }): Promise<string> {
  // Encrypted media → reuse the internal decrypt-to-file path.
  const mk = await getMediaKey(attachmentId);
  if (mk) return (await getDecryptedAttachmentUri(attachmentId)).uri;

  const { folder, path } = pathFor(attachmentId, opts);

  if (await RNFS.exists(path)) return `file://${path}`;
  // Cache-only probe (for the auto-download gate): don't hit the network.
  if (opts.cacheOnly) return '';

  // Ensure the folder tree exists, then download into it.
  await ensureTree(opts, folder);

  const token = await getAccessToken();
  const res = await RNFS.downloadFile({
    fromUrl: attachmentUrl(attachmentId),
    toFile: path,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    progressInterval: 150,
    progress: opts.onProgress
      ? (p: any) => { if (p.contentLength > 0) opts.onProgress!(Math.min(1, p.bytesWritten / p.contentLength)); }
      : undefined,
  }).promise;

  if (res.statusCode && res.statusCode >= 400) {
    await RNFS.unlink(path).catch(() => {});
    throw new Error(`attachment ${attachmentId} download failed (${res.statusCode})`);
  }
  // Make it appear in the gallery (same as WhatsApp — its media folder is
  // media-scanned). No copy, no permission.
  if (Platform.OS === 'android') { try { await RNFS.scanFile(path); } catch {} }
  return `file://${path}`;
}

/**
 * Delete every local copy of an attachment from the persistent media folders
 * plus its cached thumbnail. Used by the VaultView revoke path — the sender
 * destroyed the media, so the recipient's on-disk copies have to go too, not
 * just the key.
 *
 * Scans each media folder (and its Sent/ subfolder) for names carrying the
 * attachment id rather than reconstructing the exact path, because the
 * extension depends on mime/filename at save time and a revoke has no message
 * context to rebuild that from. Returns how many files were removed.
 */
export async function purgeLocalCopies(attachmentId: string): Promise<number> {
  let removed = 0;
  const id = String(attachmentId);
  const dirs: string[] = [THUMB_DIR];
  for (const kind of Object.keys(FOLDER) as MediaKind[]) {
    dirs.push(`${BASE}/${FOLDER[kind]}`);
    if (HAS_SENT[kind]) dirs.push(`${BASE}/${FOLDER[kind]}/Sent`);
  }
  for (const dir of dirs) {
    try {
      if (!(await RNFS.exists(dir))) continue;
      const entries = await RNFS.readDir(dir);
      for (const e of entries) {
        if (!e.isFile() || !e.name.includes(id)) continue;
        await RNFS.unlink(e.path).catch(() => {});
        removed++;
      }
    } catch { /* best-effort per folder */ }
  }
  return removed;
}

export default {};
