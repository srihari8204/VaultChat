-- Broadcast Channels (broadcast screen) — Telegram-style one-to-many.
-- Idempotent. An admin creates a channel, subscribers read posts, only the
-- admin posts. Joining is by invite code. Access is enforced at the route
-- layer (routes/channels.js), so these tables don't carry RLS (same posture
-- as bookmarks / invite_links).

CREATE TABLE IF NOT EXISTS channels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  description   TEXT,
  admin_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code   TEXT        NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_post_at  TIMESTAMPTZ,
  last_post     TEXT
);

CREATE TABLE IF NOT EXISTS channel_subscribers (
  channel_id    UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_posts (
  id          BIGSERIAL PRIMARY KEY,
  channel_id  UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id   UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  text        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_subs_user    ON channel_subscribers(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_posts_channel ON channel_posts(channel_id, id DESC);
