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

import { MEDIA_E2EE, E2EE_ENABLED } from '../constants/flags';
import {
  sendMessage, uploadAttachment, isDirectChat, type Message,
} from './chatService';
import { uploadEncryptedAttachment, buildMediaContent } from './mediaAttachments';
import { storeSentCopy, saveThumb } from './mediaStore';
import { makeThumb } from './thumbnails';

export type MediaType = 'image' | 'video' | 'audio' | 'file';

export interface MediaFile { uri: string; filename: string; mime: string }
export interface SendMediaOpts {
  viewOnce?: boolean;
  caption?: string;
  /** Extra display meta merged in (width/height, durationMs, waveform, …). */
  metaExtra?: Record<string, any>;
}

/** Upload an attachment (encrypted in eligible direct chats) and send its message. */
export async function sendMediaMessage(
  chatId: string,
  type: MediaType,
  file: MediaFile,
  opts: SendMediaOpts = {},
): Promise<Message> {
  const encrypt = MEDIA_E2EE && E2EE_ENABLED && isDirectChat(chatId);

  if (encrypt) {
    const { attachmentId, mediaKey } = await uploadEncryptedAttachment(
      file.uri, file.filename, file.mime, { viewOnce: opts.viewOnce },
    );
    // The key + caption ride inside the content the Double Ratchet encrypts.
    const content = buildMediaContent(opts.caption || '', mediaKey);
    const meta: Record<string, any> = {
      attachmentId,
      mime: file.mime,            // real mime for rendering (upload was octet-stream)
      filename: file.filename,
      encrypted: true,
      ...(opts.viewOnce ? { viewOnce: true } : {}),
      ...(opts.metaExtra || {}),
    };
    return sendMessage(chatId, content, type, { meta });
  }

  // Plaintext path — unchanged from the original send sites.
  const up = await uploadAttachment(file.uri, file.filename, file.mime, { viewOnce: opts.viewOnce });
  const meta: Record<string, any> = {
    attachmentId: up.id,
    mime: up.mime,
    size: up.size,
    filename: up.filename,
    ...(opts.viewOnce ? { viewOnce: true } : {}),
    ...(opts.metaExtra || {}),
  };
  // Keep the sender's own file in the WhatsApp folder (Sent/) so the sender
  // NEVER re-downloads media they just sent. Skip for view-once (it's not
  // re-viewable). Best-effort — never blocks the send on failure.
  if (!opts.viewOnce) {
    const kind = type === 'audio' ? 'voice' : type;   // 'image' | 'video' | 'voice' | 'file'
    await storeSentCopy(up.id, file.uri, { kind, isMine: true, mime: file.mime, filename: file.filename });
    // Thumbnail (image/video only): embed in meta so the RECEIVER previews it
    // instantly without downloading the full file, and cache it in .Thumbs.
    if (type === 'image' || type === 'video') {
      const thumb = await makeThumb(file.uri, type);
      if (thumb) { meta.thumb = thumb; saveThumb(up.id, thumb).catch(() => {}); }
    }
  }
  return sendMessage(chatId, opts.caption || '', type, { meta });
}

// Required by expo-router to silence "no default export" route warnings.
export default {};
