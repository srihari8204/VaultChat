-- 056_drop_plaintext_reactions.sql
-- F4 cleanup: reactions are now E2EE reference-messages (type='reaction', with
-- {reactsTo, op, emoji} sealed inside the message content). The old relational
-- table stored the emoji in PLAINTEXT (server-readable) and its endpoints are
-- gone. Drop it. Any historical rows are unrecoverable plaintext leaks anyway
-- and are removed with the table.

DROP TABLE IF EXISTS message_reactions;
