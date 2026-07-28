-- Group admin controls, part 2 (group-admin screen). Idempotent.
--
-- media_policy:        who may send media — 'everyone' | 'admins'
-- add_members_policy:  who may add members — 'everyone' | 'admins'
-- anti_spam_links:     auto-block links from members who joined < 24h ago
-- approve_members:     invite-link joins become pending requests an admin approves
-- All enforced server-side in routes/chats.js.

ALTER TABLE chats ADD COLUMN IF NOT EXISTS media_policy       TEXT    NOT NULL DEFAULT 'everyone';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS add_members_policy TEXT    NOT NULL DEFAULT 'admins';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS anti_spam_links    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS approve_members    BOOLEAN NOT NULL DEFAULT FALSE;

-- Pending join requests (when approve_members is on). Route-enforced; no RLS.
CREATE TABLE IF NOT EXISTS chat_join_requests (
  chat_id    UUID        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_join_requests_chat ON chat_join_requests(chat_id, created_at);
