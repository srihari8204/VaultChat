-- VaultChat Phase 3a: chats / chat_members / messages.
-- Idempotent — safe to re-run.
--
-- Run with:
--   psql -h 127.0.0.1 -p 6432 -U vaultchat_app -d vaultchat -f migrations/002_chats.sql
--
-- Model:
--   * chats        — one row per conversation (direct = 2 members, group = up to MAX)
--   * chat_members — join row per (chat, user); tracks role, read pointer, mute
--   * messages     — opaque encrypted blob per message; server never decrypts
--
-- Server stores `content` as-is (whatever the client encrypted) — preserves
-- the existing double-ratchet E2EE. Multi-device receive works by fanning
-- out the same blob to every connected socket of every chat member.

-- ── chats ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                 TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  name                 TEXT,
  photo_url            TEXT,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  last_message_id      BIGINT,                     -- denormalized for sort
  last_message_at      TIMESTAMPTZ,                -- denormalized for sort
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chats_last_message_at ON chats(last_message_at DESC) WHERE last_message_at IS NOT NULL;

DROP TRIGGER IF EXISTS chats_set_updated_at ON chats;
CREATE TRIGGER chats_set_updated_at
  BEFORE UPDATE ON chats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── chat_members ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id               UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
  joined_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_read_message_id  BIGINT,
  muted                 BOOLEAN NOT NULL DEFAULT FALSE,
  -- Soft leave: when a user leaves a group, keep the row so backfill still
  -- works for them; just set left_at. NULL = still a member.
  left_at               TIMESTAMPTZ,
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_members_user        ON chat_members(user_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_members_chat_active ON chat_members(chat_id) WHERE left_at IS NULL;

-- ── messages ───────────────────────────────────────────────────────
-- `content` is opaque to the server (E2EE). Never inspect or index it.
-- `meta` (JSONB) is for non-encrypted metadata the client wants visible
-- to the server: e.g., reply target, mime type, file size, durations.
-- Keep `meta` PII-free.
CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  chat_id       UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','image','video','audio','file','location','system')),
  content       TEXT,                              -- opaque encrypted blob (NULL on soft-delete)
  meta          JSONB,                             -- non-PII metadata: reply target id, mime, size, etc.
  reply_to_id   BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  edited_at     TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary read pattern: latest-first within a chat, with keyset pagination on id.
CREATE INDEX IF NOT EXISTS idx_messages_chat_id_desc ON messages(chat_id, id DESC);

-- ── FK on chats.last_message_id (deferred so we could create messages first)
-- pg doesn't have deferrable FKs by default but we don't need that — chats
-- was created without the constraint; add it now via ALTER. Idempotent guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chats_last_message_id_fkey'
  ) THEN
    ALTER TABLE chats
      ADD CONSTRAINT chats_last_message_id_fkey
      FOREIGN KEY (last_message_id) REFERENCES messages(id) ON DELETE SET NULL;
  END IF;
END $$;
