-- 055_message_client_id.sql
-- F7: client-generated idempotency key so a retried send (lost ack) cannot
-- create a duplicate message. The client sends a stable UUID `clientId`; the
-- POST /chats/:id/messages INSERT uses ON CONFLICT (chat_id, sender_id,
-- client_id) DO NOTHING against the partial unique index below.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id TEXT;

-- Partial unique index: only rows WITH a client_id are indexed, so the millions
-- of existing NULL rows (and any legacy/media send without a clientId) are never
-- in the index — no build conflict, no behaviour change for them.
--
-- NOTE (ops): this runs inside migrate.js's BEGIN/COMMIT and takes a write lock
-- on `messages` for the build duration. That is negligible here (the table is
-- small). On a LARGE hot table, DROP this statement from the file and build it
-- out-of-band instead (cannot run inside a transaction):
--
--   CREATE UNIQUE INDEX CONCURRENTLY ux_messages_client_dedup
--     ON messages (chat_id, sender_id, client_id) WHERE client_id IS NOT NULL;
--
-- then re-run migrate.js (the IF NOT EXISTS makes this file a no-op afterwards).
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_client_dedup
  ON messages (chat_id, sender_id, client_id)
  WHERE client_id IS NOT NULL;
