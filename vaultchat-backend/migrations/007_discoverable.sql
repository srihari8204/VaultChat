-- VaultChat Day 5: contact discoverability toggle.
-- Idempotent — safe to re-run.
--
-- Default TRUE so existing users can be found when their friends import
-- their address book. Users can toggle off in Settings → Privacy
-- (Phase 5b polish).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT TRUE;

-- The existing /contacts/match query already filters with WHERE
-- discoverable = TRUE, so opt-out is instant once the user flips it.
