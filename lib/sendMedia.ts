// lib/sendMedia.ts — one entry point for sending an attachment message (W6).
//
// Decides per-chat whether to encrypt the media at rest:
//   • DIRECT chat + MEDIA_E2EE + E2EE_ENABLED → encrypt the file bytes with a
//     fresh per-file key (uploadEncryptedAttachment); the key is packed into the
//     message CONTENT (buildMediaContent) which sendMessage then E2E-encrypts, so
//     the server stores opaque ciphertext and never sees the key.
//   • Otherwise (group chat, or flag off) → the original plaintext upload path,
//     byte-identical to before.
//
// The render side (getDecryptedAttachmentUri) falls back to the direct URL when no
// key is held, so plaintext/legacy/group media keeps rendering unchanged.

import * as FileSystem from 'expo-file-system/legacy';
import { MEDIA_E2EE, E2EE_ENABLED } from '../constants/flags';
import {
  sendMessage, uploadAttachment, ensureDirectChat, type Message,
} from './chatService';
import { uploadEncryptedAttachment, buildMediaContent } from './mediaAttachments';
import { storeSentCopy, saveThumb } from './mediaStore';
import { makeThumb, makePdfThumb } from './thumbnails';
import { embedToken, newToken, recordToken, isTrackingAvailable } from './trackingId';

export type MediaType = 'image' | 'video' | 'audio' | 'file';

export interface MediaFile { uri: string; filename: string; mime: string }
export interface SendMediaOpts {
  viewOnce?: boolean;
  caption?: string;
  /** Extra display meta merged in (width/height, durationMs, waveform, …). */
  metaExtra?: Record<string, any>;
  /** Cancel an in-flight upload — aborts the multipart + frees R2 (see resumableUpload). */
  signal?: AbortSignal;
  /** Stable idempotency key so a durable-outbox re-drive can't duplicate the message. */
  clientId?: string;
}

/**
 * Stamp a VaultView tracking token into a protected image before upload.
 *
 * Only images, and only protected (view-once) sends: the codec needs pixels, and
 * marking ordinary media the user did not ask to protect would be a surprise.
 * Returns the file to actually upload plus the token that went into it — or the
 * ORIGINAL file and no token when marking isn't possible (no native module,
 * image too small, encode failure).
 *
 * The caller must not claim traceability when `token` comes back null. The
 * bubble reads meta.tracked for exactly this reason.
 *
 * LIMIT — one copy is uploaded per message, so the token identifies the MESSAGE.
 * In a direct chat that is equivalent to identifying the recipient. In a group
 * it is not: every member receives the same marked bytes, so a group leak
 * narrows to "someone in this group", not to a person. Per-member tracing would
 * need one upload per member; that trade-off is deliberate.
 */
async function markProtectedImage(
  file: MediaFile, type: MediaType, chatId: string, isDirect: boolean,
): Promise<{ file: MediaFile; token: string | null }> {
  if (type !== 'image' || !isTrackingAvailable()) return { file, token: null };
  const token = newToken();
  const dst = `${(FileSystem as any).cacheDirectory}vv_mark_${token}.jpg`;
  const ok = await embedToken(file.uri, dst, token).catch(() => false);
  if (!ok) return { file, token: null };
  await recordToken({
    token,
    chatId,
    recipientName: isDirect ? undefined : '(group — identifies the message, not a member)',
    sentAt: new Date().toISOString(),
  }).catch(() => {});
  return { file: { ...file, uri: dst }, token };
}

/** Upload an attachment (encrypted in eligible direct chats) and send its message. */
export async function sendMediaMessage(
  chatId: string,
  type: MediaType,
  file: MediaFile,
  opts: SendMediaOpts = {},
): Promise<Message> {
  // Resolve the peer robustly first (beats the cold-start race) so a direct
  // chat reliably takes the encrypted path instead of silently going plaintext.
  const isDirect = await ensureDirectChat(chatId);
  const encrypt = MEDIA_E2EE && E2EE_ENABLED && isDirect;

  // VaultView: protected sends carry a hidden recipient token under the visible
  // watermark. Done before upload so the marked bytes are what gets encrypted.
  let trackToken: string | null = null;
  let markedTmp: string | null = null;
  if (opts.viewOnce) {
    const marked = await markProtectedImage(file, type, chatId, isDirect);
    if (marked.token) markedTmp = marked.file.uri;   // our temp copy — clean up after upload
    file = marked.file;
    trackToken = marked.token;
  }
  // The marked copy is a staging file; the upload has already read it by the
  // time we return, and leaving marked plaintext in the cache would undo the
  // point of a protected send.
  const cleanupMarked = async () => {
    if (!markedTmp) return;
    await FileSystem.deleteAsync(markedTmp, { idempotent: true }).catch(() => {});
    markedTmp = null;
  };

  try {
  if (encrypt) {
    const { attachmentId, mediaKey } = await uploadEncryptedAttachment(
      file.uri, file.filename, file.mime, { viewOnce: opts.viewOnce, signal: opts.signal },
    );
    // The key + caption ride inside the content the Double Ratchet encrypts.
    const content = buildMediaContent(opts.caption || '', mediaKey);
    const meta: Record<string, any> = {
      attachmentId,
      mime: file.mime,            // real mime for rendering (upload was octet-stream)
      filename: file.filename,
      encrypted: true,
      ...(opts.viewOnce ? { viewOnce: true } : {}),
      // Whether a hidden tracking id actually made it into the pixels. The
      // token itself stays on the sender's device — never in meta, which the
      // recipient can read.
      ...(trackToken ? { tracked: true } : {}),
      ...(opts.metaExtra || {}),
    };
    // Keep the sender's OWN plaintext copy locally (keyed by attachmentId) so they
    // never re-download + re-decrypt their own media on a later chat open — mirror
    // of the plaintext path's storeSentCopy. Skip view-once (not re-viewable).
    if (!opts.viewOnce) {
      const kind = type === 'audio' ? 'voice' : type;
      await storeSentCopy(attachmentId, file.uri, { kind, isMine: true, mime: file.mime, filename: file.filename }).catch(() => {});
      if (type === 'image' || type === 'video') {
        const thumb = await makeThumb(file.uri, type).catch(() => null);
        if (thumb) { meta.thumb = thumb; saveThumb(attachmentId, thumb).catch(() => {}); }
      }
    }
    return sendMessage(chatId, content, type, { meta, clientId: opts.clientId });
  }

  // Plaintext path — unchanged from the original send sites.
  const up = await uploadAttachment(file.uri, file.filename, file.mime, { viewOnce: opts.viewOnce, signal: opts.signal, purpose: 'chat' });
  const meta: Record<string, any> = {
    attachmentId: up.id,
    mime: up.mime,
    size: up.size,
    filename: up.filename,
    ...(opts.viewOnce ? { viewOnce: true } : {}),
    ...(trackToken ? { tracked: true } : {}),
    ...(opts.metaExtra || {}),
  };
  // Keep the sender's own file in the WhatsApp folder (Sent/) so the sender
  // NEVER re-downloads media they just sent. Skip for view-once (it's not
  // re-viewable). Best-effort — never blocks the send on failure.
  if (!opts.viewOnce) {
    const kind = type === 'audio' ? 'voice' : type;   // 'image' | 'video' | 'voice' | 'file'
    // Store the sender's copy under the SAME name the bubble will look for on
    // open (meta uses up.filename/up.mime) — otherwise files name-mismatch and
    // the sender re-downloads their own file.
    await storeSentCopy(up.id, file.uri, { kind, isMine: true, mime: up.mime, filename: up.filename });
    // Thumbnail: embed in meta so the RECEIVER previews it instantly without
    // downloading the full file, and cache it in .Thumbs. Image/video → frame;
    // PDF → first-page preview (WhatsApp-style document preview).
    let thumb: string | null = null;
    if (type === 'image' || type === 'video') thumb = await makeThumb(file.uri, type);
    else if (type === 'file' && /pdf/i.test(file.mime)) thumb = await makePdfThumb(file.uri);
    if (thumb) { meta.thumb = thumb; saveThumb(up.id, thumb).catch(() => {}); }
  }
  return sendMessage(chatId, opts.caption || '', type, { meta, clientId: opts.clientId });
  } finally {
    await cleanupMarked();
  }
}

// Required by expo-router to silence "no default export" route warnings.
export default {};
