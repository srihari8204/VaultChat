-- 129 — record that a user accepted the terms, and which version.
--
-- AUDIT F10 (second half). There was no recorded terms or privacy acceptance
-- anywhere. A store review asks for one, but the reason to want it is simpler
-- than compliance: without a record, "they agreed" is an assertion about a
-- screen somebody may or may not have seen, and a change to the terms has no
-- way to ask anyone to re-accept.
--
-- TWO COLUMNS, NOT A TABLE. Only the CURRENT acceptance is operationally
-- interesting: the app needs to know whether this user has accepted the version
-- now in force. A full history would be an append-only table, and the moment
-- to build it is when someone actually needs to answer "what did they accept in
-- March" — which nobody does today.
--
-- The version is TEXT, not an integer. It is an opaque label chosen by whoever
-- publishes the terms (VAULTCHAT_TERMS_VERSION), so "2026-09" or "1.1" work as
-- well as "2". The server never compares versions for ordering — only for
-- equality — which is what keeps it opaque and therefore safe to change.
--
-- Both NULLABLE. Every existing account has accepted nothing, which is the
-- truth, and the app asks them on next launch. Backfilling a pretend acceptance
-- would defeat the point of keeping the record at all.

ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

COMMENT ON COLUMN users.terms_version IS
  'The VAULTCHAT_TERMS_VERSION label this user accepted. NULL = never accepted. Compared for equality only, never ordering.';
COMMENT ON COLUMN users.terms_accepted_at IS
  'When terms_version was accepted. Set together with it, by POST /user/terms.';
