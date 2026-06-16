-- VaultChat: group E2EE sender-key distribution transport (W5). Idempotent.
--
-- For group chats, each member encrypts messages with their own "sender key"
-- (a symmetric hash ratchet + signing key). To let other members decrypt, the
-- member ships a Sender Key Distribution Message (SKDM) to each other member.
-- The SKDM is itself encrypted with the pairwise Double Ratchet between the two
-- members, so what we store here is OPAQUE to the server.
--
-- One row per (chat, sender, recipient): the latest SKDM the sender has published
-- to that recipient. Rotation (membership change) overwrites via upsert. The
-- server only relays opaque blobs — it can never read group messages.

CREATE TABLE IF NOT EXISTS group_sender_keys (
  chat_id       UUID        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skdm          TEXT        NOT NULL,   -- pairwise-E2EE-encrypted distribution message (opaque)
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, sender_id, recipient_id)
);

-- Fast fetch of "all SKDMs addressed to me in this chat".
CREATE INDEX IF NOT EXISTS idx_group_sender_keys_recipient
  ON group_sender_keys(chat_id, recipient_id);
