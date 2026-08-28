-- 119_anon_chats.sql — a chat opened by code hides BOTH people until BOTH
-- choose to keep the other. Idempotent.
--
-- WHY
-- ---
-- Migration 118 let you start a chat with someone whose number you do not have.
-- But it still handed each side the other's real name and photo the moment the
-- code was redeemed — so "chat without exchanging details" only held for the
-- phone number. This closes that: a code chat shows no name and no photo at all
-- until the two people have each decided to keep the other.
--
-- MUTUAL, NOT ONE-SIDED, AND THAT IS THE WHOLE POINT
-- --------------------------------------------------
-- Revealing as soon as ONE side saves would publish that side's identity
-- without their agreement — A saves B, and now A sees B's real name while B is
-- still looking at a ghost. Disclosure has to be a handshake or it is not
-- consent. So the rule is: every active member must have saved, or nobody is
-- shown anything.
--
-- WHAT THIS IS NOT
-- ----------------
-- Not encryption, and not a secret. It hides a NAME and a PHOTO from a chat
-- payload. Anyone who already knows who they are talking to still knows. It
-- exists so a stranger met through a code does not get your identity thrown in
-- for free, not to make you unidentifiable to someone determined.

-- ── the chat is anonymous ─────────────────────────────────────────────
-- Set ONLY when redeeming a code CREATES the chat. If the two already had a
-- chat, they already know each other, and retroactively hiding a name they have
-- seen for months would be a bug rather than a privacy win — routes/chat_codes.go
-- only sets this when directChatEnsure reports the chat as new.
--
-- Default FALSE, so every chat that already exists is unaffected.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS anon BOOLEAN NOT NULL DEFAULT FALSE;

-- ── each side's decision to keep the other ────────────────────────────
-- Per (chat, user), because it is a per-person decision about one conversation,
-- and because chat_members is already the row every identity query joins.
--
-- The code's "Save this contact" option pre-sets this for the person who made
-- the code: choosing it up front IS the decision, so they should not have to
-- make it twice.
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS saved_peer BOOLEAN NOT NULL DEFAULT FALSE;

-- The reveal test is "does any ACTIVE member still have saved_peer = FALSE",
-- asked once per chat payload and once per call. This index is what keeps that
-- from being a scan of a chat's whole membership.
CREATE INDEX IF NOT EXISTS chat_members_unsaved_idx
  ON chat_members (chat_id)
  WHERE saved_peer = FALSE AND left_at IS NULL;

-- Anonymous chats are a small minority of rows, so a partial index is the right
-- shape for "is this chat anonymous" as well.
CREATE INDEX IF NOT EXISTS chats_anon_idx ON chats (id) WHERE anon = TRUE;
