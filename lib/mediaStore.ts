// lib/mediaStore.ts — on-device media storage & retrieval.
//
// Stores media inside the app's PRIVATE sandbox, keeping the WhatsApp-style
// folder layout for readability:
//
//   <documentDirectory>/VaultChat/Media/
//     ├─ VaultChat Images/        └─ Sent/
//     ├─ VaultChat Video/         └─ Sent/
//     ├─ VaultChat Audio/         └─ Sent/
//     ├─ VaultChat Voice Notes/
//     └─ VaultChat Documents/     └─ Sent/
//
// Retrieval = read straight from these files. Media is downloaded once; after
// that it's local, so it survives "Clear cache" AND the server's post-delivery
// purge. Encrypted media falls back to the internal decrypt path.
//
// ── Why this is no longer the external media folder ────────────────────────
// This tree used to live at /Android/media/<pkg>/VaultChat/Media — the app's
// EXTERNAL media dir. Android does not delete that path on uninstall, and the
// filenames here are deterministic (IMG-<attachmentId>.jpg), so a reinstalled
// app re-adopted every orphaned file and re-displayed media the user believed
// they had removed with the app — including media the server had already purged
// (audit F-1). It was also readable by any app holding media permissions.
//
// The sandbox is now authoritative. The user's durable copy is the one they
// explicitly export to the system gallery, which is consent rather than a
// silent side effect. lib/mediaMigration drains the old external tree into here
// on first launch and then deletes it.

import * as RNFS from '@dr.pogodin/react-native-fs';
import { attachmentUrl } from './chatService';
import { getAccessToken } from './api';
import { getMediaKey } from './mediaKeyStore';
import { getDecryptedAttachmentUri } from './mediaAttachments';
import { MEDIA_ROOT, THUMB_ROOT, APP_CACHE, ATTACHMENT_ROOT, ensureDir as ensureDirRoot } from './storageRoots';

export type MediaKind = 'image' | 'video' | 'audio' | 'voice' | 'file';

/**
 * Thrown by getMedia when an attachment is known to be encrypted but this
 * install holds no key for it — the normal state after a reinstall, since the
 * per-file keys live in AsyncStorage and the E2EE identity lives in the OS
 * keystore, both of which uninstall destroys.
 *
 * This exists because the old code inferred "no key ⇒ plaintext media" and so
 * downloaded raw ciphertext into VaultChat Images/IMG-<id>.jpg (audit F-8),
 * producing a corrupt file with an image extension. Callers should render an
 * explicit "can't decrypt on this device" state instead.
 */
export class MediaKeyMissingError extends Error {
  readonly code = 'MEDIA_KEY_MISSING';
  constructor(public attachmentId: string) {
    super(`No decryption key on this device for attachment ${attachmentId}`);
    this.name = 'MediaKeyMissingError';
  }
}

const BASE = MEDIA_ROOT;

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

const ensureDir = ensureDirRoot;

export interface MediaOpts {
  kind: MediaKind;
  isMine?: boolean;
  mime?: string;
  filename?: string;
  /**
   * True when the message meta says the bytes are E2E-encrypted (meta.encrypted).
   * Pass it so a missing key is reported as such instead of being mistaken for
   * plaintext media — see MediaKeyMissingError.
   */
  encrypted?: boolean;
}

const THUMB_DIR = THUMB_ROOT;

/**
 * Cache a thumbnail on disk.
 *
 * Skipped for E2E-encrypted attachments, mirroring storeSentCopy's guard. A
 * 240px preview of an "end-to-end encrypted" photo is usually fully identifying,
 * so writing it in the clear undercut the guarantee the encryption was there to
 * make (audit F-7 — storeSentCopy had this guard and saveThumb did not).
 * Encrypted media still previews instantly: the sender embeds the thumbnail in
 * the E2E message envelope (meta.thumb), which is where the receiver reads it
 * from anyway.
 */
export async function saveThumb(attachmentId: string, base64: string): Promise<void> {
  try {
    if (await getMediaKey(attachmentId)) return;   // encrypted: never on disk in the clear
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
 * Copy a media file into the app cache so the OS FileProvider can serve it —
 * needed to hand a file to another app via an intent, since the FileProvider
 * is configured over the cache dir. Returns the cache file:// uri.
 */
export async function copyToCache(sourceUri: string, filename: string): Promise<string> {
  // A remote URL is not a path. Passing one here used to reach RNFS.copyFile
  // and surface as "ENOENT ... https://api…", which reads like a missing file
  // rather than the type error it is. Fail with something that names the cause.
  if (/^https?:\/\//i.test(sourceUri)) {
    throw new Error('copyToCache needs a local file — download the attachment first (getMedia)');
  }
  const safe = (filename || 'file').replace(/[/\\:*?"<>|]/g, '_');
  const dest = `${APP_CACHE}/${safe}`;
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
    if (await getMediaKey(attachmentId)) return;   // encrypted: handled by the decrypt path
    const { folder, path } = pathFor(attachmentId, { ...opts, isMine: true });
    if (await RNFS.exists(path)) return;
    await ensureTree({ ...opts, isMine: true }, folder);
    await RNFS.copyFile(sourceUri.replace('file://', ''), path);
    // No RNFS.scanFile: publishing chat media into the system gallery index is a
    // separate consent decision from receiving it, and a sandbox file cannot be
    // indexed anyway. The user exports deliberately via "Save to gallery".
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

  // A plaintext copy from before the key was lost still renders — prefer it over
  // failing, since the bytes on disk are already readable.
  if (await RNFS.exists(path)) return `file://${path}`;

  // Known-encrypted with no key: stop here. Downloading now would write raw
  // ciphertext to a path with an image/video extension (audit F-8). Callers
  // catch this and render an explicit "can't decrypt on this device" state.
  if (opts.encrypted) throw new MediaKeyMissingError(attachmentId);

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
  // ATTACHMENT_ROOT holds the decrypted copy that lib/mediaAttachments resolves
  // for rendering (media_<id>). A revoke that skips it leaves a fully readable
  // plaintext copy of media the sender destroyed. It was missed here because
  // that copy used to sit in the OS cache dir, where eviction eventually hid the
  // bug; it is persistent now, so it would have survived indefinitely.
  const dirs: string[] = [THUMB_DIR, ATTACHMENT_ROOT];
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
