-- VaultChat: Stories (24-hour ephemeral posts).
-- Idempotent.
--
-- A story is a single image or video posted by a user that lives for 24h
-- and is visible to anyone they share an active chat with. Views are
-- tracked per-(story, viewer) so the author can see who watched.
--
-- Phase-3a scope (this migration):
--   * One attachment per story (image or video)
--   * Optional caption (≤ 200 chars)
--   * Server prunes rows where expires_at <= NOW() via the existing sweep
--     pattern in server.js
--   * Visibility: any user who shares at least one active chat_members
--     row with the author and isn't blocked by them
--
-- Out of scope (Phase-3b):
--   * Per-viewer unique encryption keys (spec marketing item — requires
--     the real E2EE work to land first)
--   * Story replies posting into chat
--   * Custom audience selection (allowlist / closeFriends)

CREATE TABLE IF NOT EXISTS stories (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attachment_id  UUID        NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  media_type     TEXT        NOT NULL CHECK (media_type IN ('image','video')),
  caption        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

-- Feed sort: latest first per author. Sweep filter: expires_at <= NOW.
CREATE INDEX IF NOT EXISTS idx_stories_user_created
  ON stories(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_expires
  ON stories(expires_at)
  WHERE expires_at IS NOT NULL;

-- Per-viewer tracking. Composite PK enforces one row per (story, viewer);
-- duplicate calls to POST /stories/:id/viewed are no-ops via
-- ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS story_views (
  story_id    BIGINT      NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (story_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS idx_story_views_viewer
  ON story_views(viewer_id);
