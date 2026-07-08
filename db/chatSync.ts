// db/chatSync.ts — bridge server API shapes → op-sqlite repos (Task 3).
//
// The screens render from the repos immediately; these functions run in the
// BACKGROUND after a network fetch and merge fresh server data in, so the UI
// re-renders reactively without ever awaiting the network to paint.

import chatRepo from './chatRepo';
import contactRepo from './contactRepo';
import messageRepo from './messageRepo';
import type { ChatSummary } from '../lib/chatService';
import type { MessageKind, MessageStatus } from './chatTypes';

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Merge one server chat summary (identity + last-activity + presence). */
export function syncChatSummary(c: ChatSummary): void {
  chatRepo.upsert({
    id: c.id,
    type: c.type,
    title: c.type === 'direct' ? (c.peerName ?? c.name) : c.name,
    pinned: c.pinned ? 1 : 0,
    data: JSON.stringify(c),   // full summary for rich list render
  });
  chatRepo.setServerMeta(c.id, {
    lastMessageId: c.lastMessageId != null ? String(c.lastMessageId) : null,
    lastMessageAt: toMs(c.lastMessageAt),
    unreadCount: c.unreadCount,
  });
  if (c.type === 'direct' && c.peerUserId) {
    contactRepo.upsert({
      id: c.peerUserId,
      display_name: c.peerName ?? null,
      avatar_local_path: null,
      last_seen: c.peerOnline ? Date.now() : toMs(c.peerLastSeenAt),
    });
  }
}

export function syncChatList(list: ChatSummary[]): void {
  for (const c of list) syncChatSummary(c);
}

// ── Message merge ───────────────────────────────────────────────────
// A minimal server-message shape (the app's Message has many fields; we only
// need these to populate the local store). `body` is the DECRYPTED plaintext —
// callers decrypt before handing it here, so the store never holds ciphertext.
export interface ServerMessageLite {
  id: string | number;
  chatId: string;
  senderId?: string | null;
  type?: string | null;
  body?: string | null;          // decrypted plaintext
  createdAt?: string | null;     // ISO
  mediaRemoteKey?: string | null;
  status?: MessageStatus;
}

export function syncMessage(m: ServerMessageLite, opts: { bumpUnread?: boolean } = {}): void {
  const id = String(m.id);
  const createdAt = toMs(m.createdAt) ?? Date.now();
  messageRepo.upsertFromServer({
    id,
    chat_id: m.chatId,
    sender_id: m.senderId ?? null,
    kind: (m.type as MessageKind) ?? 'text',
    body: m.body ?? null,
    media_remote_key: m.mediaRemoteKey ?? null,
    created_at: createdAt,
    server_ts: createdAt,
    status: m.status ?? 'delivered',
  });
  // Keep the chat-list preview + activity time fresh from the newest message.
  const preview = m.body ?? previewForKind((m.type as MessageKind) ?? 'text');
  chatRepo.touchLastMessage(m.chatId, id, preview, createdAt, !!opts.bumpUnread);
}

export function syncMessages(list: ServerMessageLite[]): void {
  for (const m of list) syncMessage(m);
}

function previewForKind(kind: MessageKind): string {
  switch (kind) {
    case 'image': return '📷 Photo';
    case 'video': return '🎥 Video';
    case 'audio': return '🎙️ Voice message';
    case 'file':  return '📎 File';
    default:      return '';
  }
}

export default { syncChatSummary, syncChatList, syncMessage, syncMessages };
