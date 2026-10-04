-- down/145_message_op_kind.sql — reverse 145_message_op_kind.sql.
-- Lives in down/ so scripts/check-migration-drift.js does not see a duplicate
-- version 145. Lossless: the column only ever held the routing tag, and the
-- ops themselves are untouched messages. Deploy the Go code WITHOUT the
-- op-index change first (its tagged send writes this column).
--
-- Run: psql -f migrations/down/145_message_op_kind.sql. Never against production.

DROP INDEX IF EXISTS idx_messages_op_kind;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_op_kind_chk;
ALTER TABLE messages DROP COLUMN IF EXISTS op_kind;
