-- Group admin controls (group-admin screen). Idempotent.
--
-- slow_mode_seconds: non-admins must wait this long between messages (0 = off).
-- send_policy: who may send — 'everyone' or 'admins'.
-- Both are enforced server-side in POST /chats/:id/messages.

ALTER TABLE chats ADD COLUMN IF NOT EXISTS slow_mode_seconds INT  NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS send_policy        TEXT NOT NULL DEFAULT 'everyone';
