-- 145_message_op_kind.sql — a routing tag for group notes/tasks op messages.
--
-- NOT APPLIED ANYWHERE. Written 2026-10-04 (round 7, OPIDX); scratch-DB only.
--
-- Shared group notes and tasks are event logs carried as ordinary E2EE text
-- messages in the group thread (lib/groups/notes.ts, lib/groups/tasks.ts). The
-- server could not tell an op from chat text, so every visit to Notes or Tasks
-- paged back through up to 2,000 messages and decrypted each one to find the
-- ops. The app now sends `opKind` with a new op, the send handler stores it
-- here, and GET /chats/{id}/ops?kind= reads only those rows through the index.
--
-- METADATA TRADE-OFF (deliberate): this column tells the server THAT a message
-- is a notes op or a tasks op — so how often a group edits its notes or tasks,
-- and when. It reveals nothing of the content: the op itself (title, body,
-- assignee, due date, done, pinned, and even add/edit/delete) stays inside the
-- ciphertext. NULL for every other message and for ops sent before this.
--
-- Additive and instant: a nullable column with no default rewrites nothing, and
-- the CHECK is NOT VALID (new writes are checked; existing rows are all NULL).
-- The index build takes a SHARE lock on messages (blocks writes, not reads) for
-- one scan. On a large production `messages`, build it by hand first:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_op_kind
--     ON messages (chat_id, op_kind, id DESC) WHERE op_kind IS NOT NULL;
-- and the IF NOT EXISTS below then skips it (migrate.js runs each file in one
-- transaction, where CONCURRENTLY is not allowed). Reverse: down/145_...sql.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS op_kind TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_op_kind_chk') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_op_kind_chk
      CHECK (op_kind IN ('notes', 'tasks')) NOT VALID;
  END IF;
END $$;

-- Paging is by id (`before=` is a message id, newest first), as in the
-- message list, so the index orders by id rather than created_at.
CREATE INDEX IF NOT EXISTS idx_messages_op_kind
  ON messages (chat_id, op_kind, id DESC) WHERE op_kind IS NOT NULL;
