-- 034_unread_count.sql — denormalized per-member unread counter.
--
-- Replaces the O(N) correlated COUNT(*) subquery in GET /chats (one count per
-- chat on every chat-list load) with a maintained column:
--   * +1 for every other active member when a message is inserted
--     (via the SECURITY DEFINER helper below — a cross-user write, same pattern
--      as vc_chat_member_ids() in 004_rls.sql),
--   * recomputed exactly when a member marks the chat read.
-- Idempotent — safe to re-run.

ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0;

-- Backfill from current state so existing chats show correct badges immediately.
UPDATE chat_members cm
   SET unread_count = (
     SELECT COUNT(*) FROM messages m
      WHERE m.chat_id = cm.chat_id
        AND m.id > COALESCE(cm.last_read_message_id, 0)
        AND m.sender_id <> cm.user_id
        AND m.deleted_at IS NULL
   )
 WHERE cm.left_at IS NULL;

-- System-internal cross-user write: bump unread for every active member of a
-- chat except the sender. SECURITY DEFINER so it bypasses RLS (the app role is
-- RLS-bound and can only touch its own chat_members row) — mirrors the
-- vc_chat_member_ids() helper used by the Socket.IO fan-out.
CREATE OR REPLACE FUNCTION vc_bump_unread(p_chat_id UUID, p_sender_id UUID)
RETURNS VOID AS $$
  UPDATE chat_members
     SET unread_count = unread_count + 1
   WHERE chat_id = p_chat_id
     AND user_id <> p_sender_id
     AND left_at IS NULL;
$$ LANGUAGE sql SECURITY DEFINER;
