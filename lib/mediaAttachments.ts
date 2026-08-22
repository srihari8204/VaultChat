// lib/mediaAttachments.ts — E2E media: encrypt-on-upload + decrypt-on-fetch.
//
// uploadEncryptedAttachment: encrypt the file, upload the ciphertext (server
// stores opaque bytes), remember the key locally, return the attachment id +
// key. The caller embeds the key in the E2E message via buildMediaContent().
//
// getDecryptedAttachmentUri: resolve a renderable local file:// URI — download
// the ciphertext, decrypt with the stored key, cache it. If we have no key
// (plaintext/legacy media or a group chat), fall back to the direct auth'd URL.

import * as FileSystem from 'expo-file-system/legacy';
import { uploadAttachment, attachmentUrl, type UploadResult } from './chatService';
import { getAccessToken } from './api';
import {
  newMediaKey, encryptMediaB64, decryptMediaB64,
  encryptMediaFile, decryptMediaFile, type MediaKey,
} from './mediaCrypto';
import { putMediaKey, getMediaKey } from './mediaKeyStore';

export interface EncryptedUpload { attachmentId: string; mediaKey: MediaKey }

// Encrypt `uri`'s bytes, upload the ciphertext, stash the key by attachment id.
//
// P3.1: encryption STREAMS through the native cipher in 4 MB slices
// (mediaCrypto.encryptMediaFile) — the old path held ~4× the file size in the
// JS heap at once (base64 read + plaintext Buffer + ciphertext Buffer + base64
// write) and OOM'd on large videos. Wire format is unchanged (ct||tag, same
// key+nonce), so recipients on any build decrypt it. The whole-file path
// remains only as the Expo Go fallback (no native modules there).
export async function uploadEncryptedAttachment(
  uri: string, filename: string, _mime: string, opts: { viewOnce?: boolean; signal?: AbortSignal } = {},
): Promise<EncryptedUpload> {
  const mk = newMediaKey();
  const tmp = (FileSystem as any).cacheDirectory + `enc_${Date.now()}_${filename.replace(/[^\w.-]/g, '_')}`;
  let streamed = false;
  try {
    streamed = await encryptMediaFile(uri, tmp, mk);
  } catch (e) {
    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    throw e;
  }
  if (!streamed) {
    // Expo Go fallback — whole file through the JS heap (bounded use only).
    const fileB64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
    const ctB64 = encryptMediaB64(fileB64, mk);
    await FileSystem.writeAsStringAsync(tmp, ctB64, { encoding: 'base64' }); // writes the raw ciphertext bytes
  }
  let res: UploadResult;
  try {
    // Upload as opaque bytes so the server never treats it as an image/etc.
    // Encrypted media is a chat attachment unless the caller says otherwise —
    // this helper is only reached from the chat send path today.
    res = await uploadAttachment(tmp, filename, 'application/octet-stream', { purpose: 'chat', ...opts });
  } finally {
    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
  }
  await putMediaKey(res.id, mk);
  return { attachmentId: res.id, mediaKey: mk };
}

// Download an attachment's ciphertext to disk (streaming) and decrypt it to
// `dest` in bounded memory. Falls back to the whole-file JS path (fetch →
// arrayBuffer → decrypt) only when the native engines are absent.
async function downloadAndDecrypt(
  attachmentId: string, mk: MediaKey, dest: string, headers?: Record<string, string>,
): Promise<void> {
  const ctTmp = (FileSystem as any).cacheDirectory + `ct_${attachmentId}_${Date.now()}`;
  try {
    const r = await FileSystem.downloadAsync(attachmentUrl(attachmentId), ctTmp, { headers });
    if ((r.status ?? 0) >= 400) throw new Error(`attachment ${attachmentId} download failed (${r.status})`);
    const streamed = await decryptMediaFile(ctTmp, dest, mk);
    if (!streamed) {
      const ctB64 = await FileSystem.readAsStringAsync(ctTmp, { encoding: 'base64' });
      const ptB64 = decryptMediaB64(ctB64, mk);
      await FileSystem.writeAsStringAsync(dest, ptB64, { encoding: 'base64' });
    }
  } finally {
    await FileSystem.deleteAsync(ctTmp, { idempotent: true }).catch(() => {});
  }
}

// Resolve a renderable URI for an attachment, decrypting if we hold a key.
/**
 * Resolve an attachment to a renderable URI. Thin wrapper over
 * getAttachmentLocalUri so every caller shares ONE persistent, cache-first path.
 *
 * It used to differ in two ways that both broke offline viewing:
 *   • Plaintext attachments returned the REMOTE url, so opening a photo needed
 *     the network every single time — nothing to show on a plane, and a
 *     re-download on every open when there was signal.
 *   • Encrypted attachments were decrypted into FileSystem.cacheDirectory,
 *     which Android evicts under storage pressure and "Clear cache" wipes.
 *     Combined with the server purging media after delivery, an eviction meant
 *     the media was gone for good — there is no second copy to re-download.
 *
 * Both now resolve to the persistent media dir, so a file that has been opened
 * once opens instantly and offline forever after.
 */
export async function getDecryptedAttachmentUri(
  attachmentId: string,
): Promise<{ uri: string; headers?: Record<string, string> }> {
  return { uri: await getAttachmentLocalUri(attachmentId) };
}

// Resolve ANY attachment (plaintext or encrypted) to a local file:// URI.
// expo-av's Android <Video> won't send auth headers, so video playback must
// come from a local file — this downloads (with the Bearer header) and decrypts
// if we hold a key, caching the result. Uses the same fetch+write path proven by
// getDecryptedAttachmentUri (never depends on FileSystem.downloadAsync, which is
// absent from the SDK 54 main module).
// Persistent on-device media store (NOT the cache dir — "Clear cache" wipes that
// and the server purges its copy after delivery). Lives under documentDirectory,
// so downloaded media survives cache clears and server-side purge, like
// WhatsApp's media folder. Removed only on uninstall.
const MEDIA_DIR = (FileSystem as any).documentDirectory + 'media/';
let _mediaDirReady = false;
async function ensureMediaDir(): Promise<void> {
  if (_mediaDirReady) return;
  try { await FileSystem.makeDirectoryAsync(MEDIA_DIR, { intermediates: true }); } catch {}
  _mediaDirReady = true;
}

export async function getAttachmentLocalUri(attachmentId: string): Promise<string> {
  const token = await getAccessToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const mk = await getMediaKey(attachmentId);

  await ensureMediaDir();
  const cached = MEDIA_DIR + `media_${attachmentId}`;
  // WRITE SOMEWHERE ELSE, THEN MOVE.
  //
  // Both writers below used to write straight to `cached`, and the check under
  // this comment accepts any file with a non-zero size. So an interrupted
  // transfer — app killed, process frozen, network dropped, decrypt aborted
  // mid-stream — left a TRUNCATED file sitting at the final path, and every
  // later open returned it instantly because it exists and is non-empty.
  //
  // A truncated video plays fine up to the point the bytes stop and then
  // freezes. Permanently, and only for that one attachment, because nothing
  // ever re-downloads it: that is the "video gets stuck in the middle" report.
  // An image shows the same way, half-drawn.
  //
  // Moving into place is atomic on the same filesystem, so `cached` only ever
  // exists complete. A partial write now lands on `.part` and is discarded.
  const part = cached + '.part';
  const info = await FileSystem.getInfoAsync(cached);
  if (info.exists && (info as any).size) return cached;
  // Sweep any leftover from a previous crash before reusing the name.
  await FileSystem.deleteAsync(part, { idempotent: true }).catch(() => {});

  // Adopt a copy left in the cache dir by the old getDecryptedAttachmentUri.
  // This is not just an optimisation: the server purges media after delivery,
  // so for anything already delivered this cached file is the ONLY copy left.
  // Re-downloading would 404 and the user would lose media they can see today.
  try {
    const legacy = (FileSystem as any).cacheDirectory + `dec_${attachmentId}`;
    const li = await FileSystem.getInfoAsync(legacy);
    if (li.exists && (li as any).size) {
      await FileSystem.moveAsync({ from: legacy, to: cached });
      return cached;
    }
  } catch { /* fall through to a normal fetch */ }

  try {
    if (!mk) {
      // Plaintext: STREAM the bytes straight to disk. Never load the whole file
      // into memory — doing that (fetch→arrayBuffer→base64) OOM'd when several
      // video bubbles resolved at once. downloadAsync (legacy) writes to disk.
      const r = await FileSystem.downloadAsync(attachmentUrl(attachmentId), part, { headers });
      if ((r.status ?? 0) >= 400) {
        throw new Error(`attachment ${attachmentId} download failed (${r.status})`);
      }
    } else {
      // Encrypted: download to disk + streaming decrypt (P3.1) — bounded memory
      // even when several video bubbles resolve at once.
      await downloadAndDecrypt(attachmentId, mk, part, headers);
    }
    // Only a COMPLETE file earns the real name.
    await FileSystem.moveAsync({ from: part, to: cached });
    return cached;
  } catch (e) {
    // Leave nothing behind that a later call would mistake for a finished file.
    await FileSystem.deleteAsync(part, { idempotent: true }).catch(() => {});
    throw e;
  }
}

// ── Media envelope (the E2E-encrypted message content for a media message) ──
// We pack the caption + key into the content that the per-peer Double Ratchet
// encrypts, so the key is delivered E2E (never in plaintext meta).
export function buildMediaContent(caption: string, mk: MediaKey): string {
  return JSON.stringify({ t: caption || '', mk });
}

// Parse a decrypted media-message content. Stores the key locally (so the
// recipient's galleries can decrypt) and returns the caption to display.
export async function parseMediaContent(
  attachmentId: string | undefined, decrypted: string,
): Promise<string> {
  try {
    const j = JSON.parse(decrypted);
    if (j && j.mk && j.mk.k && j.mk.n) {
      if (attachmentId) await putMediaKey(attachmentId, j.mk as MediaKey);
      return typeof j.t === 'string' ? j.t : '';
    }
  } catch { /* legacy/plaintext caption */ }
  return decrypted;
}
