// db/chatTypes.ts — row models for the op-sqlite local store (Task 3).
// These mirror the schema in db/database.ts exactly. Timestamps are epoch ms.

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
export type MessageKind = 'text' | 'image' | 'video' | 'audio' | 'file' | 'system';

export interface ChatRow {
  id: string;
  type: string | null;
  title: string | null;
  last_message_id: string | null;
  last_message_preview: string | null;
  last_message_at: number | null;
  unread_count: number;
  pinned: number;             // 0 | 1
  updated_at: number | null;
  data: string | null;        // full server ChatSummary JSON (for rich render)
}

export interface MessageRow {
  id: string;                 // client-generated UUID v4
  chat_id: string;
  sender_id: string | null;
  kind: MessageKind;
  body: string | null;        // decrypted plaintext — device-local only
  media_local_path: string | null;
  media_remote_key: string | null;
  created_at: number;
  server_ts: number | null;
  status: MessageStatus;
}

export interface ContactRow {
  id: string;
  display_name: string | null;
  avatar_local_path: string | null;
  last_seen: number | null;
  updated_at: number | null;
}

export interface OutboxRow {
  message_id: string;
  attempts: number;
  next_retry_at: number | null;
  created_at: number;
}
