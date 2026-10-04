// components/chats/chatPreview.ts — the second line of a Chats row, as text.
//
// Pure, so lib/chatPreviewPrivacy.selftest.ts can run it. ChatListRow renders
// what this returns and nothing else from the message.

import type { LastMessagePreview } from '../../lib/localDb';
import { isFamEvent } from '../../lib/family/alerts';
import { NOTE_PREFIX } from '../../lib/groups/notes';
import { TASK_PREFIX } from '../../lib/groups/tasks';

export type LastMsg = LastMessagePreview;

/** Shown instead of any text (preview or draft) of a locked chat. Same words as
 *  app/scheduled.tsx and app/bookmarks.tsx. */
export const LOCKED_PREVIEW = '🔒 Locked chat';
/** Shown instead of a view-once or Invisible Ink message's text (as bookmarks). */
export const PROTECTED_PREVIEW = '🔒 Protected message';

export function chatRowPreview({ lastMsg, hasLastMessage, meId, draft, locked }: {
  lastMsg?: LastMsg;
  /** The server says the chat has a last message (chat.lastMessageId). */
  hasLastMessage: boolean;
  meId?: string | null;
  draft?: string;
  /** The chat is locked, or the lock table could not be read. */
  locked?: boolean;
}): { draftText: string; preview: string } {
  // A locked chat shows neither its newest message nor your unsent draft.
  if (locked) return { draftText: '', preview: LOCKED_PREVIEW };
  const draftText = draft && draft.trim() ? draft.trim() : '';
  return { draftText, preview: draftText || previewBody(lastMsg, hasLastMessage, meId) };
}

/**
 * The receipt tick before your own newest message in a direct chat, or null.
 * A locked row shows none: sent / delivered / read is activity in the chat the
 * lock hides (same for "typing…", which ChatListRow drops for locked rows).
 */
export function chatRowTick({ lastMsg, meId, locked, draftText, direct, peerReadId, peerDeliveredId }: {
  lastMsg?: LastMsg; meId?: string | null; locked?: boolean; draftText: string; direct: boolean;
  peerReadId?: number | null; peerDeliveredId?: number | null;
}): 'sent' | 'delivered' | 'read' | null {
  if (locked || draftText || !direct || !lastMsg || !meId || lastMsg.senderId !== meId) return null;
  if ((peerReadId ?? 0) >= lastMsg.id) return 'read';
  return (peerDeliveredId ?? 0) >= lastMsg.id ? 'delivered' : 'sent';
}

function previewBody(lastMsg: LastMsg | undefined, hasLastMessage: boolean, meId?: string | null): string {
  if (!lastMsg) return hasLastMessage ? 'Tap to open chat' : 'No messages yet';
  // View-once / Invisible Ink: only the bubble may show the text. Checked
  // before `content` is read at all: lib/chatService.hydrateOwnPreviews fills
  // content for your OWN newest message from the own-plaintext store after
  // lib/localDb withheld it, and keeps this flag.
  const content = lastMsg.protected ? null : lastMsg.content;
  // famEvent envelopes are hidden from the thread, so they must not become a
  // row's "last message" TEXT either. This is a PREVIEW-ONLY fix: the row's
  // sort position and unread badge come from the server's chat.lastMessageAt/
  // unreadCount, which the server cannot correct for famEvent specifically —
  // it never sees plaintext content (E2EE), so it cannot tell a famEvent
  // system message apart from any other. A crossing can still bump a chat to
  // the top and mark it unread; opening it then shows nothing new. Accepted
  // trade-off, not silently swept: the alternative (client-side markRead up
  // to the famEvent's id) would also retroactively mark any REAL unread
  // message with a lower id as read, which is worse.
  // Group notes/tasks ops are hidden from the thread for the same reason.
  if (isFamEvent(lastMsg.type, content)
    || (typeof content === 'string' && (content.startsWith(NOTE_PREFIX) || content.startsWith(TASK_PREFIX)))) {
    return 'Tap to open chat';
  }
  const t = lastMsg.type;
  // content is null for a text message whose ciphertext couldn't be decrypted
  // (the cache layer withholds raw envelopes) — show a lock, never blank/JSON.
  const textFallback = lastMsg.protected ? PROTECTED_PREVIEW
    : content || (hasLastMessage ? '🔒 Encrypted message' : '');
  const label = t === 'image' ? '📷 Photo'
    : t === 'video' ? '🎥 Video'
    : t === 'audio' ? '🎙️ Voice message'
    : t === 'file' ? '📎 File'
    : t === 'vaultbeam' ? '📦 File'
    : t === 'location' ? '📍 Location'
    : t === 'poll' ? '📊 Poll'
    : t === 'sticker' ? 'Sticker'
    : textFallback;
  const mine = !!meId && lastMsg.senderId === meId;
  return (mine ? 'You: ' : '') + label;
}
