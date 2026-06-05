-- VaultChat: Ghost Mode — per-contact privacy overrides.
-- Idempotent.
--
-- A user (owner) can hide specific signals from a specific target user.
-- One row per (owner_id, target_id) — flags within are per-signal. NULL
-- target_id is reserved for future "default for everyone" overrides.
--
-- Enforcement happens at the fan-out layer:
--   * presence_changed         skipped if hide_online    = TRUE
--   * typing_start/stop        skipped if hide_typing    = TRUE
--   * message_read             skipped if hide_read      = TRUE
--   * users.last_seen_at       blanked in GET /chats payloads when
--                              hide_last_seen = TRUE
--
-- A user's global privacy toggles (users.last_seen_visible etc.) still
-- apply globally. Ghost Mode is a per-target *additional* override.

CREATE TABLE IF NOT EXISTS ghost_mode (
  owner_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hide_online     BOOLEAN     NOT NULL DEFAULT FALSE,
  hide_typing     BOOLEAN     NOT NULL DEFAULT FALSE,
  hide_read       BOOLEAN     NOT NULL DEFAULT FALSE,
  hide_last_seen  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, target_id),
  CHECK (owner_id <> target_id)
);

CREATE INDEX IF NOT EXISTS idx_ghost_mode_owner  ON ghost_mode(owner_id);
CREATE INDEX IF NOT EXISTS idx_ghost_mode_target ON ghost_mode(target_id);

DROP TRIGGER IF EXISTS ghost_mode_set_updated_at ON ghost_mode;
CREATE TRIGGER ghost_mode_set_updated_at
  BEFORE UPDATE ON ghost_mode
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
