-- VaultChat Day 11: user_blocks + privacy settings columns.
-- Idempotent.

-- ── user_blocks ─────────────────────────────────────────────
-- A blocks B → B can't direct-message A and (server-side) any new direct
-- chat creation between them is rejected. Existing chats remain visible
-- but server-side will silently drop new messages from the blocked user
-- to the blocker (no notification, no socket fan-out).
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

-- ── Privacy columns on users ────────────────────────────────
-- last_seen_visible: whether other users can see your last_seen timestamp.
-- read_receipts:     whether to send read receipts (still respect server tick state).
-- profile_photo_visible: whether your profile photo is included in /chats fan-out.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_visible      BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS read_receipts          BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS profile_photo_visible  BOOLEAN NOT NULL DEFAULT TRUE;
