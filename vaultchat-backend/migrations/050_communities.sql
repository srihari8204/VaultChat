-- 050_communities.sql — WhatsApp-style Communities (umbrella over groups).
--
-- A community groups several "sub-group" chats under one name, with an
-- auto-created Announcements group (admins-only posting) every member sees.
-- Membership in a community is derived from membership in any of its chats.

CREATE TABLE IF NOT EXISTS communities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  description TEXT,
  photo_url   TEXT,
  created_by  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Link a group chat to its community + flag the announcement group.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS community_id    UUID REFERENCES communities(id) ON DELETE SET NULL;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_announcement BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_chats_community ON chats(community_id);
