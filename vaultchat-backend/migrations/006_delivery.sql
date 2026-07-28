-- VaultChat Day 4: per-user delivery state.
-- Idempotent — safe to re-run.
--
-- Adds last_delivered_message_id alongside the existing
-- last_read_message_id on chat_members. The chat-list UI uses this to
-- show tick states on outgoing messages (sent → delivered → read).
--
-- Per-USER, not per-device — 2-4x fewer rows for the same UX.
-- Per-device tracking is a Phase 4d polish when "read on Tablet" UI
-- becomes a requirement.

ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS last_delivered_message_id BIGINT;

-- The existing chat_members_update policy already covers self-edits of
-- last_read_message_id (`user_id = vc_current_user_id() OR vc_is_chat_admin(chat_id)`).
-- The same policy applies to last_delivered_message_id — no new policy needed.
