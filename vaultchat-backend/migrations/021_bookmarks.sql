-- VaultChat: per-user saved messages ("Bookmarks").
-- Idempotent.
--
-- One row per (user, message). Note is an optional private annotation
-- (~280 chars, Twitter-sized). Bookmarks survive even if the original
-- message is later deleted or vanish-pruned — but a saved bookmark for
-- a deleted message renders as a "(message no longer available)" tombstone
-- because messages.id FK is ON DELETE CASCADE. If we want bookmarks to
-- outlive the source message, switch the FK to ON DELETE SET NULL +
-- snapshot the content into the bookmarks row. For MVP cascade is fine.

CREATE TABLE IF NOT EXISTS bookmarks (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  message_id  BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user_created
  ON bookmarks(user_id, created_at DESC);
