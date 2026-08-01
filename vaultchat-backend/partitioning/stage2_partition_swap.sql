-- stage2_partition_swap.sql — convert messages to RANGE(id) partitions (P4.1).
-- NOT an auto-run migration. Prerequisites (see PARTITION_RUNBOOK.md):
--   * stage1 applied AND the Go insert path moved to message_client_ids
--     AND ux_messages_client_dedup dropped (no unique index without `id` may
--     remain on messages, or step 2 below fails by design).
--   * Maintenance window: step 4 copies the whole table.
--   * Tested against a restored copy of production first.
--
-- Tune :span before running (rows per partition).
--   \set span 10000000

BEGIN;

-- 1. Move the live table aside (instant, takes an ACCESS EXCLUSIVE lock).
ALTER TABLE messages RENAME TO messages_old;
ALTER INDEX IF EXISTS idx_messages_chat_id_desc RENAME TO old_idx_messages_chat_id_desc;
ALTER INDEX IF EXISTS idx_messages_expires_at   RENAME TO old_idx_messages_expires_at;
ALTER INDEX IF EXISTS idx_messages_edited_at    RENAME TO old_idx_messages_edited_at;
ALTER INDEX IF EXISTS idx_messages_deleted_at   RENAME TO old_idx_messages_deleted_at;

-- 2. Recreate as a partitioned table — identical columns, PK (id) is legal
--    because id IS the partition key. LIKE copies defaults (incl. the
--    sequence-backed id default) but not constraints/indexes.
CREATE TABLE messages (
  LIKE messages_old INCLUDING DEFAULTS,
  PRIMARY KEY (id)
) PARTITION BY RANGE (id);

-- 3. Partitions covering the existing span + headroom, plus a DEFAULT
--    safety net (rows never silently fail to route).
DO $$
DECLARE
  maxid  BIGINT;
  span   BIGINT := 10000000;           -- keep in sync with :span
  lo     BIGINT := 0;
BEGIN
  SELECT COALESCE(MAX(id), 0) INTO maxid FROM messages_old;
  WHILE lo <= maxid + span LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS messages_p%s PARTITION OF messages FOR VALUES FROM (%s) TO (%s)',
      lo / span, lo, lo + span);
    lo := lo + span;
  END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS messages_pdefault PARTITION OF messages DEFAULT;

-- 4. THE COPY (the maintenance window — ~1-5 min/GB).
INSERT INTO messages SELECT * FROM messages_old;

-- 5. Indexes (partitioned; built per-partition), sequence, FKs, RLS.
CREATE INDEX idx_messages_chat_id_desc ON messages (chat_id, id DESC);
CREATE INDEX idx_messages_expires_at   ON messages (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_messages_edited_at    ON messages (edited_at)  WHERE edited_at  IS NOT NULL;
CREATE INDEX idx_messages_deleted_at   ON messages (deleted_at) WHERE deleted_at IS NOT NULL;
-- (Re-check migrations 013/019/055+ for any additional partial indexes added
--  since this file was written, and recreate them here the same way.)

-- Re-point the id sequence at the new table and re-add the self-FK.
ALTER SEQUENCE messages_id_seq OWNED BY messages.id;
ALTER TABLE messages
  ADD CONSTRAINT messages_reply_to_id_fkey FOREIGN KEY (reply_to_id)
  REFERENCES messages(id) ON DELETE SET NULL;

-- Inbound FKs: drop from the old table, recreate against the new one.
ALTER TABLE chats              DROP CONSTRAINT IF EXISTS chats_last_message_id_fkey;
ALTER TABLE chats              ADD  CONSTRAINT chats_last_message_id_fkey
  FOREIGN KEY (last_message_id) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE reactions          DROP CONSTRAINT IF EXISTS reactions_message_id_fkey;
ALTER TABLE reactions          ADD  CONSTRAINT reactions_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE bookmarks          DROP CONSTRAINT IF EXISTS bookmarks_message_id_fkey;
ALTER TABLE bookmarks          ADD  CONSTRAINT bookmarks_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_reply_to_id_fkey;
ALTER TABLE scheduled_messages ADD  CONSTRAINT scheduled_messages_reply_to_id_fkey
  FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_message_id_fkey;
ALTER TABLE scheduled_messages ADD  CONSTRAINT scheduled_messages_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL;
-- (Check \d messages_old for the polls FK name and any later additions.)

-- RLS does not follow a rename — re-apply 004's policies to the new table.
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_select ON messages FOR SELECT USING (vc_is_chat_member(chat_id));
-- (Copy the INSERT/UPDATE/DELETE policies verbatim from 004_rls.sql here.)

ANALYZE messages;

COMMIT;

-- 6. Verify (counts match, app reads/writes fine), then, hours/days later:
--    DROP TABLE messages_old;

-- ── Steady state: auto-create the next partition before the head hits the
--    ceiling. Call hourly from the Go jobs ticker.
CREATE OR REPLACE FUNCTION vc_ensure_message_partitions() RETURNS void AS $$
DECLARE
  span  BIGINT := 10000000;            -- keep in sync with :span
  head  BIGINT;
  next_lo BIGINT;
BEGIN
  SELECT COALESCE(MAX(id), 0) INTO head FROM messages;
  next_lo := ((head / span) + 1) * span;
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS messages_p%s PARTITION OF messages FOR VALUES FROM (%s) TO (%s)',
    next_lo / span, next_lo, next_lo + span);
END $$ LANGUAGE plpgsql;
