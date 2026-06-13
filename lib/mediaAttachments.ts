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
import { Buffer } from 'buffer';
import { uploadAttachment, attachmentUrl, type UploadResult } from './chatService';
import { getAccessToken } from './api';
import { newMediaKey, encryptMediaB64, decryptMediaB64, type MediaKey } from './mediaCrypto';
import { putMediaKey, getMediaKey } from './mediaKeyStore';

export interface EncryptedUpload { attachmentId: string; mediaKey: MediaKey }

// Encrypt `uri`'s bytes, upload the ciphertext, stash the key by attachment id.
export async function uploadEncryptedAttachment(
  uri: string, filename: string, _mime: string, opts: { viewOnce?: boolean } = {},
): Promise<EncryptedUpload> {
  const fileB64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
  const mk = newMediaKey();
  const ctB64 = encryptMediaB64(fileB64, mk);
  const tmp = (FileSystem as any).cacheDirectory + `enc_${Date.now()}_${filename.replace(/[^\w.-]/g, '_')}`;
  await FileSystem.writeAsStringAsync(tmp, ctB64, { encoding: 'base64' }); // writes the raw ciphertext bytes
  let res: UploadResult;
  try {
    // Upload as opaque bytes so the server never treats it as an image/etc.
    res = await uploadAttachment(tmp, filename, 'application/octet-stream', opts);
  } finally {
    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
  }
  await putMediaKey(res.id, mk);
  return { attachmentId: res.id, mediaKey: mk };
}

// Resolve a renderable URI for an attachment, decrypting if we hold a key.
export async function getDecryptedAttachmentUri(
  attachmentId: string,
): Promise<{ uri: string; headers?: Record<string, string> }> {
  const token = await getAccessToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  const mk = await getMediaKey(attachmentId);
  if (!mk) return { uri: attachmentUrl(attachmentId), headers }; // plaintext / no key

  const cached = (FileSystem as any).cacheDirectory + `dec_${attachmentId}`;
  const info = await FileSystem.getInfoAsync(cached);
  if (!info.exists) {
    const res = await fetch(attachmentUrl(attachmentId), { headers });
    if (!res.ok) throw new Error(`attachment ${attachmentId} download failed (${res.status})`);
    const ctB64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    const ptB64 = decryptMediaB64(ctB64, mk);
    await FileSystem.writeAsStringAsync(cached, ptB64, { encoding: 'base64' });
  }
  return { uri: cached }; // local decrypted file; no auth header needed
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
