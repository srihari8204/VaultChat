-- 120_chat_expiry.sql — a code chat with a timer DELETES ITSELF, whole.
-- Idempotent.
--
-- WHY THIS IS NOT chats.disappearing_seconds
-- ------------------------------------------
-- disappearing_seconds (013) expires MESSAGES: each one vanishes N seconds
-- after it was sent, and the conversation itself lives on — the thread, the
-- membership, the history of having talked, all still there.
--
-- The code options mean something stronger. "1 hour" is meant to be: in an
-- hour, this conversation and everything in it is gone, and if the two of you
-- want to talk again somebody has to issue a NEW code. That is a property of
-- the CHAT, not of each message, so it needs its own column and its own reaper.
--
-- WHAT "EVERYTHING" MEANS
-- ----------------------
-- 27 tables reference chats(id) ON DELETE CASCADE — messages, members, bodies,
-- reactions, receipts, pins, bookmarks, call rows. So deleting the chats row
-- deletes the conversation entirely, in one statement, with no orphan sweep to
-- get wrong.
--
-- NULL MEANS FOREVER, AND THAT IS EVERY EXISTING ROW
-- --------------------------------------------------
-- The column is nullable with no default, so every chat that exists today gets
-- NULL and is untouchable by the reaper. "Until I delete" and "Save this
-- contact" also store NULL — the chat lasts until somebody deletes it, which is
-- exactly what an ordinary chat already does.
--
-- The reaper's predicate is `expires_at IS NOT NULL AND expires_at <= now()`.
-- A bug that dropped the NOT NULL test would delete every chat on the box, so
-- it is written once, in jobs.go, and covered by a test that asserts a NULL row
-- survives.

ALTER TABLE chats ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- The reaper runs every few minutes and must not scan the whole table to find
-- the handful of chats that are dying. Partial, because rows with a timer are a
-- tiny minority and always will be.
CREATE INDEX IF NOT EXISTS chats_expires_idx
  ON chats (expires_at)
  WHERE expires_at IS NOT NULL;
